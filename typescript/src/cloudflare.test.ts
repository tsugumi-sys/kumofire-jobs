import { describe, expect, it, vi } from "vitest";

import type {
	CloudflareQueue,
	D1Database,
	D1PreparedStatement,
	D1RunMeta,
	D1RunResult,
} from "./cloudflare";
import {
	createCloudflareQueueAdapter,
	createCloudflareRuntime,
	createD1StorageAdapter,
	createJobs,
	getReferenceSchemaSql,
	type JobRunMessage,
	requiredSchemaVersion,
} from "./index";

interface StoredDefinitionRow {
	id: string;
	name: string;
	handler: string;
	payload_template: string | null;
	default_options: string | null;
	created_at: string;
	updated_at: string;
}

interface StoredJobRunRow {
	id: string;
	job_id: string;
	job_schedule_id: string | null;
	job_name: string;
	status:
		| "scheduled"
		| "queued"
		| "running"
		| "succeeded"
		| "failed"
		| "canceled";
	dedupe_key: string | null;
	payload: string;
	attempt: number;
	max_attempts: number;
	next_run_at: string | null;
	created_at: string;
	updated_at: string;
	started_at: string | null;
	finished_at: string | null;
	last_error: string | null;
}

interface StoredJobScheduleRow {
	id: string;
	job_id: string;
	job_name: string;
	schedule_type: "once" | "interval" | "cron";
	schedule_expr: string;
	timezone: string | null;
	next_run_at: string | null;
	last_scheduled_at: string | null;
	enabled: number;
	payload: string;
	max_attempts: number;
	created_at: string;
	updated_at: string;
}

class FakeD1PreparedStatement implements D1PreparedStatement {
	private values: unknown[] = [];

	constructor(
		private readonly database: FakeD1Database,
		private readonly query: string,
	) {}

	bind(...values: unknown[]): D1PreparedStatement {
		this.values = values;
		return this;
	}

	first<T>(columnName?: string): Promise<T | null> {
		if (columnName) {
			throw new Error(
				`Column selection is not supported in tests: ${columnName}`,
			);
		}

		return Promise.resolve(this.database.first<T>(this.query, this.values));
	}

	run<T = Record<string, unknown>>(): Promise<D1RunResult<T>> {
		return Promise.resolve(this.database.run<T>(this.query, this.values));
	}

	all<T = Record<string, unknown>>(): Promise<D1RunResult<T>> {
		return Promise.resolve(this.database.allResult<T>(this.query, this.values));
	}

	raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
	raw<T = unknown[]>(options: {
		columnNames: true;
	}): Promise<[string[], ...T[]]>;
	raw<T = unknown[]>(options?: {
		columnNames?: boolean;
	}): Promise<T[] | [string[], ...T[]]> {
		if (options?.columnNames) {
			return Promise.resolve([[]] as [string[], ...T[]]);
		}

		return Promise.resolve([] as T[]);
	}
}

class FakeD1Database implements D1Database {
	private readonly definitions = new Map<string, StoredDefinitionRow>();
	private readonly definitionsByName = new Map<string, string>();
	private readonly schedules = new Map<string, StoredJobScheduleRow>();
	private readonly jobRuns = new Map<string, StoredJobRunRow>();
	private readonly locks = new Map<string, { leaseUntil: string }>();

	constructor(private readonly schemaVersion: number = requiredSchemaVersion) {}

	prepare(query: string): D1PreparedStatement {
		return new FakeD1PreparedStatement(this, query);
	}

	batch<T = unknown>(
		_statements: D1PreparedStatement[],
	): Promise<D1RunResult<T>[]> {
		return Promise.resolve([]);
	}

	exec(_query: string): Promise<{ count: number; duration: number }> {
		return Promise.resolve({ count: 0, duration: 0 });
	}

	withSession(): ReturnType<D1Database["withSession"]> {
		return this as unknown as ReturnType<D1Database["withSession"]>;
	}

	dump(): Promise<ArrayBuffer> {
		return Promise.resolve(new ArrayBuffer(0));
	}

