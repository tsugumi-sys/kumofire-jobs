import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type {
	CloudflareQueue,
	D1Database,
	D1PreparedStatement,
	D1RunMeta,
	D1RunResult,
} from "./cloudflare";
import {
	createCloudflareQueueAdapter,
	createD1StorageAdapter,
	createJobs,
	getReferenceSchemaSql,
	requiredSchemaVersion,
} from "./index";

type SqliteValue = string | number | bigint | Uint8Array | null;

function toSqliteValue(value: unknown): SqliteValue {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "bigint" ||
		value instanceof Uint8Array
	) {
		return value;
	}

	throw new Error(`Unsupported sqlite bind value: ${String(value)}`);
}

function createD1Meta(overrides?: Partial<D1RunMeta>): D1RunMeta {
	return {
		duration: 0,
		size_after: 0,
		rows_read: 0,
		rows_written: 0,
		last_row_id: 0,
		changed_db: false,
		changes: 0,
		...overrides,
	};
}

class SqliteD1PreparedStatement implements D1PreparedStatement {
	private values: SqliteValue[] = [];

	constructor(
		private readonly database: DatabaseSync,
		private readonly query: string,
	) {}

	bind(...values: unknown[]): D1PreparedStatement {
		this.values = values.map(toSqliteValue);
		return this;
	}

	first<T>(columnName?: string): Promise<T | null> {
		const statement = this.database.prepare(this.query);
		const row = statement.get(...this.values) as
			| Record<string, unknown>
			| undefined;
		if (!row) {
			return Promise.resolve(null);
		}

		if (columnName) {
			return Promise.resolve((row[columnName] as T | undefined) ?? null);
		}

		return Promise.resolve(row as T);
	}

	run<T = Record<string, unknown>>(): Promise<D1RunResult<T>> {
		const statement = this.database.prepare(this.query);
		const result = statement.run(...this.values);

		return Promise.resolve({
			success: true,
			results: [],
			meta: createD1Meta({
				changes: Number(result.changes),
				rows_written: Number(result.changes),
				last_row_id: Number(result.lastInsertRowid),
				changed_db: Number(result.changes) > 0,
			}),
		});
	}

	all<T = Record<string, unknown>>(): Promise<D1RunResult<T>> {
		const statement = this.database.prepare(this.query);
		const results = statement.all(...this.values) as T[];

		return Promise.resolve({
			success: true,
			results,
			meta: createD1Meta({
				rows_read: results.length,
			}),
		});
	}

	raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
	raw<T = unknown[]>(options: {
		columnNames: true;
	}): Promise<[string[], ...T[]]>;
	raw<T = unknown[]>(options?: {
		columnNames?: boolean;
	}): Promise<T[] | [string[], ...T[]]> {
		if (options?.columnNames) {
			return Promise.resolve([[]] as [string[], ...T[]]);
		}

		return Promise.resolve([] as T[]);
	}
}

class SqliteD1Database implements D1Database {
	readonly sqlite: DatabaseSync;

	constructor(filename: string) {
		this.sqlite = new DatabaseSync(filename);
		this.sqlite.exec("PRAGMA foreign_keys = ON");
	}

	prepare(query: string): D1PreparedStatement {
		return new SqliteD1PreparedStatement(this.sqlite, query);
	}

	batch<T = unknown>(
		_statements: D1PreparedStatement[],
	): Promise<D1RunResult<T>[]> {
		return Promise.resolve([]);
	}

	exec(query: string): Promise<{ count: number; duration: number }> {
		this.sqlite.exec(query);
		return Promise.resolve({ count: 0, duration: 0 });
	}

	withSession(): ReturnType<D1Database["withSession"]> {
		return this as unknown as ReturnType<D1Database["withSession"]>;
	}

	dump(): Promise<ArrayBuffer> {
		return Promise.resolve(new ArrayBuffer(0));
	}

	close() {
		this.sqlite.close();
	}
}

function createQueueBinding<TMessage>(
	send: (message: TMessage) => Promise<void>,
): CloudflareQueue<TMessage> {
	return {
		send,
		async sendBatch(messages) {
			for (const message of messages) {
				await send(message.body);
			}
		},
	};
}

function createSqliteTestDb() {
	const dir = mkdtempSync(join(tmpdir(), "kumofire-jobs-sqlite-"));
	const filename = join(dir, "test.sqlite");
	const db = new SqliteD1Database(filename);
	db.sqlite.exec(getReferenceSchemaSql());

	return {
		db,
		cleanup() {
			db.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

const cleanups: Array<() => void> = [];

afterEach(() => {
	while (cleanups.length > 0) {
		cleanups.pop()?.();
	}
});

describe("cloudflare sqlite-backed D1 adapter", () => {
	it("creates schedules against a real sqlite database", async () => {
		const fixture = createSqliteTestDb();
		cleanups.push(() => fixture.cleanup());

		const jobs = createJobs({
			storage: createD1StorageAdapter({
				db: fixture.db,
				requiredSchemaVersion,
			}),
			queue: createCloudflareQueueAdapter(createQueueBinding(async () => {})),
			handlers: {
				report: () => {},
			},
			now: () => new Date("2026-03-25T00:00:00.000Z"),
		});

		const { scheduleId } = await jobs.createSchedule({
			name: "report",
			payload: { reportId: "weekly" },
			scheduleType: "cron",
			scheduleExpr: "*/5 * * * *",
		});

		const stored = fixture.db.sqlite
			.prepare(
				"SELECT id, job_name, schedule_key, schedule_expr FROM kumofire_job_schedules WHERE id = ?",
			)
			.get(scheduleId) as Record<string, unknown> | undefined;

		expect(stored).toMatchObject({
			id: scheduleId,
			job_name: "report",
			schedule_key: null,
			schedule_expr: "*/5 * * * *",
		});
	});

	it("upserts schedules by scheduleKey against a real sqlite database", async () => {
		const fixture = createSqliteTestDb();
		cleanups.push(() => fixture.cleanup());

		const jobs = createJobs({
			storage: createD1StorageAdapter({
				db: fixture.db,
				requiredSchemaVersion,
			}),
			queue: createCloudflareQueueAdapter(createQueueBinding(async () => {})),
			handlers: {
				report: () => {},
			},
			now: () => new Date("2026-03-25T00:00:00.000Z"),
		});

		const scheduleKey = "digest:user:user_123";
		const { scheduleId } = await jobs.upsertSchedule({
			scheduleKey,
			name: "report",
			payload: { reportId: "weekly" },
			scheduleType: "cron",
			scheduleExpr: "*/5 * * * *",
			timezone: "UTC",
		});

		const stored = fixture.db.sqlite
			.prepare(
				"SELECT id, schedule_key, timezone FROM kumofire_job_schedules WHERE id = ?",
			)
			.get(scheduleId) as Record<string, unknown> | undefined;

		expect(stored).toMatchObject({
			id: scheduleId,
			schedule_key: scheduleKey,
			timezone: "UTC",
		});
	});
});
