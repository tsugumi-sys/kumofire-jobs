import { requiredSchemaVersion, schemaMigrations } from "./schema";

export { createCloudflareQueueAdapter } from "./queue";
export { requiredSchemaVersion, schemaMigrations } from "./schema";
export { createD1StorageAdapter } from "./storage";
export type {
	CloudflareQueue,
	D1Database,
	D1PreparedStatement,
	D1RunMeta,
	D1RunResult,
} from "./types";

export function getReferenceSchemaSql(params?: {
	fromVersion?: number;
	toVersion?: number;
}): string {
	const fromVersion = params?.fromVersion ?? 0;
	const toVersion = params?.toVersion ?? requiredSchemaVersion;

	return schemaMigrations
		.filter(
			(migration) =>
				migration.version > fromVersion && migration.version <= toVersion,
		)
		.map((migration) => migration.sql.trim())
		.join("\n\n");
}