	first<T>(query: string, values: unknown[]): T | null {
		const normalized = normalizeSql(query);

		if (normalized.startsWith("SELECT version FROM kumofire_schema_version")) {
			return { version: this.schemaVersion } as T;
		}

		if (
			normalized.includes("FROM kumofire_job_definitions WHERE id = ? LIMIT 1")
		) {
			const definitionId = values[0];
			if (typeof definitionId !== "string") {
				return null;
			}

			return (this.definitions.get(definitionId) ?? null) as T | null;
		}

		if (
			normalized.includes(
				"FROM kumofire_job_definitions WHERE name = ? LIMIT 1",
			)
		) {
			const jobName = values[0];
			if (typeof jobName !== "string") {
				return null;
			}

			const definitionId = this.definitionsByName.get(jobName);
			if (!definitionId) {
				return null;
			}

			return (this.definitions.get(definitionId) ?? null) as T | null;
		}

		if (normalized.includes("FROM kumofire_job_runs WHERE id = ? LIMIT 1")) {
			const jobRunId = values[0];
			if (typeof jobRunId !== "string") {
				return null;
			}

			return (this.jobRuns.get(jobRunId) ?? null) as T | null;
		}

		if (
			normalized.includes("FROM kumofire_job_schedules WHERE id = ? LIMIT 1")
		) {
			const scheduleId = values[0];
			if (typeof scheduleId !== "string") {
				return null;
			}

			return (this.schedules.get(scheduleId) ?? null) as T | null;
		}

		if (
			normalized.includes("FROM kumofire_job_runs WHERE dedupe_key = ? LIMIT 1")
		) {
			const dedupeKey = values[0];
			if (typeof dedupeKey !== "string") {
				return null;
			}

			for (const jobRun of this.jobRuns.values()) {
				if (jobRun.dedupe_key === dedupeKey) {
					return jobRun as T;
				}
			}

			return null;
		}

		throw new Error(`Unsupported first() query: ${normalized}`);
	}

	allRows<T>(query: string, values: unknown[]): T[] {
		const normalized = normalizeSql(query);
		const now = values[0];
		const limit = values[1];
		if (typeof now !== "string" || typeof limit !== "number") {
			throw new Error("Invalid dispatch query bindings");
		}

		if (
			normalized.includes("FROM kumofire_job_runs WHERE status = 'scheduled'")
		) {
			return [...this.jobRuns.values()]
				.filter(
					(jobRun) =>
						jobRun.status === "scheduled" &&
						jobRun.next_run_at !== null &&
						jobRun.next_run_at <= now,
				)
				.sort((left, right) => left.created_at.localeCompare(right.created_at))
				.slice(0, limit)
				.map((jobRun) => ({ ...jobRun }) as T);
		}

		if (normalized.includes("FROM kumofire_job_schedules WHERE enabled = 1")) {
			return [...this.schedules.values()]
				.filter(
					(schedule) =>
						schedule.enabled === 1 &&
						schedule.next_run_at !== null &&
						schedule.next_run_at <= now,
				)
				.sort((left, right) => {
					const nextRunOrder = (left.next_run_at ?? "").localeCompare(
						right.next_run_at ?? "",
					);
					return nextRunOrder !== 0
						? nextRunOrder
						: left.created_at.localeCompare(right.created_at);
				})
				.slice(0, limit)
				.map((schedule) => ({ ...schedule }) as T);
		}

		throw new Error(`Unsupported all() query: ${normalized}`);
	}

	allResult<T>(query: string, values: unknown[]): D1RunResult<T> {
		return {
			success: true,
			meta: createD1Meta(),
			results: this.allRows<T>(query, values),
		};
	}

