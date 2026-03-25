// This file is generated from sql/sqlite/0001_init.sql.
// Do not edit it directly.

export const requiredSchemaVersion = 1;

export const schemaMigrations = [
	{
		version: 1,
		name: "init",
		sql: "CREATE TABLE IF NOT EXISTS job_definitions (\n\tid TEXT PRIMARY KEY,\n\tname TEXT NOT NULL UNIQUE,\n\thandler TEXT NOT NULL,\n\tpayload_template TEXT,\n\tdefault_options TEXT,\n\tcreated_at TEXT NOT NULL,\n\tupdated_at TEXT NOT NULL\n);\n\nCREATE TABLE IF NOT EXISTS job_runs (\n\tid TEXT PRIMARY KEY,\n\tjob_id TEXT NOT NULL,\n\tjob_name TEXT NOT NULL,\n\tstatus TEXT NOT NULL,\n\tdedupe_key TEXT,\n\tpayload TEXT NOT NULL,\n\tattempt INTEGER NOT NULL DEFAULT 0,\n\tmax_attempts INTEGER NOT NULL,\n\tnext_run_at TEXT,\n\tcreated_at TEXT NOT NULL,\n\tupdated_at TEXT NOT NULL,\n\tstarted_at TEXT,\n\tfinished_at TEXT,\n\tlast_error TEXT,\n\tFOREIGN KEY (job_id) REFERENCES job_definitions(id)\n);\n\nCREATE INDEX IF NOT EXISTS job_runs_status_next_run_at_idx\n\tON job_runs (status, next_run_at);\n\nCREATE UNIQUE INDEX IF NOT EXISTS job_runs_dedupe_key_idx\n\tON job_runs (dedupe_key)\n\tWHERE dedupe_key IS NOT NULL;\n\nCREATE TABLE IF NOT EXISTS job_locks (\n\tjob_run_id TEXT PRIMARY KEY,\n\tlease_until TEXT NOT NULL,\n\tupdated_at TEXT NOT NULL\n);\n\nCREATE TABLE IF NOT EXISTS schema_version (\n\tversion INTEGER PRIMARY KEY,\n\tupdated_at TEXT NOT NULL\n);",
	},
] as const;
