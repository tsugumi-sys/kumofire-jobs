import type {
	D1Database as CloudflareD1Database,
	D1PreparedStatement as CloudflareD1PreparedStatement,
	D1Response,
	D1Result,
	Queue,
} from "@cloudflare/workers-types";
import type { JobQueueAdapter, JobRunMessage } from "../protocol";
import { requiredSchemaVersion, schemaMigrations } from "./schema";

export type D1RunMeta = D1Response["meta"];
export type D1Database = CloudflareD1Database;
export type D1PreparedStatement = CloudflareD1PreparedStatement;
export type D1RunResult<T = Record<string, unknown>> = D1Result<T>;
export type CloudflareQueue<TMessage = unknown> = Queue<TMessage>;

export { requiredSchemaVersion, schemaMigrations } from "./schema";
export { createD1StorageAdapter } from "./storage";

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

export function createCloudflareQueueAdapter(
	queue: CloudflareQueue<JobRunMessage>,
): JobQueueAdapter {
	return {
		send(message) {
			return queue.send(message);
		},
	};
}
