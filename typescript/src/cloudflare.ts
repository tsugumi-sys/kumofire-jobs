import type {
	JobMessage,
	JobQueueAdapter,
	JobRecord,
	JobStatus,
	JobStorageAdapter,
	JsonValue,
} from "./protocol";

export interface D1RunMeta {
	changes?: number;
	rows_written?: number;
}

export interface D1RunResult {
	success: boolean;
	meta?: D1RunMeta;
}

export interface D1PreparedStatement {
	bind(...values: unknown[]): D1PreparedStatement;
	first<T = Record<string, unknown>>(
		columnName?: keyof T & string,
	): Promise<T | null>;
	run(): Promise<D1RunResult>;
	all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}

export interface D1Database {
	prepare(query: string): D1PreparedStatement;
}

export interface CloudflareQueue<TMessage = unknown> {
	send(message: TMessage): Promise<void>;
}

export const requiredSchemaVersion = 1;

export const schemaMigrations = [
	{
		version: 1,
		name: "init",
		sql: `CREATE TABLE IF NOT EXISTS jobs (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	status TEXT NOT NULL,
	dedupe_key TEXT,
	payload TEXT NOT NULL,
	attempt INTEGER NOT NULL DEFAULT 0,
	max_attempts INTEGER NOT NULL,
	next_run_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	started_at TEXT,
	finished_at TEXT,
	last_error TEXT
);

CREATE INDEX IF NOT EXISTS jobs_status_next_run_at_idx
	ON jobs (status, next_run_at);

CREATE UNIQUE INDEX IF NOT EXISTS jobs_dedupe_key_idx
	ON jobs (dedupe_key)
	WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS job_locks (
	job_id TEXT PRIMARY KEY,
	lease_until TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_version (
	version INTEGER NOT NULL,
	updated_at TEXT NOT NULL
);
`,
	},
] as const;

function normalizeChanges(result: D1RunResult): number {
	return result.meta?.changes ?? result.meta?.rows_written ?? 0;
}

function serializePayload(payload: JsonValue): string {
	return JSON.stringify(payload);
}

