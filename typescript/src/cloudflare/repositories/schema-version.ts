import type { D1Database } from "../types";

export function createSchemaVersionRepository(db: D1Database) {
	return {
		async getSchemaVersion(): Promise<number> {
			const row = await db
				.prepare(
					"SELECT version FROM kumofire_schema_version ORDER BY version DESC LIMIT 1",
				)
				.first<{ version: number }>();

			return row?.version ?? 0;
		},
	};
}
