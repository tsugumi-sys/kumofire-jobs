import type { JobRun, JobStorageAdapter } from "../protocol";
import type { D1Database } from "./index";
import { createDefinitionRepository } from "./repositories/definitions";
import { createJobRunRepository } from "./repositories/job-runs";
import { createLeaseRepository } from "./repositories/leases";
import { createSchemaVersionRepository } from "./repositories/schema-version";
import { requiredSchemaVersion } from "./schema";

export function createD1StorageAdapter(params: {
	db: D1Database;
	requiredSchemaVersion?: number;
}): JobStorageAdapter {
	const schemaVersion = params.requiredSchemaVersion ?? requiredSchemaVersion;
	const schemaVersionRepository = createSchemaVersionRepository(params.db);
	const definitionRepository = createDefinitionRepository(params.db);
	const jobRunRepository = createJobRunRepository(params.db);
	const leaseRepository = createLeaseRepository(params.db);

	return {
		async verifySchemaVersion() {
			const currentVersion = await schemaVersionRepository.getSchemaVersion();
			if (currentVersion < schemaVersion) {
				throw new Error(
					`Schema version ${currentVersion} does not satisfy required version ${schemaVersion}. Apply Kumofire Jobs migrations.`,
				);
			}
		},

		createDefinition(definition) {
			return definitionRepository.create(definition);
		},

		getDefinition(jobId) {
			return definitionRepository.getById(jobId);
		},

		getDefinitionByName(jobName) {
			return definitionRepository.getByName(jobName);
		},

		createRun(jobRun) {
			const createdJobRun: JobRun & { id: string } = {
				...jobRun,
				id: crypto.randomUUID(),
			};

			return jobRunRepository.create(createdJobRun);
		},

		getRun(jobRunId) {
			return jobRunRepository.getById(jobRunId);
		},

		getRunByDedupeKey(dedupeKey) {
			return jobRunRepository.getByDedupeKey(dedupeKey);
		},

		listDispatchableJobs({ now, limit }) {
			return jobRunRepository.listDispatchable({ now, limit });
		},

		acquireLease({ jobRunId, now, leaseMs }) {
			return leaseRepository.acquire({ jobRunId, now, leaseMs });
		},

		releaseLease(jobRunId) {
			return leaseRepository.release(jobRunId);
		},

		markQueued({ jobRunId, now }) {
			return jobRunRepository.markQueued({ jobRunId, now });
		},

		markRunning({ jobRunId, now }) {
			return jobRunRepository.markRunning({ jobRunId, now });
		},

		markSucceeded({ jobRunId, now }) {
			return jobRunRepository.markSucceeded({ jobRunId, now });
		},

		markRetryable({ jobRunId, now, nextRunAt, error }) {
			return jobRunRepository.markRetryable({
				jobRunId,
				now,
				nextRunAt,
				error,
			});
		},

		markFailed({ jobRunId, now, error }) {
			return jobRunRepository.markFailed({ jobRunId, now, error });
		},
	};
}