interface D1JobRow {
	id: string;
	name: string;
	status: JobStatus;
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

function mapJobRow(row: D1JobRow): JobRecord {
	return {
		id: row.id,
		name: row.name,
		status: row.status,
		payload: JSON.parse(row.payload) as JsonValue,
		attempt: row.attempt,
		maxAttempts: row.max_attempts,
		nextRunAt: row.next_run_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		startedAt: row.started_at,
		finishedAt: row.finished_at,
		lastError: row.last_error,
		...(row.dedupe_key ? { dedupeKey: row.dedupe_key } : {}),
	};
}

function createJobSelect(whereClause: string): string {
	return `SELECT
	id,
	name,
	status,
	dedupe_key,
	payload,
	attempt,
	max_attempts,
	next_run_at,
	created_at,
	updated_at,
	started_at,
	finished_at,
	last_error
FROM jobs
WHERE ${whereClause}
LIMIT 1`;
}

function requireSuccess(result: D1RunResult, operation: string): void {
	if (!result.success) {
		throw new Error(`D1 ${operation} failed`);
	}
}

async function fetchJobBy(
	db: D1Database,
	whereClause: string,
	values: unknown[],
): Promise<JobRecord | null> {
	const row = await db
		.prepare(createJobSelect(whereClause))
		.bind(...values)
		.first<D1JobRow>();

	return row ? mapJobRow(row) : null;
}

export function getReferenceSchemaSql(params?: {
	fromVersion?: number;
	toVersion?: number;
}): string {
	const fromVersion = params?.fromVersion ?? 0;
	const toVersion = params?.toVersion ?? requiredSchemaVersion;

	return schemaMigrations
		.filter(
			(migration) =>
				migration.version > fromVersion && migration.version <= toVersion,
		)
		.map((migration) => migration.sql.trim())
		.join("\n\n");
}

export function createCloudflareQueueAdapter(
	queue: CloudflareQueue<JobMessage>,
): JobQueueAdapter {
	return {
		send(message) {
			return queue.send(message);
		},
	};
}

export function createD1StorageAdapter(params: {
	db: D1Database;
	requiredSchemaVersion?: number;
}): JobStorageAdapter {
	const schemaVersion = params.requiredSchemaVersion ?? requiredSchemaVersion;

	return {
		async verifySchemaVersion() {
			const row = await params.db
				.prepare(
					"SELECT version FROM schema_version ORDER BY version DESC LIMIT 1",
				)
				.first<{ version: number }>();

			const currentVersion = row?.version ?? 0;
			if (currentVersion < schemaVersion) {
				throw new Error(
					`Schema version ${currentVersion} does not satisfy required version ${schemaVersion}. Apply Kumofire Jobs migrations.`,
				);
			}
		},

		async createJob(job) {
			const result = await params.db
				.prepare(`INSERT INTO jobs (
	id,
	name,
	status,
	dedupe_key,
	payload,
	attempt,
	max_attempts,
	next_run_at,
	created_at,
	updated_at,
	started_at,
	finished_at,
	last_error
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
				.bind(
					job.id,
					job.name,
					job.status,
					job.dedupeKey ?? null,
					serializePayload(job.payload),
					job.attempt,
					job.maxAttempts,
					job.nextRunAt,
					job.createdAt,
					job.updatedAt,
					job.startedAt,
					job.finishedAt,
					job.lastError,
				)
				.run();

			requireSuccess(result, "insert");
			return job;
		},

		getJob(jobId) {
			return fetchJobBy(params.db, "id = ?", [jobId]);
		},

		getJobByDedupeKey(dedupeKey) {
			return fetchJobBy(params.db, "dedupe_key = ?", [dedupeKey]);
		},

		async listDispatchableJobs({ now, limit }) {
			const result = await params.db
				.prepare(`SELECT
	id,
	name,
	status,
	dedupe_key,
	payload,
	attempt,
	max_attempts,
	next_run_at,
	created_at,
	updated_at,
	started_at,
	finished_at,
	last_error
FROM jobs
WHERE status = 'queued'
	AND next_run_at IS NOT NULL
	AND next_run_at <= ?
ORDER BY created_at ASC
LIMIT ?`)
				.bind(now.toISOString(), limit)
				.all<D1JobRow>();

			return result.results.map(mapJobRow);
		},

		async acquireLease({ jobId, now, leaseMs }) {
			const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
			const result = await params.db
				.prepare(`INSERT INTO job_locks (job_id, lease_until, updated_at)
VALUES (?, ?, ?)
ON CONFLICT(job_id) DO UPDATE SET
	lease_until = excluded.lease_until,
	updated_at = excluded.updated_at
WHERE job_locks.lease_until <= ?`)
				.bind(jobId, leaseUntil, now.toISOString(), now.toISOString())
				.run();

			requireSuccess(result, "acquire lease");
			return normalizeChanges(result) > 0;
		},

		async releaseLease(jobId) {
			const result = await params.db
				.prepare("DELETE FROM job_locks WHERE job_id = ?")
				.bind(jobId)
				.run();

			requireSuccess(result, "release lease");
		},

		async markRunning({ jobId, now }) {
			const timestamp = now.toISOString();
			const result = await params.db
				.prepare(`UPDATE jobs
SET status = 'running',
	started_at = ?,
	updated_at = ?
WHERE id = ?
	AND status = 'queued'`)
				.bind(timestamp, timestamp, jobId)
				.run();

			requireSuccess(result, "mark running");
			if (normalizeChanges(result) === 0) {
				return null;
			}

			return fetchJobBy(params.db, "id = ?", [jobId]);
		},

		async markSucceeded({ jobId, now }) {
			const timestamp = now.toISOString();
			const result = await params.db
				.prepare(`UPDATE jobs
SET status = 'succeeded',
	finished_at = ?,
	updated_at = ?,
	last_error = NULL
WHERE id = ?
	AND status = 'running'`)
				.bind(timestamp, timestamp, jobId)
				.run();

			requireSuccess(result, "mark succeeded");
			if (normalizeChanges(result) === 0) {
				return null;
			}

			return fetchJobBy(params.db, "id = ?", [jobId]);
		},

		async markRetryable({ jobId, now, nextRunAt, error }) {
			const timestamp = now.toISOString();
			const result = await params.db
				.prepare(`UPDATE jobs
SET status = 'queued',
	attempt = attempt + 1,
	next_run_at = ?,
	updated_at = ?,
	last_error = ?
WHERE id = ?
	AND status = 'running'`)
				.bind(nextRunAt.toISOString(), timestamp, error, jobId)
				.run();

			requireSuccess(result, "mark retryable");
			if (normalizeChanges(result) === 0) {
				return null;
			}

			return fetchJobBy(params.db, "id = ?", [jobId]);
		},

		async markFailed({ jobId, now, error }) {
			const timestamp = now.toISOString();
			const result = await params.db
				.prepare(`UPDATE jobs
SET status = 'failed',
	attempt = attempt + 1,
	finished_at = ?,
	updated_at = ?,
	last_error = ?
WHERE id = ?
	AND status IN ('queued', 'running')`)
				.bind(timestamp, timestamp, error, jobId)
				.run();

			requireSuccess(result, "mark failed");
			if (normalizeChanges(result) === 0) {
				return null;
			}

			return fetchJobBy(params.db, "id = ?", [jobId]);
		},
	};
}
