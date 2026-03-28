import type { JobSchedule } from "../../protocol";
import type { D1Database } from "../types";
import {
	type D1JobScheduleRow,
	fetchJobScheduleBy,
	mapJobScheduleRow,
	normalizeChanges,
	requireSuccess,
	serializePayload,
} from "./shared";

export function createJobScheduleRepository(db: D1Database) {
	return {
		async create(schedule: JobSchedule & { id: string }): Promise<JobSchedule> {
			const result = await db
				.prepare(`INSERT INTO kumofire_job_schedules (
\tid,
\tjob_id,
\tjob_name,
\tschedule_key,
\tschedule_type,
\tschedule_expr,
\ttimezone,
\tnext_run_at,
\tlast_scheduled_at,
\tenabled,
\tpayload,
\tmax_attempts,
\tcreated_at,
\tupdated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
				.bind(
					schedule.id,
					schedule.jobId,
					schedule.jobName,
					schedule.scheduleKey,
					schedule.scheduleType,
					schedule.scheduleExpr,
					schedule.timezone,
					schedule.nextRunAt,
					schedule.lastScheduledAt,
					schedule.enabled ? 1 : 0,
					serializePayload(schedule.payload),
					schedule.maxAttempts,
					schedule.createdAt,
					schedule.updatedAt,
				)
				.run();

			requireSuccess(result, "insert schedule");
			return schedule;
		},

		getById(scheduleId: string) {
			return fetchJobScheduleBy(db, "id = ?", [scheduleId]);
		},

		getByKey(scheduleKey: string) {
			return fetchJobScheduleBy(db, "schedule_key = ?", [scheduleKey]);
		},

		async update(schedule: JobSchedule): Promise<JobSchedule | null> {
			const result = await db
				.prepare(`UPDATE kumofire_job_schedules
SET job_id = ?,
\tjob_name = ?,
\tschedule_key = ?,
\tschedule_type = ?,
\tschedule_expr = ?,
\ttimezone = ?,
\tnext_run_at = ?,
\tlast_scheduled_at = ?,
\tenabled = ?,
\tpayload = ?,
\tmax_attempts = ?,
\tupdated_at = ?
WHERE id = ?`)
				.bind(
					schedule.jobId,
					schedule.jobName,
					schedule.scheduleKey,
					schedule.scheduleType,
					schedule.scheduleExpr,
					schedule.timezone,
					schedule.nextRunAt,
					schedule.lastScheduledAt,
					schedule.enabled ? 1 : 0,
					serializePayload(schedule.payload),
					schedule.maxAttempts,
					schedule.updatedAt,
					schedule.id,
				)
				.run();

			requireSuccess(result, "update schedule");
			if (normalizeChanges(result) === 0) {
				return null;
			}

			return fetchJobScheduleBy(db, "id = ?", [schedule.id]);
		},

		async listDue(params: {
			now: Date;
			limit: number;
		}): Promise<JobSchedule[]> {
			const result = await db
				.prepare(`SELECT
\tid,
\tjob_id,
\tjob_name,
\tschedule_key,
\tschedule_type,
\tschedule_expr,
\ttimezone,
\tnext_run_at,
\tlast_scheduled_at,
\tenabled,
\tpayload,
\tmax_attempts,
\tcreated_at,
\tupdated_at
FROM kumofire_job_schedules
WHERE enabled = 1
\tAND next_run_at IS NOT NULL
\tAND next_run_at <= ?
ORDER BY next_run_at ASC, created_at ASC
LIMIT ?`)
				.bind(params.now.toISOString(), params.limit)
				.all<D1JobScheduleRow>();

			return result.results.map(mapJobScheduleRow);
		},

		async advance(params: {
			scheduleId: string;
			now: Date;
			lastScheduledAt: string;
			nextRunAt: string | null;
		}): Promise<JobSchedule | null> {
			const result = await db
				.prepare(`UPDATE kumofire_job_schedules
SET last_scheduled_at = ?,
\tnext_run_at = ?,
\tupdated_at = ?
WHERE id = ?
\tAND enabled = 1
\tAND next_run_at = ?`)
				.bind(
					params.lastScheduledAt,
					params.nextRunAt,
					params.now.toISOString(),
					params.scheduleId,
					params.lastScheduledAt,
				)
				.run();

			requireSuccess(result, "advance schedule");
			if (normalizeChanges(result) === 0) {
				return null;
			}

			return fetchJobScheduleBy(db, "id = ?", [params.scheduleId]);
		},
	};
}