	run<T = Record<string, unknown>>(
		query: string,
		values: unknown[],
	): D1RunResult<T> {
		const normalized = normalizeSql(query);

		if (normalized.startsWith("INSERT INTO kumofire_job_definitions")) {
			const [
				id,
				name,
				handler,
				payloadTemplate,
				defaultOptions,
				createdAt,
				updatedAt,
			] = values;

			if (this.definitions.has(String(id))) {
				return {
					success: true,
					meta: createD1Meta({ changes: 0 }),
					results: [],
				};
			}

			const row: StoredDefinitionRow = {
				id: String(id),
				name: String(name),
				handler: String(handler),
				payload_template: asNullableString(payloadTemplate),
				default_options: asNullableString(defaultOptions),
				created_at: String(createdAt),
				updated_at: String(updatedAt),
			};
			this.definitions.set(row.id, row);
			this.definitionsByName.set(row.name, row.id);
			return { success: true, meta: createD1Meta({ changes: 1 }), results: [] };
		}

		if (normalized.startsWith("INSERT INTO kumofire_job_runs")) {
			const [
				id,
				jobId,
				jobScheduleId,
				jobName,
				status,
				dedupeKey,
				payload,
				attempt,
				maxAttempts,
				nextRunAt,
				createdAt,
				updatedAt,
				startedAt,
				finishedAt,
				lastError,
			] = values;

			this.jobRuns.set(String(id), {
				id: String(id),
				job_id: String(jobId),
				job_schedule_id: asNullableString(jobScheduleId),
				job_name: String(jobName),
				status: status as StoredJobRunRow["status"],
				dedupe_key: asNullableString(dedupeKey),
				payload: String(payload),
				attempt: Number(attempt),
				max_attempts: Number(maxAttempts),
				next_run_at: asNullableString(nextRunAt),
				created_at: String(createdAt),
				updated_at: String(updatedAt),
				started_at: asNullableString(startedAt),
				finished_at: asNullableString(finishedAt),
				last_error: asNullableString(lastError),
			});

			return { success: true, meta: createD1Meta({ changes: 1 }), results: [] };
		}

		if (normalized.startsWith("INSERT INTO kumofire_job_schedules")) {
			const [
				id,
				jobId,
				jobName,
				scheduleType,
				scheduleExpr,
				timezone,
				nextRunAt,
				lastScheduledAt,
				enabled,
				payload,
				maxAttempts,
				createdAt,
				updatedAt,
			] = values;

			this.schedules.set(String(id), {
				id: String(id),
				job_id: String(jobId),
				job_name: String(jobName),
				schedule_type: scheduleType as StoredJobScheduleRow["schedule_type"],
				schedule_expr: String(scheduleExpr),
				timezone: asNullableString(timezone),
				next_run_at: asNullableString(nextRunAt),
				last_scheduled_at: asNullableString(lastScheduledAt),
				enabled: Number(enabled),
				payload: String(payload),
				max_attempts: Number(maxAttempts),
				created_at: String(createdAt),
				updated_at: String(updatedAt),
			});

			return { success: true, meta: createD1Meta({ changes: 1 }), results: [] };
		}

		if (normalized.startsWith("INSERT INTO kumofire_job_locks")) {
			const [jobRunId, leaseUntil, , now] = values;
			const existing = this.locks.get(String(jobRunId));

			if (existing && existing.leaseUntil > String(now)) {
				return {
					success: true,
					meta: createD1Meta({ changes: 0 }),
					results: [],
				};
			}

			this.locks.set(String(jobRunId), { leaseUntil: String(leaseUntil) });
			return { success: true, meta: createD1Meta({ changes: 1 }), results: [] };
		}

		if (normalized.startsWith("DELETE FROM kumofire_job_locks")) {
			this.locks.delete(String(values[0]));
			return { success: true, meta: createD1Meta({ changes: 1 }), results: [] };
		}

		if (normalized.includes("UPDATE kumofire_job_runs SET status = 'queued'")) {
			const [updatedAt, jobRunId] = values;
			const jobRun = this.jobRuns.get(String(jobRunId));
			if (!jobRun || jobRun.status !== "scheduled") {
				return {
					success: true,
					meta: createD1Meta({ changes: 0 }),
					results: [],
				};
			}

			jobRun.status = "queued";
			jobRun.updated_at = String(updatedAt);
			return { success: true, meta: createD1Meta({ changes: 1 }), results: [] };
		}

		if (
			normalized.includes("UPDATE kumofire_job_runs SET status = 'running'")
		) {
			const [startedAt, updatedAt, jobRunId] = values;
			const jobRun = this.jobRuns.get(String(jobRunId));
			if (!jobRun || jobRun.status !== "queued") {
				return {
					success: true,
					meta: createD1Meta({ changes: 0 }),
					results: [],
				};
			}

			jobRun.status = "running";
			jobRun.started_at = String(startedAt);
			jobRun.updated_at = String(updatedAt);
			return { success: true, meta: createD1Meta({ changes: 1 }), results: [] };
		}

		if (
			normalized.includes("UPDATE kumofire_job_runs SET status = 'succeeded'")
		) {
			const [finishedAt, updatedAt, jobRunId] = values;
			const jobRun = this.jobRuns.get(String(jobRunId));
			if (!jobRun || jobRun.status !== "running") {
				return {
					success: true,
					meta: createD1Meta({ changes: 0 }),
					results: [],
				};
			}

			jobRun.status = "succeeded";
			jobRun.finished_at = String(finishedAt);
			jobRun.updated_at = String(updatedAt);
			jobRun.last_error = null;
			return { success: true, meta: createD1Meta({ changes: 1 }), results: [] };
		}

		if (
			normalized.includes("UPDATE kumofire_job_runs SET status = 'scheduled'")
		) {
			const [nextRunAt, updatedAt, error, jobRunId] = values;
			const jobRun = this.jobRuns.get(String(jobRunId));
			if (!jobRun || jobRun.status !== "running") {
				return {
					success: true,
					meta: createD1Meta({ changes: 0 }),
					results: [],
				};
			}

			jobRun.status = "scheduled";
			jobRun.attempt += 1;
			jobRun.next_run_at = String(nextRunAt);
			jobRun.updated_at = String(updatedAt);
			jobRun.last_error = String(error);
			return { success: true, meta: createD1Meta({ changes: 1 }), results: [] };
		}

		if (normalized.includes("UPDATE kumofire_job_runs SET status = 'failed'")) {
			const [finishedAt, updatedAt, error, jobRunId] = values;
			const jobRun = this.jobRuns.get(String(jobRunId));
			if (
				!jobRun ||
				(jobRun.status !== "queued" && jobRun.status !== "running")
			) {
				return {
					success: true,
					meta: createD1Meta({ changes: 0 }),
					results: [],
				};
			}

			jobRun.status = "failed";
			jobRun.attempt += 1;
			jobRun.finished_at = String(finishedAt);
			jobRun.updated_at = String(updatedAt);
			jobRun.last_error = String(error);
			return { success: true, meta: createD1Meta({ changes: 1 }), results: [] };
		}

		if (
			normalized.includes(
				"UPDATE kumofire_job_schedules SET last_scheduled_at =",
			)
		) {
			const [
				lastScheduledAt,
				nextRunAt,
				updatedAt,
				scheduleId,
				expectedNextRunAt,
			] = values;
			const schedule = this.schedules.get(String(scheduleId));
			if (
				!schedule ||
				schedule.enabled !== 1 ||
				schedule.next_run_at !== String(expectedNextRunAt)
			) {
				return {
					success: true,
					meta: createD1Meta({ changes: 0 }),
					results: [],
				};
			}

			schedule.last_scheduled_at = String(lastScheduledAt);
			schedule.next_run_at = asNullableString(nextRunAt);
			schedule.updated_at = String(updatedAt);
			return { success: true, meta: createD1Meta({ changes: 1 }), results: [] };
		}

		throw new Error(`Unsupported run() query: ${normalized}`);
	}

