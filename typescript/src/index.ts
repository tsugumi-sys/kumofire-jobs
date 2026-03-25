import type {
	ConsumeResult,
	CreateJobInput,
	CreateJobsOptions,
	DispatchResult,
	JobDefinition,
	JobHandlerMap,
	JobRun,
	JobRunMessage,
	JobRunStatusView,
	JsonValue,
	RetryPolicy,
} from "./protocol";

const DEFAULT_LEASE_MS = 30_000;
const MESSAGE_VERSION = 1 as const;

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

function toStatusView(jobRun: JobRun): JobRunStatusView {
	return {
		id: jobRun.id,
		jobName: jobRun.jobName,
		status: jobRun.status,
		attempt: jobRun.attempt,
		maxAttempts: jobRun.maxAttempts,
		scheduledFor: jobRun.scheduledFor,
		startedAt: jobRun.startedAt,
		finishedAt: jobRun.finishedAt,
		lastError: jobRun.lastError,
	};
}

function buildDefinitions<THandlers extends JobHandlerMap>(
	handlers: THandlers,
): Map<string, JobDefinition> {
	const definitions = new Map<string, JobDefinition>();
	const timestamp = new Date(0).toISOString();

	for (const jobName of Object.keys(handlers)) {
		definitions.set(jobName, {
			id: jobName,
			name: jobName,
			handler: jobName,
			createdAt: timestamp,
			updatedAt: timestamp,
		});
	}

	return definitions;
}

