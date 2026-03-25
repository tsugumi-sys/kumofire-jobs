import type {
	ConsumeResult,
	CreateJobInput,
	CreateJobsOptions,
	DispatchResult,
	JobHandlerMap,
	JobMessage,
	JobRecord,
	JobStatusView,
	JsonValue,
	RetryPolicy,
} from "./protocol";

const DEFAULT_LEASE_MS = 30_000;
const MESSAGE_VERSION = 1 as const;

function createIdFactory(): () => string {
	let sequence = 0;

	return () => {
		sequence += 1;
		return `job_${Date.now()}_${sequence}`;
	};
}

function defaultRetryPolicy(): RetryPolicy {
	return {
		maxAttempts: 3,
		getNextRunAt: ({ attempt, now }) =>
			new Date(
				now.getTime() + Math.min(2 ** Math.max(attempt - 1, 0) * 1_000, 60_000),
			),
	};
}

function resolveRetryPolicy(
	retry: Partial<RetryPolicy> | undefined,
): RetryPolicy {
	const defaults = defaultRetryPolicy();

	return {
		maxAttempts: retry?.maxAttempts ?? defaults.maxAttempts,
		getNextRunAt: retry?.getNextRunAt ?? defaults.getNextRunAt,
	};
}

function serializeError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
}

function toStatusView(job: JobRecord): JobStatusView {
	return {
		id: job.id,
		name: job.name,
		status: job.status,
		attempt: job.attempt,
		maxAttempts: job.maxAttempts,
		nextRunAt: job.nextRunAt,
		startedAt: job.startedAt,
		finishedAt: job.finishedAt,
		lastError: job.lastError,
	};
}

export function createJobs<THandlers extends JobHandlerMap>(
	options: CreateJobsOptions<THandlers>,
) {
	const retry = resolveRetryPolicy(options.retry);
	const getNow = options.now ?? (() => new Date());
	const generateId = options.generateId ?? createIdFactory();
	const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
	let schemaVerification: Promise<void> | undefined;

	function ensureSchemaVersion(): Promise<void> {
		if (!options.storage.verifySchemaVersion) {
			return Promise.resolve();
		}

		if (!schemaVerification) {
			schemaVerification = options.storage.verifySchemaVersion();
		}

		return schemaVerification;
	}

	return {
		async create<TPayload extends JsonValue>(
			input: CreateJobInput<TPayload>,
		): Promise<{ jobId: string }> {
			await ensureSchemaVersion();

			if (input.dedupeKey) {
				const existingJob = await options.storage.getJobByDedupeKey(
					input.dedupeKey,
				);

				if (existingJob) {
					return { jobId: existingJob.id };
				}
			}

			const now = getNow();
			const nextRunAt = input.runAt ?? now;
			const job: JobRecord<TPayload> = {
				id: generateId(),
				name: input.name,
				status: "queued",
				payload: input.payload,
				attempt: 0,
				maxAttempts: input.maxAttempts ?? retry.maxAttempts,
				nextRunAt: nextRunAt.toISOString(),
				createdAt: now.toISOString(),
				updatedAt: now.toISOString(),
				startedAt: null,
				finishedAt: null,
				lastError: null,
				...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
			};

			await options.storage.createJob(job);

			if (nextRunAt.getTime() <= now.getTime()) {
				await options.queue.send({ version: MESSAGE_VERSION, jobId: job.id });
			}

			return { jobId: job.id };
		},

		async dispatch(input?: { limit?: number }): Promise<DispatchResult> {
			await ensureSchemaVersion();

			const now = getNow();
			const limit = input?.limit ?? 100;
			const jobs = await options.storage.listDispatchableJobs({ now, limit });

			for (const job of jobs) {
				await options.queue.send({ version: MESSAGE_VERSION, jobId: job.id });
			}

			return { dispatched: jobs.length };
		},

		async consume(message: JobMessage): Promise<ConsumeResult> {
			await ensureSchemaVersion();

			if (message.version !== MESSAGE_VERSION) {
				throw new Error(`Unsupported job message version: ${message.version}`);
			}

			const now = getNow();
			const job = await options.storage.getJob(message.jobId);

			if (!job || job.status === "canceled") {
				return { outcome: "ignored", jobId: message.jobId };
			}

			const acquired = await options.storage.acquireLease({
				jobId: job.id,
				now,
				leaseMs,
			});

			if (!acquired) {
				return { outcome: "ignored", jobId: job.id };
			}

			try {
				const runningJob = await options.storage.markRunning({
					jobId: job.id,
					now,
				});

				if (!runningJob) {
					return { outcome: "ignored", jobId: job.id };
				}

				const handler = options.handlers[runningJob.name];

				if (!handler) {
					const missingHandlerError = `Missing handler for job "${runningJob.name}"`;
					await options.storage.markFailed({
						jobId: runningJob.id,
						now,
						error: missingHandlerError,
					});
					return { outcome: "failed", jobId: runningJob.id };
				}

				try {
					await handler({ job: runningJob, now });
					await options.storage.markSucceeded({ jobId: runningJob.id, now });
					return { outcome: "succeeded", jobId: runningJob.id };
				} catch (error) {
					const errorMessage = serializeError(error);
					const nextAttempt = runningJob.attempt + 1;

					if (nextAttempt < runningJob.maxAttempts) {
						const nextRunAt = retry.getNextRunAt({
							attempt: nextAttempt,
							error,
							job: runningJob,
							now,
						});

						await options.storage.markRetryable({
							jobId: runningJob.id,
							now,
							nextRunAt,
							error: errorMessage,
						});
						return { outcome: "retried", jobId: runningJob.id };
					}

					await options.storage.markFailed({
						jobId: runningJob.id,
						now,
						error: errorMessage,
					});
					return { outcome: "failed", jobId: runningJob.id };
				}
			} finally {
				await options.storage.releaseLease(job.id);
			}
		},

		async getStatus(jobId: string): Promise<JobStatusView | null> {
			await ensureSchemaVersion();

			const job = await options.storage.getJob(jobId);
			return job ? toStatusView(job) : null;
		},
	};
}

export type {
	CloudflareQueue,
	D1Database,
	D1PreparedStatement,
	D1RunMeta,
	D1RunResult,
} from "./cloudflare";
export {
	createCloudflareQueueAdapter,
	createD1StorageAdapter,
	getReferenceSchemaSql,
	requiredSchemaVersion,
	schemaMigrations,
} from "./cloudflare";
export type { InMemoryQueueAdapter, InMemoryStorageAdapter } from "./in-memory";
export {
	createInMemoryQueueAdapter,
	createInMemoryStorageAdapter,
} from "./in-memory";
export type {
	ConsumeResult,
	CreateJobInput,
	CreateJobsOptions,
	DispatchResult,
	JobHandler,
	JobHandlerContext,
	JobHandlerMap,
	JobMessage,
	JobQueueAdapter,
	JobRecord,
	JobStatus,
	JobStatusView,
	JobStorageAdapter,
	JsonPrimitive,
	JsonValue,
	RetryPolicy,
} from "./protocol";
