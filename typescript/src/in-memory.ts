import type {
	JobMessage,
	JobQueueAdapter,
	JobRecord,
	JobStorageAdapter,
} from "./protocol";

export interface InMemoryStorageAdapter extends JobStorageAdapter {
	seed(job: JobRecord): Promise<void>;
}

export interface InMemoryQueueAdapter extends JobQueueAdapter {
	messages: JobMessage[];
}

export function createInMemoryStorageAdapter(): InMemoryStorageAdapter {
	const jobs = new Map<string, JobRecord>();
	const dedupeIndex = new Map<string, string>();
	const locks = new Map<string, { leaseUntil: number }>();

	return {
		async seed(job) {
			jobs.set(job.id, { ...job });
			if (job.dedupeKey) {
				dedupeIndex.set(job.dedupeKey, job.id);
			}
		},

		async createJob(job) {
			if (job.dedupeKey) {
				const existingId = dedupeIndex.get(job.dedupeKey);
				if (existingId) {
					const existingJob = jobs.get(existingId);
					if (existingJob) {
						return { ...existingJob };
					}
				}
				dedupeIndex.set(job.dedupeKey, job.id);
			}

			jobs.set(job.id, { ...job });
			return { ...job };
		},

		async getJob(jobId) {
			const job = jobs.get(jobId);
			return job ? { ...job } : null;
		},

		async getJobByDedupeKey(dedupeKey) {
			const jobId = dedupeIndex.get(dedupeKey);
			if (!jobId) {
				return null;
			}

			const job = jobs.get(jobId);
			return job ? { ...job } : null;
		},

		async listDispatchableJobs({ now, limit }) {
			return [...jobs.values()]
				.filter(
					(job) =>
						job.status === "queued" &&
						job.nextRunAt !== null &&
						new Date(job.nextRunAt).getTime() <= now.getTime(),
				)
				.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
				.slice(0, limit)
				.map((job) => ({ ...job }));
		},

		async acquireLease({ jobId, now, leaseMs }) {
			const existing = locks.get(jobId);
			if (existing && existing.leaseUntil > now.getTime()) {
				return false;
			}

			locks.set(jobId, { leaseUntil: now.getTime() + leaseMs });
			return true;
		},

		async releaseLease(jobId) {
			locks.delete(jobId);
		},

		async markRunning({ jobId, now }) {
			const job = jobs.get(jobId);
			if (!job || job.status !== "queued") {
				return null;
			}

			const updated: JobRecord = {
				...job,
				status: "running",
				startedAt: now.toISOString(),
				updatedAt: now.toISOString(),
			};
			jobs.set(jobId, updated);
			return { ...updated };
		},

		async markSucceeded({ jobId, now }) {
			const job = jobs.get(jobId);
			if (!job || job.status !== "running") {
				return null;
			}

			const updated: JobRecord = {
				...job,
				status: "succeeded",
				finishedAt: now.toISOString(),
				updatedAt: now.toISOString(),
				lastError: null,
			};
			jobs.set(jobId, updated);
			return { ...updated };
		},

		async markRetryable({ jobId, now, nextRunAt, error }) {
			const job = jobs.get(jobId);
			if (!job || job.status !== "running") {
				return null;
			}

			const updated: JobRecord = {
				...job,
				status: "queued",
				attempt: job.attempt + 1,
				nextRunAt: nextRunAt.toISOString(),
				updatedAt: now.toISOString(),
				lastError: error,
			};
			jobs.set(jobId, updated);
			return { ...updated };
		},

		async markFailed({ jobId, now, error }) {
			const job = jobs.get(jobId);
			if (!job || (job.status !== "running" && job.status !== "queued")) {
				return null;
			}

			const updated: JobRecord = {
				...job,
				status: "failed",
				attempt: job.attempt + 1,
				finishedAt: now.toISOString(),
				updatedAt: now.toISOString(),
				lastError: error,
			};
			jobs.set(jobId, updated);
			return { ...updated };
		},
	};
}

export function createInMemoryQueueAdapter(): InMemoryQueueAdapter {
	const messages: JobMessage[] = [];

	return {
		messages,
		async send(message) {
			messages.push(message);
		},
	};
}
