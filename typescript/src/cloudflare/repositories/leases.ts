import type { D1Database } from "../index";
import { normalizeChanges, requireSuccess } from "./shared";

export function createLeaseRepository(db: D1Database) {
	return {
		async acquire(params: {
			jobRunId: string;
			now: Date;
			leaseMs: number;
		}): Promise<boolean> {
			const leaseUntil = new Date(
				params.now.getTime() + params.leaseMs,
			).toISOString();
			const result = await db
				.prepare(`INSERT INTO kumofire_job_locks (job_run_id, lease_until, updated_at)
VALUES (?, ?, ?)
ON CONFLICT(job_run_id) DO UPDATE SET
\tlease_until = excluded.lease_until,
\tupdated_at = excluded.updated_at
WHERE kumofire_job_locks.lease_until <= ?`)
				.bind(
					params.jobRunId,
					leaseUntil,
					params.now.toISOString(),
					params.now.toISOString(),
				)
				.run();

			requireSuccess(result, "acquire lease");
			return normalizeChanges(result) > 0;
		},

		async release(jobRunId: string): Promise<void> {
			const result = await db
				.prepare("DELETE FROM kumofire_job_locks WHERE job_run_id = ?")
				.bind(jobRunId)
				.run();

			requireSuccess(result, "release lease");
		},
	};
}
