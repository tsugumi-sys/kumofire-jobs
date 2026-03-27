import type {
	JobDefinition,
	JobRun,
	JobRunStatus,
	JobSchedule,
	JobScheduleType,
	JsonValue,
} from "../../protocol";
import type { D1Database, D1RunResult } from "../types";

export interface D1DefinitionRow {
	id: string;
	name: string;
	handler: string;
	payload_template: string | null;
	default_options: string | null;
	created_at: string;
	updated_at: string;
}

export interface D1JobRunRow {
	id: string;
	job_id: string;
	job_schedule_id: string | null;
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

export interface D1JobScheduleRow {
	id: string;
	job_id: string;
	job_name: string;
	schedule_type: JobScheduleType;
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

export function normalizeChanges(result: D1RunResult): number {
	return result.meta?.changes ?? result.meta?.rows_written ?? 0;
}

export function serializePayload(payload: JsonValue): string {
	return JSON.stringify(payload);
}

function parsePayload(payload: string): JsonValue {
	return JSON.parse(payload) as JsonValue;
}

export function mapDefinitionRow(row: D1DefinitionRow): JobDefinition {
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

export function mapJobRunRow(row: D1JobRunRow): JobRun {
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
		...(row.job_schedule_id ? { scheduleId: row.job_schedule_id } : {}),
		...(row.dedupe_key ? { dedupeKey: row.dedupe_key } : {}),
	};
}

export function mapJobScheduleRow(row: D1JobScheduleRow): JobSchedule {
	return {
		id: row.id,
		jobId: row.job_id,
		jobName: row.job_name,
		scheduleType: row.schedule_type,
		scheduleExpr: row.schedule_expr,
		timezone: row.timezone,
		nextRunAt: row.next_run_at,
		lastScheduledAt: row.last_scheduled_at,
		enabled: row.enabled === 1,
		payload: parsePayload(row.payload),
		maxAttempts: row.max_attempts,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export function requireSuccess(result: D1RunResult, operation: string): void {
	if (!result.success) {
		throw new Error(`D1 ${operation} failed`);
	}
}

export async function fetchDefinitionBy(
	db: D1Database,
	whereClause: string,
	values: unknown[],
): Promise<JobDefinition | null> {
	const row = await db
		.prepare(`SELECT
\tid,
\tname,
\thandler,
\tpayload_template,
\tdefault_options,
\tcreated_at,
\tupdated_at
FROM kumofire_job_definitions
WHERE ${whereClause}
LIMIT 1`)
		.bind(...values)
		.first<D1DefinitionRow>();

	return row ? mapDefinitionRow(row) : null;
}

export async function fetchJobRunBy(
	db: D1Database,
	whereClause: string,
	values: unknown[],
): Promise<JobRun | null> {
	const row = await db
		.prepare(`SELECT
\tid,
\tjob_id,
\tjob_schedule_id,
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
WHERE ${whereClause}
LIMIT 1`)
		.bind(...values)
		.first<D1JobRunRow>();

	return row ? mapJobRunRow(row) : null;
}

export async function fetchJobScheduleBy(
	db: D1Database,
	whereClause: string,
	values: unknown[],
): Promise<JobSchedule | null> {
	const row = await db
		.prepare(`SELECT
\tid,
\tjob_id,
\tjob_name,
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
WHERE ${whereClause}
LIMIT 1`)
		.bind(...values)
		.first<D1JobScheduleRow>();

	return row ? mapJobScheduleRow(row) : null;
}
