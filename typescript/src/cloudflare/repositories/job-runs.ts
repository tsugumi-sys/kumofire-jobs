import type { JobRun } from "../../protocol";
import type { D1Database } from "../index";
import {
	type D1JobRunRow,
	fetchJobRunBy,
	mapJobRunRow,
	normalizeChanges,
	requireSuccess,
	serializePayload,
} from "./shared";

export function createJobRunRepository(db: D1Database) {
	return {
		async create(jobRun: JobRun & { id: string }): Promise<JobRun> {
			const result = await db
				.prepare(`INSERT INTO kumofire_job_runs (
\tid,
\tjob_id,
\tjob_name,
\tstatus,
\tdedupe_key,
\tpayload,
\tattempt,
\tmax_attempts,
\tnext_run_at,
\tcreated_at,
\tupdated_at,
\tstarted_at,
\tfinished_at,
\tlast_error
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
				.bind(
					jobRun.id,
					jobRun.jobId,
					jobRun.jobName,
					jobRun.status,
					jobRun.dedupeKey ?? null,
					serializePayload(jobRun.payload),
					jobRun.attempt,
					jobRun.maxAttempts,
					jobRun.scheduledFor,
					jobRun.createdAt,
					jobRun.updatedAt,
					jobRun.startedAt,
					jobRun.finishedAt,
					jobRun.lastError,
				)
				.run();

			requireSuccess(result, "insert run");
			return jobRun;
		},

		getById(jobRunId: string): Promise<JobRun | null> {
			return fetchJobRunBy(db, "id = ?", [jobRunId]);
		},

		getByDedupeKey(dedupeKey: string): Promise<JobRun | null> {
			return fetchJobRunBy(db, "dedupe_key = ?", [dedupeKey]);
		},

		async listDispatchable(params: {
			now: Date;
			limit: number;
		}): Promise<JobRun[]> {
			const result = await db
				.prepare(`SELECT
\tid,
\tjob_id,
\tjob_name,
\tstatus,
\tdedupe_key,
\tpayload,
\tattempt,
\tmax_attempts,
\tnext_run_at,
\tcreated_at,
\tupdated_at,
\tstarted_at,
\tfinished_at,
\tlast_error
FROM kumofire_job_runs
WHERE status = 'scheduled'
\tAND next_run_at IS NOT NULL
\tAND next_run_at <= ?
ORDER BY created_at ASC
LIMIT ?`)
				.bind(params.now.toISOString(), params.limit)
				.all<D1JobRunRow>();

			return result.results.map(mapJobRunRow);
		},

		async markQueued(params: {
			jobRunId: string;
			now: Date;
		}): Promise<JobRun | null> {
			const result = await db
				.prepare(`UPDATE kumofire_job_runs
SET status = 'queued',
\tupdated_at = ?
WHERE id = ?
\tAND status = 'scheduled'`)
				.bind(params.now.toISOString(), params.jobRunId)
				.run();

			requireSuccess(result, "mark queued");
			if (normalizeChanges(result) === 0) {
				return null;
			}

			return fetchJobRunBy(db, "id = ?", [params.jobRunId]);
		},

		async markRunning(params: {
			jobRunId: string;
			now: Date;
		}): Promise<JobRun | null> {
			const timestamp = params.now.toISOString();
			const result = await db
				.prepare(`UPDATE kumofire_job_runs
SET status = 'running',
\tstarted_at = ?,
\tupdated_at = ?
WHERE id = ?
\tAND status = 'queued'`)
				.bind(timestamp, timestamp, params.jobRunId)
				.run();

			requireSuccess(result, "mark running");
			if (normalizeChanges(result) === 0) {
				return null;
			}

			return fetchJobRunBy(db, "id = ?", [params.jobRunId]);
		},

		async markSucceeded(params: {
			jobRunId: string;
			now: Date;
		}): Promise<JobRun | null> {
			const timestamp = params.now.toISOString();
			const result = await db
				.prepare(`UPDATE kumofire_job_runs
SET status = 'succeeded',
\tfinished_at = ?,
\tupdated_at = ?,
\tlast_error = NULL
WHERE id = ?
\tAND status = 'running'`)
				.bind(timestamp, timestamp, params.jobRunId)
				.run();

			requireSuccess(result, "mark succeeded");
			if (normalizeChanges(result) === 0) {
				return null;
			}

			return fetchJobRunBy(db, "id = ?", [params.jobRunId]);
		},

		async markRetryable(params: {
			jobRunId: string;
			now: Date;
			nextRunAt: Date;
			error: string;
		}): Promise<JobRun | null> {
			const result = await db
				.prepare(`UPDATE kumofire_job_runs
SET status = 'scheduled',
\tattempt = attempt + 1,
\tnext_run_at = ?,
\tupdated_at = ?,
\tlast_error = ?
WHERE id = ?
\tAND status = 'running'`)
				.bind(
					params.nextRunAt.toISOString(),
					params.now.toISOString(),
					params.error,
					params.jobRunId,
				)
				.run();

			requireSuccess(result, "mark retryable");
			if (normalizeChanges(result) === 0) {
				return null;
			}

			return fetchJobRunBy(db, "id = ?", [params.jobRunId]);
		},

		async markFailed(params: {
			jobRunId: string;
			now: Date;
			error: string;
		}): Promise<JobRun | null> {
			const timestamp = params.now.toISOString();
			const result = await db
				.prepare(`UPDATE kumofire_job_runs
SET status = 'failed',
\tattempt = attempt + 1,
\tfinished_at = ?,
\tupdated_at = ?,
\tlast_error = ?
WHERE id = ?
\tAND status IN ('queued', 'running')`)
				.bind(timestamp, timestamp, params.error, params.jobRunId)
				.run();

			requireSuccess(result, "mark failed");
			if (normalizeChanges(result) === 0) {
				return null;
			}

			return fetchJobRunBy(db, "id = ?", [params.jobRunId]);
		},
	};
}
