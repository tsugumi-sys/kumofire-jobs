ALTER TABLE kumofire_job_schedules
ADD COLUMN schedule_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS kumofire_job_schedules_schedule_key_idx
	ON kumofire_job_schedules (schedule_key)
	WHERE schedule_key IS NOT NULL;

INSERT INTO kumofire_schema_version (version, updated_at)
VALUES (3, '1970-01-01T00:00:00.000Z')
ON CONFLICT(version) DO UPDATE SET
	updated_at = excluded.updated_at;
