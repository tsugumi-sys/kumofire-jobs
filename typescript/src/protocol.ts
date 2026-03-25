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
	scheduleType: JobScheduleType;
	scheduleExpr: string;
	timezone: string | null;
	nextRunAt: string | null;
	lastScheduledAt: string | null;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface JobRun<TPayload extends JsonValue = JsonValue> {
	id: string;
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
	jobRunId: string;
}

export interface CreateJobInput<TPayload extends JsonValue = JsonValue> {
	name: string;
	payload: TPayload;
	runAt?: Date;
	maxAttempts?: number;
	dedupeKey?: string;
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
	job: JobRun<TPayload>;
	now: Date;
}

export type JobHandler<TPayload extends JsonValue = JsonValue> = (
	context: JobHandlerContext<TPayload>,
) => Promise<void> | void;

export type JobHandlerMap = Record<string, JobHandler>;

export interface JobStorageAdapter {
	verifySchemaVersion?(): Promise<void>;
	createRun(jobRun: JobRun): Promise<JobRun>;
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
	generateId?: () => string;
}

export interface DispatchResult {
	dispatched: number;
}

export interface ConsumeResult {
	outcome: "ignored" | "succeeded" | "retried" | "failed" | "canceled";
	jobRunId: string;
}
