import type {
	D1Database as CloudflareD1Database,
	D1PreparedStatement as CloudflareD1PreparedStatement,
	D1Response,
	D1Result,
	Queue,
} from "@cloudflare/workers-types";
import type {
	JobDefinition,
	JobQueueAdapter,
	JobRun,
	JobRunMessage,
	JobRunStatus,
	JobStorageAdapter,
	JsonValue,
} from "./protocol";

export type D1RunMeta = D1Response["meta"];
export type D1Database = CloudflareD1Database;
export type D1PreparedStatement = CloudflareD1PreparedStatement;
export type D1RunResult<T = Record<string, unknown>> = D1Result<T>;
export type CloudflareQueue<TMessage = unknown> = Queue<TMessage>;

export const requiredSchemaVersion = 1;

const initSchemaSql = `CREATE TABLE IF NOT EXISTS job_definitions (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL UNIQUE,
	handler TEXT NOT NULL,
	payload_template TEXT,
	default_options TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_runs (
	id TEXT PRIMARY KEY,
	job_id TEXT NOT NULL,
	job_name TEXT NOT NULL,
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
	last_error TEXT,
	FOREIGN KEY (job_id) REFERENCES job_definitions(id)
);

CREATE INDEX IF NOT EXISTS job_runs_status_next_run_at_idx
	ON job_runs (status, next_run_at);

CREATE UNIQUE INDEX IF NOT EXISTS job_runs_dedupe_key_idx
	ON job_runs (dedupe_key)
	WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS job_locks (
	job_run_id TEXT PRIMARY KEY,
	lease_until TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_version (
	version INTEGER PRIMARY KEY,
	updated_at TEXT NOT NULL
);
`;

export const schemaMigrations = [
	{
		version: 1,
		name: "init",
		sql: initSchemaSql,
	},
] as const;

function normalizeChanges(result: D1RunResult): number {
	return result.meta?.changes ?? result.meta?.rows_written ?? 0;
}

function serializePayload(payload: JsonValue): string {
	return JSON.stringify(payload);
}

function parsePayload(payload: string): JsonValue {
	return JSON.parse(payload) as JsonValue;
}

interface D1DefinitionRow {
	id: string;
	name: string;
	handler: string;
	payload_template: string | null;
	default_options: string | null;
	created_at: string;
	updated_at: string;
}