	getDefinition(id: string): StoredDefinitionRow | null {
		const definition = this.definitions.get(id);
		return definition ? { ...definition } : null;
	}

	deleteDefinition(id: string): void {
		const definition = this.definitions.get(id);
		if (!definition) {
			return;
		}

		this.definitions.delete(id);
		this.definitionsByName.delete(definition.name);
	}

	getJobRun(id: string): StoredJobRunRow | null {
		const jobRun = this.jobRuns.get(id);
		return jobRun ? { ...jobRun } : null;
	}

	seedDefinition(definition: StoredDefinitionRow): void {
		this.definitions.set(definition.id, { ...definition });
		this.definitionsByName.set(definition.name, definition.id);
	}

	seedJobRun(jobRun: StoredJobRunRow): void {
		this.jobRuns.set(jobRun.id, { ...jobRun });
	}

	getJobSchedule(id: string): StoredJobScheduleRow | null {
		const schedule = this.schedules.get(id);
		return schedule ? { ...schedule } : null;
	}

	seedJobSchedule(schedule: StoredJobScheduleRow): void {
		this.schedules.set(schedule.id, { ...schedule });
	}

	seedLock(jobRunId: string, leaseUntil: string): void {
		this.locks.set(jobRunId, { leaseUntil });
	}
}

function normalizeSql(query: string): string {
	return query.replaceAll(/\s+/g, " ").trim();
}

function asNullableString(value: unknown): string | null {
	return value == null ? null : String(value);
}

function createD1Meta(overrides?: Partial<D1RunMeta>): D1RunMeta {
	return {
		duration: 0,
		size_after: 0,
		rows_read: 0,
		rows_written: 0,
		last_row_id: 0,
		changed_db: false,
		changes: 0,
		...overrides,
	};
}

function createQueueBinding<TMessage>(
	send: (message: TMessage) => Promise<void>,
): CloudflareQueue<TMessage> {
	return {
		send,
		async sendBatch(messages) {
			for (const message of messages) {
				await send(message.body);
			}
		},
	};
}

function createAckableMessage(body: unknown) {
	return {
		body,
		acked: false,
		retried: false,
		ack() {
			this.acked = true;
		},
		retry() {
			this.retried = true;
		},
	};
}

