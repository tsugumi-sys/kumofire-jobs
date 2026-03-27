import { getNextCronOccurrence } from "./cron";
import type {
	ConsumeResult,
	CreateJobInput,
	CreateJobScheduleInput,
	CreateJobsOptions,
	DispatchResult,
	JobDefinition,
	JobHandlerMap,
	JobRun,
	JobRunMessage,
	JobRunStatusView,
	JobSchedule,
	JsonValue,
	RetryPolicy,
} from "./protocol";

const DEFAULT_LEASE_MS = 30_000;
export const jobMessageVersion = 1 as const;

type StoredJobRun = JobRun & { id: string };
type StoredJobSchedule = JobSchedule & { id: string };

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

function requireJobRunId(jobRun: JobRun): string {
	if (!jobRun.id) {
		throw new Error("Job run is missing id");
	}

	return jobRun.id;
}

function requireStoredJobRun(jobRun: JobRun): StoredJobRun {
	const id = requireJobRunId(jobRun);
	return { ...jobRun, id };
}

function toStatusView(jobRun: StoredJobRun): JobRunStatusView {
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

function requireScheduleId(jobSchedule: JobSchedule): string {
	if (!jobSchedule.id) {
		throw new Error("Job schedule is missing id");
	}

	return jobSchedule.id;
}

function requireStoredJobSchedule(jobSchedule: JobSchedule): StoredJobSchedule {
	const id = requireScheduleId(jobSchedule);
	return { ...jobSchedule, id };
}

function requireScheduleSupport(
	options: CreateJobsOptions<JobHandlerMap>,
): asserts options is CreateJobsOptions<JobHandlerMap> & {
	storage: NonNullable<
		Pick<
			CreateJobsOptions<JobHandlerMap>["storage"],
			"createSchedule" | "listDueSchedules" | "advanceSchedule"
		>
	> &
		CreateJobsOptions<JobHandlerMap>["storage"];
} {
	if (
		!options.storage.createSchedule ||
		!options.storage.listDueSchedules ||
		!options.storage.advanceSchedule
	) {
		throw new Error(
			"Job schedule support is not available for this storage adapter",
		);
	}
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
		): Promise<{ kumofireJobRunId: string }> {
			await ensureSchemaVersion();
			await ensureDefinitions();

			if (input.dedupeKey) {
				const existingJob = await options.storage.getRunByDedupeKey(
					input.dedupeKey,
				);

				if (existingJob) {
					return { kumofireJobRunId: requireJobRunId(existingJob) };
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
			const storedJobRun = requireStoredJobRun(jobRun);

			if (nextRunAt.getTime() <= now.getTime()) {
				const queuedJob = await options.storage.markQueued({
					jobRunId: storedJobRun.id,
					now,
				});
				if (queuedJob) {
					await options.queue.send({
						version: jobMessageVersion,
						kumofireJobRunId: storedJobRun.id,
					});
				}
			}

			return { kumofireJobRunId: storedJobRun.id };
		},

		async createSchedule<TPayload extends JsonValue>(
			input: CreateJobScheduleInput<TPayload>,
		): Promise<{ scheduleId: string }> {
			await ensureSchemaVersion();
			await ensureDefinitions();
			requireScheduleSupport(options);

			if (input.scheduleType !== "cron") {
				throw new Error(
					`Unsupported schedule type "${input.scheduleType}". Only "cron" is currently implemented.`,
				);
			}

			const now = getNow();
			const definition = await resolveDefinitionByName(input.name);
			const createSchedule = options.storage.createSchedule;
			if (!createSchedule) {
				throw new Error(
					"Job schedule support is not available for this storage adapter",
				);
			}
			const nextRunAt =
				input.enabled === false
					? null
					: getNextCronOccurrence(
							input.scheduleExpr,
							now,
							input.timezone ?? null,
						).toISOString();
			const schedule = await createSchedule({
				jobId: definition.id,
				jobName: definition.name,
				scheduleType: input.scheduleType,
				scheduleExpr: input.scheduleExpr,
				timezone: input.timezone ?? null,
				nextRunAt,
				lastScheduledAt: null,
				enabled: input.enabled ?? true,
				payload: input.payload,
				maxAttempts: input.maxAttempts ?? retry.maxAttempts,
				createdAt: now.toISOString(),
				updatedAt: now.toISOString(),
			});

			return { scheduleId: requireScheduleId(schedule) };
		},

		async dispatch(input?: { limit?: number }): Promise<DispatchResult> {
			await ensureSchemaVersion();
			await ensureDefinitions();

			const now = getNow();
			const limit = input?.limit ?? 100;
			let dispatched = 0;

			if (options.storage.listDueSchedules && options.storage.advanceSchedule) {
				const schedules = await options.storage.listDueSchedules({
					now,
					limit,
				});

				for (const schedule of schedules) {
					const storedSchedule = requireStoredJobSchedule(schedule);
					if (storedSchedule.nextRunAt === null) {
						continue;
					}

					const scheduledFor = storedSchedule.nextRunAt;
					const nextRunAt =
						storedSchedule.scheduleType === "cron"
							? getNextCronOccurrence(
									storedSchedule.scheduleExpr,
									new Date(scheduledFor),
									storedSchedule.timezone,
								).toISOString()
							: null;
					const advancedSchedule = await options.storage.advanceSchedule({
						scheduleId: storedSchedule.id,
						now,
						lastScheduledAt: scheduledFor,
						nextRunAt,
					});

					if (!advancedSchedule) {
						continue;
					}

					const createdRun = await options.storage.createRun({
						jobId: storedSchedule.jobId,
						jobName: storedSchedule.jobName,
						status: "scheduled",
						payload: storedSchedule.payload,
						attempt: 0,
						maxAttempts: storedSchedule.maxAttempts,
						scheduledFor,
						createdAt: now.toISOString(),
						updatedAt: now.toISOString(),
						startedAt: null,
						finishedAt: null,
						lastError: null,
						scheduleId: storedSchedule.id,
					});
					const storedRun = requireStoredJobRun(createdRun);
					const queuedRun = await options.storage.markQueued({
						jobRunId: storedRun.id,
						now,
					});

					if (!queuedRun) {
						continue;
					}

					await options.queue.send({
						version: jobMessageVersion,
						kumofireJobRunId: storedRun.id,
					});
					dispatched += 1;
				}
			}

			const jobRuns = await options.storage.listDispatchableJobs({
				now,
				limit,
			});

			for (const jobRun of jobRuns) {
				const storedJobRun = requireStoredJobRun(jobRun);
				const queuedJob = await options.storage.markQueued({
					jobRunId: storedJobRun.id,
					now,
				});
				if (!queuedJob) {
					continue;
				}
				await options.queue.send({
					version: jobMessageVersion,
					kumofireJobRunId: storedJobRun.id,
				});
				dispatched += 1;
			}

			return { dispatched };
		},

		async consume(message: JobRunMessage): Promise<ConsumeResult> {
			await ensureSchemaVersion();
			await ensureDefinitions();

			if (message.version !== jobMessageVersion) {
				throw new Error(`Unsupported job message version: ${message.version}`);
			}

			const now = getNow();
			const jobRun = await options.storage.getRun(message.kumofireJobRunId);

			if (!jobRun || jobRun.status === "canceled") {
				return { outcome: "ignored", jobRunId: message.kumofireJobRunId };
			}
			const storedJobRun = requireStoredJobRun(jobRun);

			const acquired = await options.storage.acquireLease({
				jobRunId: storedJobRun.id,
				now,
				leaseMs,
			});

			if (!acquired) {
				return { outcome: "ignored", jobRunId: storedJobRun.id };
			}

			try {
				const runningJob = await options.storage.markRunning({
					jobRunId: storedJobRun.id,
					now,
				});

				if (!runningJob) {
					return { outcome: "ignored", jobRunId: storedJobRun.id };
				}
				const storedRunningJob = requireStoredJobRun(runningJob);

				const handler = options.handlers[storedRunningJob.jobName];
				const definition = await resolveDefinitionForRun(storedRunningJob);

				if (!handler) {
					const missingHandlerError = `Missing handler for job "${storedRunningJob.jobName}"`;
					await options.storage.markFailed({
						jobRunId: storedRunningJob.id,
						now,
						error: missingHandlerError,
					});
					return { outcome: "failed", jobRunId: storedRunningJob.id };
				}

				try {
					await handler({ definition, job: storedRunningJob, now });
					await options.storage.markSucceeded({
						jobRunId: storedRunningJob.id,
						now,
					});
					return { outcome: "succeeded", jobRunId: storedRunningJob.id };
				} catch (error) {
					const errorMessage = serializeError(error);
					const nextAttempt = storedRunningJob.attempt + 1;

					if (nextAttempt < storedRunningJob.maxAttempts) {
						const nextRunAt = retry.getNextRunAt({
							attempt: nextAttempt,
							error,
							job: storedRunningJob,
							now,
						});

						await options.storage.markRetryable({
							jobRunId: storedRunningJob.id,
							now,
							nextRunAt,
							error: errorMessage,
						});
						return { outcome: "retried", jobRunId: storedRunningJob.id };
					}

					await options.storage.markFailed({
						jobRunId: storedRunningJob.id,
						now,
						error: errorMessage,
					});
					return { outcome: "failed", jobRunId: storedRunningJob.id };
				}
			} finally {
				await options.storage.releaseLease(storedJobRun.id);
			}
		},

		async getStatus(
			kumofireJobRunId: string,
		): Promise<JobRunStatusView | null> {
			await ensureSchemaVersion();
			await ensureDefinitions();

			const jobRun = await options.storage.getRun(kumofireJobRunId);
			return jobRun ? toStatusView(requireStoredJobRun(jobRun)) : null;
		},
	};
}
