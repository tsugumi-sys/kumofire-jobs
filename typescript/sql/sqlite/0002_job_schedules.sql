CREATE TABLE IF NOT EXISTS kumofire_job_schedules (
	id TEXT PRIMARY KEY,
	job_id TEXT NOT NULL,
	job_name TEXT NOT NULL,
	schedule_type TEXT NOT NULL,
	schedule_expr TEXT NOT NULL,
	timezone TEXT,
	next_run_at TEXT,
	last_scheduled_at TEXT,
	enabled INTEGER NOT NULL DEFAULT 1,
	payload TEXT NOT NULL,
	max_attempts INTEGER NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	FOREIGN KEY (job_id) REFERENCES kumofire_job_definitions(id)
);

CREATE INDEX IF NOT EXISTS kumofire_job_schedules_enabled_next_run_at_idx
	ON kumofire_job_schedules (enabled, next_run_at);

ALTER TABLE kumofire_job_runs
ADD COLUMN job_schedule_id TEXT REFERENCES kumofire_job_schedules(id);

CREATE INDEX IF NOT EXISTS kumofire_job_runs_job_schedule_id_idx
	ON kumofire_job_runs (job_schedule_id);

INSERT INTO kumofire_schema_version (version, updated_at)
VALUES (2, '1970-01-01T00:00:00.000Z')
ON CONFLICT(version) DO UPDATE SET
	updated_at = excluded.updated_at;