describe("cloudflare adapters", () => {
	it("exports reference schema SQL", () => {
		const sql = getReferenceSchemaSql();

		expect(sql).toContain(
			"CREATE TABLE IF NOT EXISTS kumofire_job_definitions",
		);
		expect(sql).toContain("CREATE TABLE IF NOT EXISTS kumofire_job_runs");
		expect(sql).toContain("CREATE TABLE IF NOT EXISTS kumofire_job_schedules");
		expect(sql).toContain("CREATE TABLE IF NOT EXISTS kumofire_job_locks");
		expect(sql).toContain("CREATE TABLE IF NOT EXISTS kumofire_schema_version");
		expect(sql).toContain("INSERT INTO kumofire_schema_version");
	});

	it("stores synchronized definitions in D1", async () => {
		const db = new FakeD1Database();
		const jobs = createJobs({
			storage: createD1StorageAdapter({ db }),
			queue: createCloudflareQueueAdapter(createQueueBinding(async () => {})),
			handlers: {
				email: () => {},
			},
		});

		await jobs.create({
			name: "email",
			payload: { to: "user@example.com" },
		});

		expect(db.getDefinition("email")).toMatchObject({
			id: "email",
			name: "email",
			handler: "email",
		});
	});

	it("runs the lifecycle against the D1 storage adapter", async () => {
		const now = new Date("2026-03-25T00:00:00.000Z");
		const db = new FakeD1Database();
		const queueMessages: JobRunMessage[] = [];
		const jobs = createJobs({
			storage: createD1StorageAdapter({ db }),
			queue: createCloudflareQueueAdapter(
				createQueueBinding(async (message) => {
					queueMessages.push(message);
				}),
			),
			now: () => now,
			handlers: {
				email: () => {},
			},
		});

		const { kumofireJobRunId } = await jobs.create({
			name: "email",
			payload: { to: "user@example.com" },
		});

		expect(queueMessages).toEqual([{ version: 1, kumofireJobRunId }]);
		expect(db.getJobRun(kumofireJobRunId)).toMatchObject({
			id: kumofireJobRunId,
			job_id: "email",
			job_name: "email",
			status: "queued",
		});

		const message = queueMessages[0];
		if (!message) {
			throw new Error("expected a queue message");
		}
		await expect(jobs.consume(message)).resolves.toEqual({
			outcome: "succeeded",
			jobRunId: kumofireJobRunId,
		});
		await expect(jobs.getStatus(kumofireJobRunId)).resolves.toMatchObject({
			status: "succeeded",
			attempt: 0,
		});
	});

	it("returns the existing run when the dedupe key matches", async () => {
		const now = new Date("2026-03-25T00:00:00.000Z");
		const db = new FakeD1Database();
		const queueMessages: JobRunMessage[] = [];
		const jobs = createJobs({
			storage: createD1StorageAdapter({ db }),
			queue: createCloudflareQueueAdapter(
				createQueueBinding(async (message) => {
					queueMessages.push(message);
				}),
			),
			now: () => now,
			handlers: {
				email: () => {},
			},
		});

		const first = await jobs.create({
			name: "email",
			payload: { to: "user@example.com" },
			dedupeKey: "send:123",
		});
		const second = await jobs.create({
			name: "email",
			payload: { to: "other@example.com" },
			dedupeKey: "send:123",
		});

		expect(second).toEqual(first);
		expect(queueMessages).toHaveLength(1);
	});

	it("ignores consume when a lease is already held", async () => {
		const now = new Date("2026-03-25T00:00:00.000Z");
		const db = new FakeD1Database();
		const queueMessages: JobRunMessage[] = [];
		const jobs = createJobs({
			storage: createD1StorageAdapter({ db }),
			queue: createCloudflareQueueAdapter(
				createQueueBinding(async (message) => {
					queueMessages.push(message);
				}),
			),
			now: () => now,
			handlers: {
				email: () => {},
			},
		});

		const { kumofireJobRunId } = await jobs.create({
			name: "email",
			payload: { to: "user@example.com" },
		});
		db.seedLock(kumofireJobRunId, "2026-03-25T00:10:00.000Z");

		const message = queueMessages[0];
		if (!message) {
			throw new Error("expected a queue message");
		}

		await expect(jobs.consume(message)).resolves.toEqual({
			outcome: "ignored",
			jobRunId: kumofireJobRunId,
		});
		await expect(jobs.getStatus(kumofireJobRunId)).resolves.toMatchObject({
			status: "queued",
			attempt: 0,
		});
	});

	it("ignores duplicate consume after the first execution succeeds", async () => {
		const now = new Date("2026-03-25T00:00:00.000Z");
		const db = new FakeD1Database();
		const queueMessages: JobRunMessage[] = [];
		const jobs = createJobs({
			storage: createD1StorageAdapter({ db }),
			queue: createCloudflareQueueAdapter(
				createQueueBinding(async (message) => {
					queueMessages.push(message);
				}),
			),
			now: () => now,
			handlers: {
				email: () => {},
			},
		});

		const { kumofireJobRunId } = await jobs.create({
			name: "email",
			payload: { to: "user@example.com" },
		});
		const message = queueMessages[0];
		if (!message) {
			throw new Error("expected a queue message");
		}

		await expect(jobs.consume(message)).resolves.toEqual({
			outcome: "succeeded",
			jobRunId: kumofireJobRunId,
		});
		await expect(jobs.consume(message)).resolves.toEqual({
			outcome: "ignored",
			jobRunId: kumofireJobRunId,
		});
	});

	it("reschedules retryable failures with the next run time", async () => {
		let now = new Date("2026-03-25T00:00:00.000Z");
		const db = new FakeD1Database();
		const queueMessages: JobRunMessage[] = [];
		let shouldFail = true;
		const jobs = createJobs({
			storage: createD1StorageAdapter({ db }),
			queue: createCloudflareQueueAdapter(
				createQueueBinding(async (message) => {
					queueMessages.push(message);
				}),
			),
			now: () => now,
			retry: {
				maxAttempts: 3,
				getNextRunAt: ({ now: currentNow }) =>
					new Date(currentNow.getTime() + 15_000),
			},
			handlers: {
				email: () => {
					if (shouldFail) {
						shouldFail = false;
						throw new Error("temporary failure");
					}
				},
			},
		});

		const { kumofireJobRunId } = await jobs.create({
			name: "email",
			payload: { to: "user@example.com" },
		});
		const message = queueMessages[0];
		if (!message) {
			throw new Error("expected a queue message");
		}

		await expect(jobs.consume(message)).resolves.toEqual({
			outcome: "retried",
			jobRunId: kumofireJobRunId,
		});
		await expect(jobs.getStatus(kumofireJobRunId)).resolves.toMatchObject({
			status: "scheduled",
			attempt: 1,
			lastError: "temporary failure",
			scheduledFor: "2026-03-25T00:00:15.000Z",
		});

		now = new Date("2026-03-25T00:00:15.000Z");
		await expect(jobs.dispatch()).resolves.toEqual({ dispatched: 1 });
		expect(queueMessages).toEqual([
			{ version: 1, kumofireJobRunId },
			{ version: 1, kumofireJobRunId },
		]);
	});

	it("materializes cron schedules through the D1 storage adapter", async () => {
		let now = new Date("2026-03-25T00:00:00.000Z");
		const db = new FakeD1Database();
		const queueMessages: JobRunMessage[] = [];
		const jobs = createJobs({
			storage: createD1StorageAdapter({ db }),
			queue: createCloudflareQueueAdapter(
				createQueueBinding(async (message) => {
					queueMessages.push(message);
				}),
			),
			now: () => now,
			handlers: {
				report: () => {},
			},
		});

		const { scheduleId } = await jobs.createSchedule({
			name: "report",
			payload: { reportId: "weekly" },
			scheduleType: "cron",
			scheduleExpr: "*/5 * * * *",
		});

		expect(db.getJobSchedule(scheduleId)).toMatchObject({
			id: scheduleId,
			job_id: "report",
			job_name: "report",
			schedule_type: "cron",
			schedule_expr: "*/5 * * * *",
		});

		now = new Date("2026-03-25T00:05:00.000Z");
		await expect(jobs.dispatch()).resolves.toEqual({ dispatched: 1 });
		expect(queueMessages).toEqual([
			{ version: 1, kumofireJobRunId: expect.any(String) },
		]);
		const firstRunId = queueMessages[0]?.kumofireJobRunId;
		if (!firstRunId) {
			throw new Error("expected a queue message");
		}

		expect(db.getJobRun(firstRunId)).toMatchObject({
			id: firstRunId,
			job_id: "report",
			job_schedule_id: scheduleId,
			job_name: "report",
			status: "queued",
			next_run_at: "2026-03-25T00:05:00.000Z",
		});
	});

	it("surfaces malformed stored payload rows from D1", async () => {
		const db = new FakeD1Database();
		db.seedDefinition({
			id: "email",
			name: "email",
			handler: "email",
			payload_template: null,
			default_options: null,
			created_at: "1970-01-01T00:00:00.000Z",
			updated_at: "1970-01-01T00:00:00.000Z",
		});
		db.seedJobRun({
			id: "job_run_1",
			job_id: "email",
			job_schedule_id: null,
			job_name: "email",
			status: "queued",
			dedupe_key: null,
			payload: "{invalid-json",
			attempt: 0,
			max_attempts: 3,
			next_run_at: "2026-03-25T00:00:00.000Z",
			created_at: "2026-03-25T00:00:00.000Z",
			updated_at: "2026-03-25T00:00:00.000Z",
			started_at: null,
			finished_at: null,
			last_error: null,
		});
		const storage = createD1StorageAdapter({ db });

		await expect(storage.getRun("job_run_1")).rejects.toThrow();
	});

	it("generates unique run ids across fresh D1 adapter instances", async () => {
		const db = new FakeD1Database();
		const randomUuid = vi
			.spyOn(globalThis.crypto, "randomUUID")
			.mockReturnValueOnce("00000000-0000-4000-8000-000000000001")
			.mockReturnValueOnce("00000000-0000-4000-8000-000000000002");
		const firstStorage = createD1StorageAdapter({ db });
		const secondStorage = createD1StorageAdapter({ db });

		try {
			const firstRun = await firstStorage.createRun({
				jobId: "email",
				jobName: "email",
				status: "scheduled",
				payload: { to: "one@example.com" },
				attempt: 0,
				maxAttempts: 3,
				scheduledFor: "2026-03-25T00:00:00.000Z",
				createdAt: "2026-03-25T00:00:00.000Z",
				updatedAt: "2026-03-25T00:00:00.000Z",
				startedAt: null,
				finishedAt: null,
				lastError: null,
			});
			const secondRun = await secondStorage.createRun({
				jobId: "email",
				jobName: "email",
				status: "scheduled",
				payload: { to: "two@example.com" },
				attempt: 0,
				maxAttempts: 3,
				scheduledFor: "2026-03-25T00:00:01.000Z",
				createdAt: "2026-03-25T00:00:01.000Z",
				updatedAt: "2026-03-25T00:00:01.000Z",
				startedAt: null,
				finishedAt: null,
				lastError: null,
			});

			expect(firstRun.id).toBe("00000000-0000-4000-8000-000000000001");
			expect(secondRun.id).toBe("00000000-0000-4000-8000-000000000002");
		} finally {
			randomUuid.mockRestore();
		}
	});

	it("falls back to in-memory definitions when the D1 definition row is missing", async () => {
		const now = new Date("2026-03-25T00:00:00.000Z");
		const db = new FakeD1Database();
		const queueMessages: JobRunMessage[] = [];
		const jobs = createJobs({
			storage: createD1StorageAdapter({ db }),
			queue: createCloudflareQueueAdapter(
				createQueueBinding(async (message) => {
					queueMessages.push(message);
				}),
			),
			now: () => now,
			handlers: {
				email: () => {},
			},
		});

		const { kumofireJobRunId } = await jobs.create({
			name: "email",
			payload: { to: "user@example.com" },
		});
		db.deleteDefinition("email");

		const message = queueMessages[0];
		if (!message) {
			throw new Error("expected a queue message");
		}

		await expect(jobs.consume(message)).resolves.toEqual({
			outcome: "succeeded",
			jobRunId: kumofireJobRunId,
		});
	});

	it("fails fast when the D1 schema version is too old", async () => {
		const db = new FakeD1Database(0);
		const jobs = createJobs({
			storage: createD1StorageAdapter({ db }),
			queue: createCloudflareQueueAdapter(createQueueBinding(async () => {})),
			handlers: {
				email: () => {},
			},
		});

		await expect(
			jobs.create({
				name: "email",
				payload: { to: "user@example.com" },
			}),
		).rejects.toThrow(
			"Schema version 0 does not satisfy required version 2. Apply Kumofire Jobs migrations.",
		);
	});
});

