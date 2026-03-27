import type { JobDefinition } from "../../protocol";
import type { D1Database } from "../types";
import { fetchDefinitionBy, requireSuccess, serializePayload } from "./shared";

export function createDefinitionRepository(db: D1Database) {
	return {
		async create(definition: JobDefinition): Promise<JobDefinition> {
			const insertResult = await db
				.prepare(`INSERT INTO kumofire_job_definitions (
\tid,
\tname,
\thandler,
\tpayload_template,
\tdefault_options,
\tcreated_at,
\tupdated_at
) VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO NOTHING`)
				.bind(
					definition.id,
					definition.name,
					definition.handler,
					definition.payloadTemplate
						? serializePayload(definition.payloadTemplate)
						: null,
					definition.defaultOptions
						? serializePayload(definition.defaultOptions)
						: null,
					definition.createdAt,
					definition.updatedAt,
				)
				.run();

			requireSuccess(insertResult, "create definition");

			const createdDefinition = await fetchDefinitionBy(db, "id = ?", [
				definition.id,
			]);
			if (!createdDefinition) {
				throw new Error(
					`D1 create definition failed to return row for "${definition.id}"`,
				);
			}

			return createdDefinition;
		},

		getById(jobId: string): Promise<JobDefinition | null> {
			return fetchDefinitionBy(db, "id = ?", [jobId]);
		},

		getByName(jobName: string): Promise<JobDefinition | null> {
			return fetchDefinitionBy(db, "name = ?", [jobName]);
		},
	};
}