export function createJobs<THandlers extends JobHandlerMap>(
	options: CreateJobsOptions<THandlers>,
) {
	const retry = resolveRetryPolicy(options.retry);
	const getNow = options.now ?? (() => new Date());
	const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
	const definitions = buildDefinitions(options.handlers);
	let schemaVerification: Promise<void> | undefined;
	let definitionsSynchronization: Promise<void> | undefined;

	function ensureSchemaVersion(): Promise<void> {
		if (!options.storage.verifySchemaVersion) {
			return Promise.resolve();
		}

		if (!schemaVerification) {
			schemaVerification = options.storage.verifySchemaVersion();
		}

		return schemaVerification;
	}

	async function synchronizeDefinitions(): Promise<void> {
		if (!options.storage.createDefinition) {
			return;
		}

		for (const definition of definitions.values()) {
			await options.storage.createDefinition(definition);
		}
	}

	function ensureDefinitions(): Promise<void> {
		if (!definitionsSynchronization) {
			definitionsSynchronization = synchronizeDefinitions();
		}

		return definitionsSynchronization;
	}

	async function resolveDefinitionByName(
		jobName: string,
	): Promise<JobDefinition> {
		const inMemoryDefinition = definitions.get(jobName);
		if (!inMemoryDefinition) {
			throw new Error(`Missing job definition for "${jobName}"`);
		}

		if (options.storage.getDefinitionByName) {
			const storedDefinition =
				await options.storage.getDefinitionByName(jobName);
			if (storedDefinition) {
				return storedDefinition;
			}
		}

		return inMemoryDefinition;
	}

	async function resolveDefinitionForRun(
		jobRun: JobRun,
	): Promise<JobDefinition> {
		if (options.storage.getDefinition) {
			const storedDefinition = await options.storage.getDefinition(
				jobRun.jobId,
			);
			if (storedDefinition) {
				return storedDefinition;
			}
		}

		const fallbackDefinition = definitions.get(jobRun.jobName);
		if (!fallbackDefinition) {
			throw new Error(`Missing job definition for "${jobRun.jobName}"`);
		}

		return fallbackDefinition;
	}

	return {
		async create<TPayload extends JsonValue>(
			input: CreateJobInput<TPayload>,
		): Promise<{ jobId: string }> {
			await ensureSchemaVersion();
			await ensureDefinitions();

			if (input.dedupeKey) {
				const existingJob = await options.storage.getRunByDedupeKey(
					input.dedupeKey,
				);

				if (existingJob) {
					return { jobId: existingJob.id };
				}
			}

			const now = getNow();
			const nextRunAt = input.runAt ?? now;
			const definition = await resolveDefinitionByName(input.name);
			const jobRun = await options.storage.createRun({
				jobId: definition.id,
				jobName: definition.name,
				status: "scheduled",
				payload: input.payload,
				attempt: 0,
				maxAttempts: input.maxAttempts ?? retry.maxAttempts,
				scheduledFor: nextRunAt.toISOString(),
				createdAt: now.toISOString(),
				updatedAt: now.toISOString(),
				startedAt: null,
				finishedAt: null,
				lastError: null,
				...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
			});

			if (nextRunAt.getTime() <= now.getTime()) {
				const queuedJob = await options.storage.markQueued({
					jobRunId: jobRun.id,
					now,
				});
				if (queuedJob) {
					await options.queue.send({
						version: MESSAGE_VERSION,
						jobRunId: jobRun.id,
					});
				}
			}

			return { jobId: jobRun.id };
		},

		async dispatch(input?: { limit?: number }): Promise<DispatchResult> {
			await ensureSchemaVersion();
			await ensureDefinitions();

			const now = getNow();
			const limit = input?.limit ?? 100;
			const jobRuns = await options.storage.listDispatchableJobs({
				now,
				limit,
			});

			for (const jobRun of jobRuns) {
				const queuedJob = await options.storage.markQueued({
					jobRunId: jobRun.id,
					now,
				});
				if (!queuedJob) {
					continue;
				}
				await options.queue.send({
					version: MESSAGE_VERSION,
					jobRunId: jobRun.id,
				});
			}

			return { dispatched: jobRuns.length };
		},

		async consume(message: JobRunMessage): Promise<ConsumeResult> {
			await ensureSchemaVersion();
			await ensureDefinitions();

			if (message.version !== MESSAGE_VERSION) {
				throw new Error(`Unsupported job message version: ${message.version}`);
			}

			const now = getNow();
			const jobRun = await options.storage.getRun(message.jobRunId);

			if (!jobRun || jobRun.status === "canceled") {
				return { outcome: "ignored", jobRunId: message.jobRunId };
			}

			const acquired = await options.storage.acquireLease({
				jobRunId: jobRun.id,
				now,
				leaseMs,
			});

			if (!acquired) {
				return { outcome: "ignored", jobRunId: jobRun.id };
			}

			try {
				const runningJob = await options.storage.markRunning({
					jobRunId: jobRun.id,
					now,
				});

				if (!runningJob) {
					return { outcome: "ignored", jobRunId: jobRun.id };
				}

				const handler = options.handlers[runningJob.jobName];
				const definition = await resolveDefinitionForRun(runningJob);

				if (!handler) {
					const missingHandlerError = `Missing handler for job "${runningJob.jobName}"`;
					await options.storage.markFailed({
						jobRunId: runningJob.id,
						now,
						error: missingHandlerError,
					});
					return { outcome: "failed", jobRunId: runningJob.id };
				}

				try {
					await handler({ definition, job: runningJob, now });
					await options.storage.markSucceeded({
						jobRunId: runningJob.id,
						now,
					});
					return { outcome: "succeeded", jobRunId: runningJob.id };
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
							jobRunId: runningJob.id,
							now,
							nextRunAt,
							error: errorMessage,
						});
						return { outcome: "retried", jobRunId: runningJob.id };
					}

					await options.storage.markFailed({
						jobRunId: runningJob.id,
						now,
						error: errorMessage,
					});
					return { outcome: "failed", jobRunId: runningJob.id };
				}
			} finally {
				await options.storage.releaseLease(jobRun.id);
			}
		},

		async getStatus(jobId: string): Promise<JobRunStatusView | null> {
			await ensureSchemaVersion();
			await ensureDefinitions();

			const jobRun = await options.storage.getRun(jobId);
			return jobRun ? toStatusView(jobRun) : null;
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
	JobDefinition,
	JobHandler,
	JobHandlerContext,
	JobHandlerMap,
	JobQueueAdapter,
	JobRun,
	JobRunMessage,
	JobRunStatus,
	JobRunStatusView,
	JobSchedule,
	JobScheduleType,
	JobStorageAdapter,
	JsonPrimitive,
	JsonValue,
	RetryPolicy,
} from "./protocol";