describe("cloudflare runtime", () => {
	it("dispatches scheduled runs through explicit db and queue bindings", async () => {
		let now = new Date("2026-03-25T00:00:00.000Z");
		const db = new FakeD1Database();
		const queueMessages: JobRunMessage[] = [];
		const runtime = createCloudflareRuntime({
			now: () => now,
			handlers: {
				email: () => {},
			},
		});
		const resources = {
			db,
			queue: createQueueBinding(async (message: JobRunMessage) => {
				queueMessages.push(message);
			}),
		};

		const jobs = runtime.bind(resources);
		const { kumofireJobRunId } = await jobs.create({
			name: "email",
			payload: { to: "user@example.com" },
			runAt: new Date("2026-03-25T00:05:00.000Z"),
		});

		expect(queueMessages).toEqual([]);
		now = new Date("2026-03-25T00:05:00.000Z");
		await expect(runtime.dispatchScheduled(resources)).resolves.toEqual({
			dispatched: 1,
		});
		expect(queueMessages).toEqual([{ version: 1, kumofireJobRunId }]);
	});

	it("dispatches materialized cron schedules through explicit db and queue bindings", async () => {
		let now = new Date("2026-03-25T00:00:00.000Z");
		const db = new FakeD1Database();
		const queueMessages: JobRunMessage[] = [];
		const runtime = createCloudflareRuntime({
			now: () => now,
			handlers: {
				report: () => {},
			},
		});
		const resources = {
			db,
			queue: createQueueBinding(async (message: JobRunMessage) => {
				queueMessages.push(message);
			}),
		};

		const jobs = runtime.bind(resources);
		await jobs.createSchedule({
			name: "report",
			payload: { reportId: "weekly" },
			scheduleType: "cron",
			scheduleExpr: "*/5 * * * *",
		});

		now = new Date("2026-03-25T00:05:00.000Z");
		await expect(runtime.dispatchScheduled(resources)).resolves.toEqual({
			dispatched: 1,
		});
		expect(queueMessages).toHaveLength(1);
	});

	it("stays decoupled from Worker env shape", async () => {
		const now = new Date("2026-03-25T00:00:00.000Z");
		const db = new FakeD1Database();
		const queueMessages: JobRunMessage[] = [];
		const runtime = createCloudflareRuntime({
			now: () => now,
			handlers: {
				email: () => {},
			},
		});
		const workerEnv = {
			JOBS_DB: db,
			JOBS_QUEUE: {
				send: async (message: JobRunMessage) => {
					queueMessages.push(message);
				},
			},
		};
		const resources = {
			db: workerEnv.JOBS_DB,
			queue: createQueueBinding(workerEnv.JOBS_QUEUE.send),
		};

		const jobs = runtime.bind(resources);
		const { kumofireJobRunId } = await jobs.create({
			name: "email",
			payload: { to: "user@example.com" },
		});

		expect(queueMessages).toEqual([{ version: 1, kumofireJobRunId }]);
		await expect(jobs.getStatus(kumofireJobRunId)).resolves.toMatchObject({
			id: kumofireJobRunId,
			status: "queued",
		});
	});

	it("acks valid messages and retries runtime failures during batch consume", async () => {
		const now = new Date("2026-03-25T00:00:00.000Z");
		const db = new FakeD1Database();
		const runtime = createCloudflareRuntime({
			now: () => now,
			handlers: {
				email: () => {},
			},
		});
		const resources = {
			db,
			queue: createQueueBinding(async () => {}),
		};
		const jobs = runtime.bind(resources);
		const { kumofireJobRunId } = await jobs.create({
			name: "email",
			payload: { to: "user@example.com" },
		});

		const validMessage = createAckableMessage({
			version: 1,
			kumofireJobRunId,
		});
		const malformedMessage = createAckableMessage({
			version: 2,
			kumofireJobRunId: 1,
		});
		const retryMessage = createAckableMessage({
			version: 1,
			kumofireJobRunId: "missing",
		});
		const brokenResources = {
			db: {
				prepare() {
					throw new Error("db unavailable");
				},
				batch() {
					return Promise.resolve([]);
				},
				exec() {
					return Promise.resolve({ count: 0, duration: 0 });
				},
				withSession() {
					throw new Error("db unavailable");
				},
				dump() {
					return Promise.resolve(new ArrayBuffer(0));
				},
			} as D1Database,
			queue: createQueueBinding(async () => {}),
		};
		const brokenRuntime = createCloudflareRuntime({
			handlers: {
				email: () => {},
			},
		});
		const brokenMessage = createAckableMessage({
			version: 1,
			kumofireJobRunId,
		});

		const result = await runtime.consumeBatch(
			{ messages: [validMessage, malformedMessage, retryMessage] },
			resources,
		);
		const brokenResult = await brokenRuntime.consumeBatch(
			{ messages: [brokenMessage] },
			brokenResources,
		);

		expect(result).toEqual({
			processed: 3,
			acked: 3,
			retried: 0,
			results: [
				{ outcome: "succeeded", jobRunId: kumofireJobRunId },
				{ outcome: "ignored", jobRunId: "missing" },
			],
		});
		expect(validMessage.acked).toBe(true);
		expect(malformedMessage.acked).toBe(true);
		expect(retryMessage.acked).toBe(true);
		expect(brokenResult).toEqual({
			processed: 1,
			acked: 0,
			retried: 1,
			results: [],
		});
		expect(brokenMessage.retried).toBe(true);
	});
});
