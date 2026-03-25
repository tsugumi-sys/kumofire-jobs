CREATE TABLE IF NOT EXISTS job_definitions (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL UNIQUE,
	handler TEXT NOT NULL,
	payload_template TEXT,
	default_options TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_runs (
	id TEXT PRIMARY KEY,
	job_id TEXT NOT NULL,
	job_name TEXT NOT NULL,
	status TEXT NOT NULL,
	dedupe_key TEXT,
	payload TEXT NOT NULL,
	attempt INTEGER NOT NULL DEFAULT 0,
	max_attempts INTEGER NOT NULL,
	next_run_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	started_at TEXT,
	finished_at TEXT,
	last_error TEXT,
	FOREIGN KEY (job_id) REFERENCES job_definitions(id)
);

CREATE INDEX IF NOT EXISTS job_runs_status_next_run_at_idx
	ON job_runs (status, next_run_at);

CREATE UNIQUE INDEX IF NOT EXISTS job_runs_dedupe_key_idx
	ON job_runs (dedupe_key)
	WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS job_locks (
	job_run_id TEXT PRIMARY KEY,
	lease_until TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_version (
	version INTEGER PRIMARY KEY,
	updated_at TEXT NOT NULL
);
