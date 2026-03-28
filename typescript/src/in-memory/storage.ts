import type {
	JobDefinition,
	JobRun,
	JobSchedule,
	JobStorageAdapter,
} from "../protocol";

type StoredJobRun = JobRun & { id: string };
type StoredJobSchedule = JobSchedule & { id: string };

export interface InMemoryStorageAdapter extends JobStorageAdapter {
	seedDefinition(definition: JobDefinition): Promise<void>;
	seed(jobRun: StoredJobRun): Promise<void>;
	seedSchedule(schedule: StoredJobSchedule): Promise<void>;
}

export function createInMemoryStorageAdapter(): InMemoryStorageAdapter {
	let sequence = 0;
	let scheduleSequence = 0;
	const definitions = new Map<string, JobDefinition>();
	const definitionsByName = new Map<string, string>();
	const schedules = new Map<string, StoredJobSchedule>();
	const schedulesByKey = new Map<string, string>();
	const jobRuns = new Map<string, StoredJobRun>();
	const dedupeIndex = new Map<string, string>();
	const locks = new Map<string, { leaseUntil: number }>();

	function generateRunId(): string {
		sequence += 1;
		return `job_run_${sequence}`;
	}

	function generateScheduleId(): string {
		scheduleSequence += 1;
		return `job_schedule_${scheduleSequence}`;
	}

	return {
		async seedDefinition(definition) {
			definitions.set(definition.id, { ...definition });
			definitionsByName.set(definition.name, definition.id);
		},

		async seed(jobRun) {
			jobRuns.set(jobRun.id, { ...jobRun });
			if (jobRun.dedupeKey) {
				dedupeIndex.set(jobRun.dedupeKey, jobRun.id);
			}
		},

		async seedSchedule(schedule) {
			schedules.set(schedule.id, { ...schedule });
			if (schedule.scheduleKey) {
				schedulesByKey.set(schedule.scheduleKey, schedule.id);
			}
		},

		async createDefinition(definition) {
			const existingId = definitionsByName.get(definition.name);
			if (existingId) {
				const existingDefinition = definitions.get(existingId);
				if (existingDefinition) {
					return { ...existingDefinition };
				}
			}

			definitions.set(definition.id, { ...definition });
			definitionsByName.set(definition.name, definition.id);
			return { ...definition };
		},

		async getDefinition(jobId) {
			const definition = definitions.get(jobId);
			return definition ? { ...definition } : null;
		},

		async getDefinitionByName(jobName) {
			const definitionId = definitionsByName.get(jobName);
			if (!definitionId) {
				return null;
			}

			const definition = definitions.get(definitionId);
			return definition ? { ...definition } : null;
		},

		async createSchedule(schedule) {
			if (schedule.scheduleKey) {
				const existingId = schedulesByKey.get(schedule.scheduleKey);
				if (existingId) {
					const existingSchedule = schedules.get(existingId);
					if (existingSchedule) {
						return { ...existingSchedule };
					}
				}
			}

			const createdSchedule: StoredJobSchedule = {
				...schedule,
				id: generateScheduleId(),
			};

			schedules.set(createdSchedule.id, createdSchedule);
			if (createdSchedule.scheduleKey) {
				schedulesByKey.set(createdSchedule.scheduleKey, createdSchedule.id);
			}
			return { ...createdSchedule };
		},

		async getSchedule(scheduleId) {
			const schedule = schedules.get(scheduleId);
			return schedule ? { ...schedule } : null;
		},

		async getScheduleByKey(scheduleKey) {
			const scheduleId = schedulesByKey.get(scheduleKey);
			if (!scheduleId) {
				return null;
			}

			const schedule = schedules.get(scheduleId);
			return schedule ? { ...schedule } : null;
		},

		async updateSchedule(schedule) {
			const existingSchedule = schedules.get(schedule.id);
			if (!existingSchedule) {
				return null;
			}

			if (
				schedule.scheduleKey &&
				schedule.scheduleKey !== existingSchedule.scheduleKey
			) {
				const conflictingId = schedulesByKey.get(schedule.scheduleKey);
				if (conflictingId && conflictingId !== schedule.id) {
					const conflictingSchedule = schedules.get(conflictingId);
					if (conflictingSchedule) {
						return { ...conflictingSchedule };
					}
				}
			}

			if (
				existingSchedule.scheduleKey &&
				existingSchedule.scheduleKey !== schedule.scheduleKey
			) {
				schedulesByKey.delete(existingSchedule.scheduleKey);
			}
			if (schedule.scheduleKey) {
				schedulesByKey.set(schedule.scheduleKey, schedule.id);
			}

			const updatedSchedule: StoredJobSchedule = { ...schedule };
			schedules.set(updatedSchedule.id, updatedSchedule);
			return { ...updatedSchedule };
		},

		async listDueSchedules({ now, limit }) {
			return [...schedules.values()]
				.filter(
					(schedule) =>
						schedule.enabled &&
						schedule.nextRunAt !== null &&
						new Date(schedule.nextRunAt).getTime() <= now.getTime(),
				)
				.sort((left, right) => {
					const leftNextRunAt = left.nextRunAt ?? "";
					const rightNextRunAt = right.nextRunAt ?? "";
					return leftNextRunAt.localeCompare(rightNextRunAt);
				})
				.slice(0, limit)
				.map((schedule) => ({ ...schedule }));
		},

		async advanceSchedule({ scheduleId, now, lastScheduledAt, nextRunAt }) {
			const schedule = schedules.get(scheduleId);
			if (
				!schedule ||
				!schedule.enabled ||
				schedule.nextRunAt !== lastScheduledAt
			) {
				return null;
			}

			const updated: StoredJobSchedule = {
				...schedule,
				lastScheduledAt,
				nextRunAt,
				updatedAt: now.toISOString(),
			};
			schedules.set(scheduleId, updated);
			return { ...updated };
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
			}

			const createdJobRun: StoredJobRun = {
				...jobRun,
				id: generateRunId(),
			};

			if (createdJobRun.dedupeKey) {
				dedupeIndex.set(createdJobRun.dedupeKey, createdJobRun.id);
			}

			jobRuns.set(createdJobRun.id, createdJobRun);
			return { ...createdJobRun };
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

			const updated: StoredJobRun = {
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

			const updated: StoredJobRun = {
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

			const updated: StoredJobRun = {
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

			const updated: StoredJobRun = {
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

			const updated: StoredJobRun = {
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
