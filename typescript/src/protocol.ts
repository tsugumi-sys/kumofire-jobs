export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
	| JsonPrimitive
	| JsonValue[]
	| { [key: string]: JsonValue };

export type JobStatus =
	| "queued"
	| "running"
	| "succeeded"
	| "failed"
	| "canceled";

export interface JobRecord<TPayload extends JsonValue = JsonValue> {
	id: string;
	name: string;
	status: JobStatus;
	payload: TPayload;
	attempt: number;
	maxAttempts: number;
	nextRunAt: string | null;
	createdAt: string;
	updatedAt: string;
	startedAt: string | null;
	finishedAt: string | null;
	lastError: string | null;
	dedupeKey?: string;
}

export interface JobStatusView {
	id: string;
	name: string;
	status: JobStatus;
	attempt: number;
	maxAttempts: number;
	nextRunAt: string | null;
	startedAt: string | null;
	finishedAt: string | null;
	lastError: string | null;
}

export interface JobMessage {
	version: 1;
	jobId: string;
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
		job: JobRecord;
		now: Date;
	}) => Date;
}

export interface JobHandlerContext<TPayload extends JsonValue = JsonValue> {
	job: JobRecord<TPayload>;
	now: Date;
}

export type JobHandler<TPayload extends JsonValue = JsonValue> = (
	context: JobHandlerContext<TPayload>,
) => Promise<void> | void;

export type JobHandlerMap = Record<string, JobHandler>;

export interface JobStorageAdapter {
	verifySchemaVersion?(): Promise<void>;
	createJob(job: JobRecord): Promise<JobRecord>;
	getJob(jobId: string): Promise<JobRecord | null>;
	getJobByDedupeKey(dedupeKey: string): Promise<JobRecord | null>;
	listDispatchableJobs(params: {
		now: Date;
		limit: number;
	}): Promise<JobRecord[]>;
	acquireLease(params: {
		jobId: string;
		now: Date;
		leaseMs: number;
	}): Promise<boolean>;
	releaseLease(jobId: string): Promise<void>;
	markRunning(params: { jobId: string; now: Date }): Promise<JobRecord | null>;
	markSucceeded(params: {
		jobId: string;
		now: Date;
	}): Promise<JobRecord | null>;
	markRetryable(params: {
		jobId: string;
		now: Date;
		nextRunAt: Date;
		error: string;
	}): Promise<JobRecord | null>;
	markFailed(params: {
		jobId: string;
		now: Date;
		error: string;
	}): Promise<JobRecord | null>;
}

export interface JobQueueAdapter {
	send(message: JobMessage): Promise<void>;
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
	jobId: string;
}
