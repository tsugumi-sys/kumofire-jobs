# Cloudflare Migration Workflow

This library owns the Cloudflare migration set and exposes a CLI for applying it.

Your application still owns:

* creating the D1 database
* choosing local or remote migration targets
* deploying schema changes before deploying code that requires them

The runtime verifies schema version on use.

## Current Schema Version

The current required version is exported as `requiredSchemaVersion`.

The packaged migration metadata is exposed through the library and used by the CLI.

## First-Time Setup

1. Create the D1 database.
2. Apply the initial migration before using the runtime.
3. Bind that database to your Worker as `JOBS_DB`.

Example:

```bash
wrangler d1 create kumofire-jobs-example
kumofire-jobs cloudflare migrate --local --database kumofire-jobs-example
```

For a remote database:

```bash
kumofire-jobs cloudflare migrate --remote --database kumofire-jobs-example
```

## Runtime Verification

`createD1StorageAdapter(...)` verifies that the stored schema version is at least the required version.
`kumofire-jobs cloudflare migrate` applies any missing migrations before runtime use.

If the database is behind, runtime calls fail with an error like:

```txt
Schema version 0 does not satisfy required version 1. Apply Kumofire Jobs migrations.
```

That failure is intentional.
It prevents a Worker from running against an older D1 schema.

## Upgrade Workflow

For every package upgrade:

1. Check whether `requiredSchemaVersion` changed.
2. Run the migration CLI against the target D1 database.
3. Deploy the Worker code that expects that version.

The CLI computes pending migrations and applies them in version order.

## CLI Usage

The migration CLI supports:

* `--local`
* `--remote`
* `--database <name>`
* `--config <path>`
* `--cwd <path>`
* `--dry-run`
* `--yes`

Examples:

```bash
kumofire-jobs cloudflare migrate --local --database kumofire-jobs-example
kumofire-jobs cloudflare migrate --remote --database kumofire-jobs-example
kumofire-jobs cloudflare migrate --remote --database kumofire-jobs-example --dry-run
```

The CLI prints the exact Wrangler command before applying migrations and asks for confirmation unless `--yes` is set.

## Current Tables

The current Cloudflare/D1 schema creates:

* `kumofire_job_definitions`
* `kumofire_job_runs`
* `kumofire_job_locks`
* `kumofire_schema_version`

`kumofire_job_runs` stores:

* `job_id`
* `job_name`
* `status`
* `dedupe_key`
* `payload`
* attempt and timestamp fields

That matches the current single-run lifecycle used by the runtime.
