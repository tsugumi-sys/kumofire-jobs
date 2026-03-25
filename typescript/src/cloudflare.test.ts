import { describe, expect, it } from "vitest";

import {
	createCloudflareQueueAdapter,
	createD1StorageAdapter,
	createJobs,
	type D1Database,
	type D1PreparedStatement,
	type D1RunResult,
	getReferenceSchemaSql,
	type JobRunMessage,
	requiredSchemaVersion,
} from "./index";

interface StoredJobRow {
	id: string;
	name: string;
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
	private readonly jobs = new Map<string, StoredJobRow>();
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

		if (normalized.includes("FROM jobs WHERE id = ? LIMIT 1")) {
			const jobId = values[0];
			if (typeof jobId !== "string") {
				return null;
			}
			return (this.jobs.get(jobId) ?? null) as T | null;
		}

		if (normalized.includes("FROM jobs WHERE dedupe_key = ? LIMIT 1")) {
			const dedupeKey = values[0];
			if (typeof dedupeKey !== "string") {
				return null;
			}

			for (const job of this.jobs.values()) {
				if (job.dedupe_key === dedupeKey) {
					return job as T;
				}
			}

			return null;
		}

		throw new Error(`Unsupported first() query: ${normalized}`);
	}

	all<T>(query: string, values: unknown[]): T[] {
		const normalized = normalizeSql(query);
		if (!normalized.includes("FROM jobs WHERE status = 'scheduled'")) {
			throw new Error(`Unsupported all() query: ${normalized}`);
		}

		const now = values[0];
		const limit = values[1];
		if (typeof now !== "string" || typeof limit !== "number") {
			throw new Error("Invalid dispatch query bindings");
		}

		return [...this.jobs.values()]
			.filter(
				(job) =>
					job.status === "scheduled" &&
					job.next_run_at !== null &&
					job.next_run_at <= now,
			)
			.sort((left, right) => left.created_at.localeCompare(right.created_at))
			.slice(0, limit)
			.map((job) => ({ ...job }) as T);
	}

	run(query: string, values: unknown[]): D1RunResult {
		const normalized = normalizeSql(query);

		if (normalized.startsWith("INSERT INTO jobs")) {
			const [
				id,
				name,
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

			this.jobs.set(String(id), {
				id: String(id),
				name: String(name),
				status: status as StoredJobRow["status"],
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
			const [jobId, leaseUntil, , now] = values;
			const existing = this.locks.get(String(jobId));

			if (existing && existing.leaseUntil > String(now)) {
				return { success: true, meta: { changes: 0 } };
			}

			this.locks.set(String(jobId), { leaseUntil: String(leaseUntil) });
			return { success: true, meta: { changes: 1 } };
		}

		if (normalized.startsWith("DELETE FROM job_locks")) {
			this.locks.delete(String(values[0]));
			return { success: true, meta: { changes: 1 } };
		}

		if (normalized.includes("SET status = 'queued'")) {
			const [updatedAt, jobId] = values;
			const job = this.jobs.get(String(jobId));
			if (!job || job.status !== "scheduled") {
				return { success: true, meta: { changes: 0 } };
			}

			job.status = "queued";
			job.updated_at = String(updatedAt);
			return { success: true, meta: { changes: 1 } };
		}

		if (normalized.includes("SET status = 'running'")) {
			const [startedAt, updatedAt, jobId] = values;
			const job = this.jobs.get(String(jobId));
			if (!job || job.status !== "queued") {
				return { success: true, meta: { changes: 0 } };
			}

			job.status = "running";
			job.started_at = String(startedAt);
			job.updated_at = String(updatedAt);
			return { success: true, meta: { changes: 1 } };
		}

		if (normalized.includes("SET status = 'succeeded'")) {
			const [finishedAt, updatedAt, jobId] = values;
			const job = this.jobs.get(String(jobId));
			if (!job || job.status !== "running") {
				return { success: true, meta: { changes: 0 } };
			}

			job.status = "succeeded";
			job.finished_at = String(finishedAt);
			job.updated_at = String(updatedAt);
			job.last_error = null;
			return { success: true, meta: { changes: 1 } };
		}

		if (normalized.includes("SET status = 'scheduled'")) {
			const [nextRunAt, updatedAt, error, jobId] = values;
			const job = this.jobs.get(String(jobId));
			if (!job || job.status !== "running") {
				return { success: true, meta: { changes: 0 } };
			}

			job.status = "scheduled";
			job.attempt += 1;
			job.next_run_at = String(nextRunAt);
			job.updated_at = String(updatedAt);
			job.last_error = String(error);
			return { success: true, meta: { changes: 1 } };
		}

		if (normalized.includes("SET status = 'failed'")) {
			const [finishedAt, updatedAt, error, jobId] = values;
			const job = this.jobs.get(String(jobId));
			if (!job || (job.status !== "queued" && job.status !== "running")) {
				return { success: true, meta: { changes: 0 } };
			}

			job.status = "failed";
			job.attempt += 1;
			job.finished_at = String(finishedAt);
			job.updated_at = String(updatedAt);
			job.last_error = String(error);
			return { success: true, meta: { changes: 1 } };
		}

		throw new Error(`Unsupported run() query: ${normalized}`);
	}
}

function normalizeSql(query: string): string {
	return query.replaceAll(/\s+/g, " ").trim();
}

function asNullableString(value: unknown): string | null {
	return value == null ? null : String(value);
}

describe("cloudflare adapters", () => {
	it("exports reference schema SQL", () => {
		const sql = getReferenceSchemaSql();

		expect(sql).toContain("CREATE TABLE IF NOT EXISTS jobs");
		expect(sql).toContain("CREATE TABLE IF NOT EXISTS job_locks");
		expect(sql).toContain("CREATE TABLE IF NOT EXISTS schema_version");
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
