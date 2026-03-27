export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
	| JsonPrimitive
	| JsonValue[]
	| { [key: string]: JsonValue };

export type JobRunStatus =
	| "scheduled"
	| "queued"
	| "running"
	| "succeeded"
	| "failed"
	| "canceled";

export interface JobDefinition {
	id: string;
	name: string;
	handler: string;
	payloadTemplate?: JsonValue;
	defaultOptions?: JsonValue;
	createdAt: string;
	updatedAt: string;
}

export type JobScheduleType = "once" | "interval" | "cron";

export interface JobSchedule {
	id: string;
	jobId: string;
	jobName: string;
	scheduleType: JobScheduleType;
	scheduleExpr: string;
	timezone: string | null;
	nextRunAt: string | null;
	lastScheduledAt: string | null;
	enabled: boolean;
	payload: JsonValue;
	maxAttempts: number;
	createdAt: string;
	updatedAt: string;
}

export interface JobRun<TPayload extends JsonValue = JsonValue> {
	id?: string;
	jobId: string;
	jobName: string;
	status: JobRunStatus;
	payload: TPayload;
	attempt: number;
	maxAttempts: number;
	scheduledFor: string | null;
	createdAt: string;
	updatedAt: string;
	startedAt: string | null;
	finishedAt: string | null;
	lastError: string | null;
	scheduleId?: string;
	dedupeKey?: string;
}

export interface JobRunStatusView {
	id: string;
	jobName: string;
	status: JobRunStatus;
	attempt: number;
	maxAttempts: number;
	scheduledFor: string | null;
	startedAt: string | null;
	finishedAt: string | null;
	lastError: string | null;
}

export interface JobRunMessage {
	version: 1;
	kumofireJobRunId: string;
}

export interface CreateJobInput<TPayload extends JsonValue = JsonValue> {
	name: string;
	payload: TPayload;
	runAt?: Date;
	maxAttempts?: number;
	dedupeKey?: string;
}

export interface CreateJobScheduleInput<
	TPayload extends JsonValue = JsonValue,
> {
	name: string;
	payload: TPayload;
	scheduleType: JobScheduleType;
	scheduleExpr: string;
	timezone?: string | null;
	maxAttempts?: number;
	enabled?: boolean;
}

export interface RetryPolicy {
	maxAttempts: number;
	getNextRunAt: (params: {
		attempt: number;
		error: unknown;
		job: JobRun;
		now: Date;
	}) => Date;
}

export interface JobHandlerContext<TPayload extends JsonValue = JsonValue> {
	definition: JobDefinition;
	job: JobRun<TPayload>;
	now: Date;
}

export type JobHandler<TPayload extends JsonValue = JsonValue> = (
	context: JobHandlerContext<TPayload>,
) => Promise<void> | void;

export type JobHandlerMap = Record<string, JobHandler>;

export interface JobStorageAdapter {
	verifySchemaVersion?(): Promise<void>;
	createDefinition?(definition: JobDefinition): Promise<JobDefinition>;
	getDefinition?(jobId: string): Promise<JobDefinition | null>;
	getDefinitionByName?(jobName: string): Promise<JobDefinition | null>;
	createSchedule?(schedule: Omit<JobSchedule, "id">): Promise<JobSchedule>;
	listDueSchedules?(params: {
		now: Date;
		limit: number;
	}): Promise<JobSchedule[]>;
	advanceSchedule?(params: {
		scheduleId: string;
		now: Date;
		lastScheduledAt: string;
		nextRunAt: string | null;
	}): Promise<JobSchedule | null>;
	createRun(jobRun: Omit<JobRun, "id">): Promise<JobRun>;
	getRun(jobRunId: string): Promise<JobRun | null>;
	getRunByDedupeKey(dedupeKey: string): Promise<JobRun | null>;
	listDispatchableJobs(params: { now: Date; limit: number }): Promise<JobRun[]>;
	acquireLease(params: {
		jobRunId: string;
		now: Date;
		leaseMs: number;
	}): Promise<boolean>;
	releaseLease(jobRunId: string): Promise<void>;
	markQueued(params: { jobRunId: string; now: Date }): Promise<JobRun | null>;
	markRunning(params: { jobRunId: string; now: Date }): Promise<JobRun | null>;
	markSucceeded(params: {
		jobRunId: string;
		now: Date;
	}): Promise<JobRun | null>;
	markRetryable(params: {
		jobRunId: string;
		now: Date;
		nextRunAt: Date;
		error: string;
	}): Promise<JobRun | null>;
	markFailed(params: {
		jobRunId: string;
		now: Date;
		error: string;
	}): Promise<JobRun | null>;
}

export interface JobQueueAdapter {
	send(message: JobRunMessage): Promise<void>;
}

export interface CreateJobsOptions<THandlers extends JobHandlerMap> {
	storage: JobStorageAdapter;
	queue: JobQueueAdapter;
	handlers: THandlers;
	retry?: Partial<RetryPolicy>;
	leaseMs?: number;
	now?: () => Date;
}

export interface DispatchResult {
	dispatched: number;
}

export interface ConsumeResult {
	outcome: "ignored" | "succeeded" | "retried" | "failed" | "canceled";
	jobRunId: string;
}
