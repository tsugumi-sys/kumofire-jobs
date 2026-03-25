import { describe, expect, it } from "vitest";

import type {
	D1Database,
	D1PreparedStatement,
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

	first<T>(): Promise<T | null> {
		return Promise.resolve(this.database.first<T>(this.query, this.values));
	}

	run(): Promise<D1RunResult> {
		return Promise.resolve(this.database.run(this.query, this.values));
	}

	all<T>(): Promise<{ results: T[] }> {
		return Promise.resolve({
			results: this.database.all<T>(this.query, this.values),
		});
	}
}

class FakeD1Database implements D1Database {
	private readonly definitions = new Map<string, StoredDefinitionRow>();
	private readonly definitionsByName = new Map<string, string>();
	private readonly jobRuns = new Map<string, StoredJobRunRow>();
	private readonly locks = new Map<string, { leaseUntil: string }>();

	constructor(private readonly schemaVersion: number = requiredSchemaVersion) {}

	prepare(query: string): D1PreparedStatement {
		return new FakeD1PreparedStatement(this, query);
	}

	first<T>(query: string, values: unknown[]): T | null {
		const normalized = normalizeSql(query);

		if (normalized.startsWith("SELECT version FROM schema_version")) {
			return { version: this.schemaVersion } as T;
		}

		if (normalized.includes("FROM job_definitions WHERE id = ? LIMIT 1")) {
			const definitionId = values[0];
			if (typeof definitionId !== "string") {
				return null;
			}

			return (this.definitions.get(definitionId) ?? null) as T | null;
		}

		if (normalized.includes("FROM job_definitions WHERE name = ? LIMIT 1")) {
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

		if (normalized.includes("FROM job_runs WHERE id = ? LIMIT 1")) {
			const jobRunId = values[0];
			if (typeof jobRunId !== "string") {
				return null;
			}

			return (this.jobRuns.get(jobRunId) ?? null) as T | null;
		}

		if (normalized.includes("FROM job_runs WHERE dedupe_key = ? LIMIT 1")) {
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

	all<T>(query: string, values: unknown[]): T[] {
		const normalized = normalizeSql(query);
		if (!normalized.includes("FROM job_runs WHERE status = 'scheduled'")) {
			throw new Error(`Unsupported all() query: ${normalized}`);
		}

		const now = values[0];
		const limit = values[1];
		if (typeof now !== "string" || typeof limit !== "number") {
			throw new Error("Invalid dispatch query bindings");
		}

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

	run(query: string, values: unknown[]): D1RunResult {
		const normalized = normalizeSql(query);

		if (normalized.startsWith("INSERT INTO job_definitions")) {
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
				return { success: true, meta: { changes: 0 } };
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
			return { success: true, meta: { changes: 1 } };
		}

		if (normalized.startsWith("INSERT INTO job_runs")) {
			const [
				id,
				jobId,
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

			return { success: true, meta: { changes: 1 } };
		}

		if (normalized.startsWith("INSERT INTO job_locks")) {
			const [jobRunId, leaseUntil, , now] = values;
			const existing = this.locks.get(String(jobRunId));

			if (existing && existing.leaseUntil > String(now)) {
				return { success: true, meta: { changes: 0 } };
			}

			this.locks.set(String(jobRunId), { leaseUntil: String(leaseUntil) });
			return { success: true, meta: { changes: 1 } };
		}

		if (normalized.startsWith("DELETE FROM job_locks")) {
			this.locks.delete(String(values[0]));
			return { success: true, meta: { changes: 1 } };
		}

		if (normalized.includes("UPDATE job_runs SET status = 'queued'")) {
			const [updatedAt, jobRunId] = values;
			const jobRun = this.jobRuns.get(String(jobRunId));
			if (!jobRun || jobRun.status !== "scheduled") {
				return { success: true, meta: { changes: 0 } };
			}

			jobRun.status = "queued";
			jobRun.updated_at = String(updatedAt);
			return { success: true, meta: { changes: 1 } };
		}

		if (normalized.includes("UPDATE job_runs SET status = 'running'")) {
			const [startedAt, updatedAt, jobRunId] = values;
			const jobRun = this.jobRuns.get(String(jobRunId));
			if (!jobRun || jobRun.status !== "queued") {
				return { success: true, meta: { changes: 0 } };
			}

			jobRun.status = "running";
			jobRun.started_at = String(startedAt);
			jobRun.updated_at = String(updatedAt);
			return { success: true, meta: { changes: 1 } };
		}

		if (normalized.includes("UPDATE job_runs SET status = 'succeeded'")) {
			const [finishedAt, updatedAt, jobRunId] = values;
			const jobRun = this.jobRuns.get(String(jobRunId));
			if (!jobRun || jobRun.status !== "running") {
				return { success: true, meta: { changes: 0 } };
			}

			jobRun.status = "succeeded";
			jobRun.finished_at = String(finishedAt);
			jobRun.updated_at = String(updatedAt);
			jobRun.last_error = null;
			return { success: true, meta: { changes: 1 } };
		}

		if (normalized.includes("UPDATE job_runs SET status = 'scheduled'")) {
			const [nextRunAt, updatedAt, error, jobRunId] = values;
			const jobRun = this.jobRuns.get(String(jobRunId));
			if (!jobRun || jobRun.status !== "running") {
				return { success: true, meta: { changes: 0 } };
			}

			jobRun.status = "scheduled";
			jobRun.attempt += 1;
			jobRun.next_run_at = String(nextRunAt);
			jobRun.updated_at = String(updatedAt);
			jobRun.last_error = String(error);
			return { success: true, meta: { changes: 1 } };
		}

		if (normalized.includes("UPDATE job_runs SET status = 'failed'")) {
			const [finishedAt, updatedAt, error, jobRunId] = values;
			const jobRun = this.jobRuns.get(String(jobRunId));
			if (
				!jobRun ||
				(jobRun.status !== "queued" && jobRun.status !== "running")
			) {
				return { success: true, meta: { changes: 0 } };
			}

			jobRun.status = "failed";
			jobRun.attempt += 1;
			jobRun.finished_at = String(finishedAt);
			jobRun.updated_at = String(updatedAt);
			jobRun.last_error = String(error);
			return { success: true, meta: { changes: 1 } };
		}

		throw new Error(`Unsupported run() query: ${normalized}`);
	}

	getDefinition(id: string): StoredDefinitionRow | null {
		const definition = this.definitions.get(id);
		return definition ? { ...definition } : null;
	}

	getJobRun(id: string): StoredJobRunRow | null {
		const jobRun = this.jobRuns.get(id);
		return jobRun ? { ...jobRun } : null;
	}
}

function normalizeSql(query: string): string {
	return query.replaceAll(/\s+/g, " ").trim();
}

function asNullableString(value: unknown): string | null {
	return value == null ? null : String(value);
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

		expect(sql).toContain("CREATE TABLE IF NOT EXISTS job_definitions");
		expect(sql).toContain("CREATE TABLE IF NOT EXISTS job_runs");
		expect(sql).toContain("CREATE TABLE IF NOT EXISTS job_locks");
		expect(sql).toContain("CREATE TABLE IF NOT EXISTS schema_version");
	});

	it("stores synchronized definitions in D1", async () => {
		const db = new FakeD1Database();
		const jobs = createJobs({
			storage: createD1StorageAdapter({ db }),
			queue: createCloudflareQueueAdapter({
				send: async () => {},
			}),
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
			queue: createCloudflareQueueAdapter({
				send: async (message) => {
					queueMessages.push(message);
				},
			}),
			now: () => now,
			handlers: {
				email: () => {},
			},
		});

		const { jobId } = await jobs.create({
			name: "email",
			payload: { to: "user@example.com" },
		});

		expect(queueMessages).toEqual([{ version: 1, jobRunId: jobId }]);
		expect(db.getJobRun(jobId)).toMatchObject({
			id: jobId,
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
			jobRunId: jobId,
		});
		await expect(jobs.getStatus(jobId)).resolves.toMatchObject({
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
			queue: createCloudflareQueueAdapter({
				send: async (message) => {
					queueMessages.push(message);
				},
			}),
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

	it("fails fast when the D1 schema version is too old", async () => {
		const db = new FakeD1Database(0);
		const jobs = createJobs({
			storage: createD1StorageAdapter({ db }),
			queue: createCloudflareQueueAdapter({
				send: async () => {},
			}),
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
			"Schema version 0 does not satisfy required version 1. Apply Kumofire Jobs migrations.",
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
			queue: {
				send: async (message: JobRunMessage) => {
					queueMessages.push(message);
				},
			},
		};

		const jobs = runtime.bind(resources);
		const { jobId } = await jobs.create({
			name: "email",
			payload: { to: "user@example.com" },
			runAt: new Date("2026-03-25T00:05:00.000Z"),
		});

		expect(queueMessages).toEqual([]);
		now = new Date("2026-03-25T00:05:00.000Z");
		await expect(runtime.dispatchScheduled(resources)).resolves.toEqual({
			dispatched: 1,
		});
		expect(queueMessages).toEqual([{ version: 1, jobRunId: jobId }]);
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
			queue: workerEnv.JOBS_QUEUE,
		};

		const jobs = runtime.bind(resources);
		const { jobId } = await jobs.create({
			name: "email",
			payload: { to: "user@example.com" },
		});

		expect(queueMessages).toEqual([{ version: 1, jobRunId: jobId }]);
		await expect(jobs.getStatus(jobId)).resolves.toMatchObject({
			id: jobId,
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
			queue: {
				send: async () => {},
			},
		};
		const jobs = runtime.bind(resources);
		const { jobId } = await jobs.create({
			name: "email",
			payload: { to: "user@example.com" },
		});

		const validMessage = createAckableMessage({ version: 1, jobRunId: jobId });
		const malformedMessage = createAckableMessage({ version: 2, jobRunId: 1 });
		const retryMessage = createAckableMessage({
			version: 1,
			jobRunId: "missing",
		});
		const brokenResources = {
			db: {
				prepare() {
					throw new Error("db unavailable");
				},
			},
			queue: {
				send: async () => {},
			},
		};
		const brokenRuntime = createCloudflareRuntime({
			handlers: {
				email: () => {},
			},
		});
		const brokenMessage = createAckableMessage({
			version: 1,
			jobRunId: jobId,
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
				{ outcome: "succeeded", jobRunId: jobId },
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
