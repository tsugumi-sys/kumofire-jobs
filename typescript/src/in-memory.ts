import type {
	JobQueueAdapter,
	JobRun,
	JobRunMessage,
	JobStorageAdapter,
} from "./protocol";

export interface InMemoryStorageAdapter extends JobStorageAdapter {
	seed(jobRun: JobRun): Promise<void>;
}

export interface InMemoryQueueAdapter extends JobQueueAdapter {
	messages: JobRunMessage[];
}

export function createInMemoryStorageAdapter(): InMemoryStorageAdapter {
	const jobRuns = new Map<string, JobRun>();
	const dedupeIndex = new Map<string, string>();
	const locks = new Map<string, { leaseUntil: number }>();

	return {
		async seed(jobRun) {
			jobRuns.set(jobRun.id, { ...jobRun });
			if (jobRun.dedupeKey) {
				dedupeIndex.set(jobRun.dedupeKey, jobRun.id);
			}
		},

		async createRun(jobRun) {
			if (jobRun.dedupeKey) {
				const existingId = dedupeIndex.get(jobRun.dedupeKey);
				if (existingId) {
					const existingJob = jobRuns.get(existingId);
					if (existingJob) {
						return { ...existingJob };
					}
				}
				dedupeIndex.set(jobRun.dedupeKey, jobRun.id);
			}

			jobRuns.set(jobRun.id, { ...jobRun });
			return { ...jobRun };
		},

		async getRun(jobRunId) {
			const jobRun = jobRuns.get(jobRunId);
			return jobRun ? { ...jobRun } : null;
		},

		async getRunByDedupeKey(dedupeKey) {
			const jobRunId = dedupeIndex.get(dedupeKey);
			if (!jobRunId) {
				return null;
			}

			const jobRun = jobRuns.get(jobRunId);
			return jobRun ? { ...jobRun } : null;
		},

		async listDispatchableJobs({ now, limit }) {
			return [...jobRuns.values()]
				.filter(
					(jobRun) =>
						jobRun.status === "scheduled" &&
						jobRun.scheduledFor !== null &&
						new Date(jobRun.scheduledFor).getTime() <= now.getTime(),
				)
				.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
				.slice(0, limit)
				.map((jobRun) => ({ ...jobRun }));
		},

		async acquireLease({ jobRunId, now, leaseMs }) {
			const existing = locks.get(jobRunId);
			if (existing && existing.leaseUntil > now.getTime()) {
				return false;
			}

			locks.set(jobRunId, { leaseUntil: now.getTime() + leaseMs });
			return true;
		},

		async releaseLease(jobRunId) {
			locks.delete(jobRunId);
		},

		async markQueued({ jobRunId, now }) {
			const jobRun = jobRuns.get(jobRunId);
			if (!jobRun || jobRun.status !== "scheduled") {
				return null;
			}

			const updated: JobRun = {
				...jobRun,
				status: "queued",
				updatedAt: now.toISOString(),
			};
			jobRuns.set(jobRunId, updated);
			return { ...updated };
		},

		async markRunning({ jobRunId, now }) {
			const jobRun = jobRuns.get(jobRunId);
			if (!jobRun || jobRun.status !== "queued") {
				return null;
			}

			const updated: JobRun = {
				...jobRun,
				status: "running",
				startedAt: now.toISOString(),
				updatedAt: now.toISOString(),
			};
			jobRuns.set(jobRunId, updated);
			return { ...updated };
		},

		async markSucceeded({ jobRunId, now }) {
			const jobRun = jobRuns.get(jobRunId);
			if (!jobRun || jobRun.status !== "running") {
				return null;
			}

			const updated: JobRun = {
				...jobRun,
				status: "succeeded",
				finishedAt: now.toISOString(),
				updatedAt: now.toISOString(),
				lastError: null,
			};
			jobRuns.set(jobRunId, updated);
			return { ...updated };
		},

		async markRetryable({ jobRunId, now, nextRunAt, error }) {
			const jobRun = jobRuns.get(jobRunId);
			if (!jobRun || jobRun.status !== "running") {
				return null;
			}

			const updated: JobRun = {
				...jobRun,
				status: "scheduled",
				attempt: jobRun.attempt + 1,
				scheduledFor: nextRunAt.toISOString(),
				updatedAt: now.toISOString(),
				lastError: error,
			};
			jobRuns.set(jobRunId, updated);
			return { ...updated };
		},

		async markFailed({ jobRunId, now, error }) {
			const jobRun = jobRuns.get(jobRunId);
			if (
				!jobRun ||
				(jobRun.status !== "running" && jobRun.status !== "queued")
			) {
				return null;
			}

			const updated: JobRun = {
				...jobRun,
				status: "failed",
				attempt: jobRun.attempt + 1,
				finishedAt: now.toISOString(),
				updatedAt: now.toISOString(),
				lastError: error,
			};
			jobRuns.set(jobRunId, updated);
			return { ...updated };
		},
	};
}

export function createInMemoryQueueAdapter(): InMemoryQueueAdapter {
	const messages: JobRunMessage[] = [];

	return {
		messages,
		async send(message) {
			messages.push(message);
		},
	};
}