interface D1JobRunRow {
	id: string;
	job_id: string;
	job_name: string;
	status: JobRunStatus;
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

function mapDefinitionRow(row: D1DefinitionRow): JobDefinition {
	return {
		id: row.id,
		name: row.name,
		handler: row.handler,
		...(row.payload_template
			? { payloadTemplate: parsePayload(row.payload_template) }
			: {}),
		...(row.default_options
			? { defaultOptions: parsePayload(row.default_options) }
			: {}),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function mapJobRunRow(row: D1JobRunRow): JobRun {
	return {
		id: row.id,
		jobId: row.job_id,
		jobName: row.job_name,
		status: row.status,
		payload: parsePayload(row.payload),
		attempt: row.attempt,
		maxAttempts: row.max_attempts,
		scheduledFor: row.next_run_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		startedAt: row.started_at,
		finishedAt: row.finished_at,
		lastError: row.last_error,
		...(row.dedupe_key ? { dedupeKey: row.dedupe_key } : {}),
	};
}

function createDefinitionSelect(whereClause: string): string {
	return `SELECT
	id,
	name,
	handler,
	payload_template,
	default_options,
	created_at,
	updated_at
FROM job_definitions
WHERE ${whereClause}
LIMIT 1`;
}

function createJobRunSelect(whereClause: string): string {
	return `SELECT
	id,
	job_id,
	job_name,
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
FROM job_runs
WHERE ${whereClause}
LIMIT 1`;
}

function requireSuccess(result: D1RunResult, operation: string): void {
	if (!result.success) {
		throw new Error(`D1 ${operation} failed`);
	}
}

async function fetchDefinitionBy(
	db: D1Database,
	whereClause: string,
	values: unknown[],
): Promise<JobDefinition | null> {
	const row = await db
		.prepare(createDefinitionSelect(whereClause))
		.bind(...values)
		.first<D1DefinitionRow>();

	return row ? mapDefinitionRow(row) : null;
}

async function fetchJobRunBy(
	db: D1Database,
	whereClause: string,
	values: unknown[],
): Promise<JobRun | null> {
	const row = await db
		.prepare(createJobRunSelect(whereClause))
		.bind(...values)
		.first<D1JobRunRow>();

	return row ? mapJobRunRow(row) : null;
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
	queue: CloudflareQueue<JobRunMessage>,
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
	let sequence = 0;

	function generateRunId(): string {
		sequence += 1;
		return `job_run_${sequence}`;
	}

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

		async createDefinition(definition) {
			const insertResult = await params.db
				.prepare(`INSERT INTO job_definitions (
	id,
	name,
	handler,
	payload_template,
	default_options,
	created_at,
	updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO NOTHING`)
				.bind(
					definition.id,
					definition.name,
					definition.handler,
					definition.payloadTemplate
						? serializePayload(definition.payloadTemplate)
						: null,
					definition.defaultOptions
						? serializePayload(definition.defaultOptions)
						: null,
					definition.createdAt,
					definition.updatedAt,
				)
				.run();

			requireSuccess(insertResult, "create definition");

			const createdDefinition = await fetchDefinitionBy(params.db, "id = ?", [
				definition.id,
			]);
			if (!createdDefinition) {
				throw new Error(
					`D1 create definition failed to return row for "${definition.id}"`,
				);
			}

			return createdDefinition;
		},

		getDefinition(jobId) {
			return fetchDefinitionBy(params.db, "id = ?", [jobId]);
		},

		getDefinitionByName(jobName) {
			return fetchDefinitionBy(params.db, "name = ?", [jobName]);
		},

		async createRun(jobRun) {
			const createdJobRun: JobRun = {
				...jobRun,
				id: generateRunId(),
			};

			const result = await params.db
				.prepare(`INSERT INTO job_runs (
	id,
	job_id,
	job_name,
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
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
				.bind(
					createdJobRun.id,
					createdJobRun.jobId,
					createdJobRun.jobName,
					createdJobRun.status,
					createdJobRun.dedupeKey ?? null,
					serializePayload(createdJobRun.payload),
					createdJobRun.attempt,
					createdJobRun.maxAttempts,
					createdJobRun.scheduledFor,
					createdJobRun.createdAt,
					createdJobRun.updatedAt,
					createdJobRun.startedAt,
					createdJobRun.finishedAt,
					createdJobRun.lastError,
				)
				.run();

			requireSuccess(result, "insert run");
			return createdJobRun;
		},

		getRun(jobRunId) {
			return fetchJobRunBy(params.db, "id = ?", [jobRunId]);
		},

		getRunByDedupeKey(dedupeKey) {
			return fetchJobRunBy(params.db, "dedupe_key = ?", [dedupeKey]);
		},

		async listDispatchableJobs({ now, limit }) {
			const result = await params.db
				.prepare(`SELECT
	id,
	job_id,
	job_name,
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
FROM job_runs
WHERE status = 'scheduled'
	AND next_run_at IS NOT NULL
	AND next_run_at <= ?
ORDER BY created_at ASC
LIMIT ?`)
				.bind(now.toISOString(), limit)
				.all<D1JobRunRow>();

			return result.results.map(mapJobRunRow);
		},

		async acquireLease({ jobRunId, now, leaseMs }) {
			const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
			const result = await params.db
				.prepare(`INSERT INTO job_locks (job_run_id, lease_until, updated_at)
VALUES (?, ?, ?)
ON CONFLICT(job_run_id) DO UPDATE SET
	lease_until = excluded.lease_until,
	updated_at = excluded.updated_at
WHERE job_locks.lease_until <= ?`)
				.bind(jobRunId, leaseUntil, now.toISOString(), now.toISOString())
				.run();

			requireSuccess(result, "acquire lease");
			return normalizeChanges(result) > 0;
		},

		async releaseLease(jobRunId) {
			const result = await params.db
				.prepare("DELETE FROM job_locks WHERE job_run_id = ?")
				.bind(jobRunId)
				.run();

			requireSuccess(result, "release lease");
		},

		async markQueued({ jobRunId, now }) {
			const timestamp = now.toISOString();
			const result = await params.db
				.prepare(`UPDATE job_runs
SET status = 'queued',
	updated_at = ?
WHERE id = ?
	AND status = 'scheduled'`)
				.bind(timestamp, jobRunId)
				.run();

			requireSuccess(result, "mark queued");
			if (normalizeChanges(result) === 0) {
				return null;
			}

			return fetchJobRunBy(params.db, "id = ?", [jobRunId]);
		},

		async markRunning({ jobRunId, now }) {
			const timestamp = now.toISOString();
			const result = await params.db
				.prepare(`UPDATE job_runs
SET status = 'running',
	started_at = ?,
	updated_at = ?
WHERE id = ?
	AND status = 'queued'`)
				.bind(timestamp, timestamp, jobRunId)
				.run();

			requireSuccess(result, "mark running");
			if (normalizeChanges(result) === 0) {
				return null;
			}

			return fetchJobRunBy(params.db, "id = ?", [jobRunId]);
		},

		async markSucceeded({ jobRunId, now }) {
			const timestamp = now.toISOString();
			const result = await params.db
				.prepare(`UPDATE job_runs
SET status = 'succeeded',
	finished_at = ?,
	updated_at = ?,
	last_error = NULL
WHERE id = ?
	AND status = 'running'`)
				.bind(timestamp, timestamp, jobRunId)
				.run();

			requireSuccess(result, "mark succeeded");
			if (normalizeChanges(result) === 0) {
				return null;
			}

			return fetchJobRunBy(params.db, "id = ?", [jobRunId]);
		},

		async markRetryable({ jobRunId, now, nextRunAt, error }) {
			const timestamp = now.toISOString();
			const result = await params.db
				.prepare(`UPDATE job_runs
SET status = 'scheduled',
	attempt = attempt + 1,
	next_run_at = ?,
	updated_at = ?,
	last_error = ?
WHERE id = ?
	AND status = 'running'`)
				.bind(nextRunAt.toISOString(), timestamp, error, jobRunId)
				.run();

			requireSuccess(result, "mark retryable");
			if (normalizeChanges(result) === 0) {
				return null;
			}

			return fetchJobRunBy(params.db, "id = ?", [jobRunId]);
		},

		async markFailed({ jobRunId, now, error }) {
			const timestamp = now.toISOString();
			const result = await params.db
				.prepare(`UPDATE job_runs
SET status = 'failed',
	attempt = attempt + 1,
	finished_at = ?,
	updated_at = ?,
	last_error = ?
WHERE id = ?
	AND status IN ('queued', 'running')`)
				.bind(timestamp, timestamp, error, jobRunId)
				.run();

			requireSuccess(result, "mark failed");
			if (normalizeChanges(result) === 0) {
				return null;
			}

			return fetchJobRunBy(params.db, "id = ?", [jobRunId]);
		},
	};
}
