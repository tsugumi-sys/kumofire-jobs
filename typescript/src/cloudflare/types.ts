import type {
	D1Database as CloudflareD1Database,
	D1PreparedStatement as CloudflareD1PreparedStatement,
	D1Response,
	D1Result,
	Queue,
} from "@cloudflare/workers-types";

export type D1RunMeta = D1Response["meta"];
export type D1Database = CloudflareD1Database;
export type D1PreparedStatement = CloudflareD1PreparedStatement;
export type D1RunResult<T = Record<string, unknown>> = D1Result<T>;
export type CloudflareQueue<TMessage = unknown> = Queue<TMessage>;
