# Cloudflare Migration Workflow

This library ships reference SQLite/D1 schema assets.
It does not apply Cloudflare D1 migrations for you.

Your application owns:

* creating the D1 database
* executing the SQL migrations
* deploying schema changes before deploying code that requires them

The runtime only verifies schema version on use.

## Current Schema Version

The current required version is exported as `requiredSchemaVersion`.

The packaged reference SQL is exported in two forms:

* versioned SQL files under `sql/sqlite/`
* `getReferenceSchemaSql(...)` for programmatic access

In this repository, the canonical SQL file is:

* [typescript/sql/sqlite/0001_init.sql](https://github.com/tsugumi-sys/kumofire-jobs/blob/main/typescript/sql/sqlite/0001_init.sql)

## First-Time Setup

1. Create the D1 database.
2. Apply the initial schema SQL before using the runtime.
3. Bind that database to your Worker as `JOBS_DB`.

Example:

```bash
wrangler d1 create kumofire-jobs-example
wrangler d1 execute kumofire-jobs-example --file=../../typescript/sql/sqlite/0001_init.sql
```

If you are consuming the published package instead of this repository checkout, use the installed asset path:

```bash
wrangler d1 execute kumofire-jobs-example --file=./node_modules/@kumofire/jobs/sql/sqlite/0001_init.sql
```

## Runtime Verification

`createD1StorageAdapter(...)` verifies that the stored schema version is at least the required version.

If the database is behind, runtime calls fail with an error like:

```txt
Schema version 0 does not satisfy required version 1. Apply Kumofire Jobs migrations.
```

That failure is intentional.
It prevents a Worker from running against an older D1 schema.

## Upgrade Workflow

For every package upgrade:

1. Check whether `requiredSchemaVersion` changed.
2. Apply the new SQL migration in D1.
3. Deploy the Worker code that expects that version.

Today the package ships only the initial migration:

* `0001_init.sql`

When later versions are added, apply them in order.

## Programmatic SQL Access

If your deployment tooling wants SQL from code instead of the packaged file, use `getReferenceSchemaSql(...)`.

Example:

```ts
import {
  getReferenceSchemaSql,
  requiredSchemaVersion,
} from "@kumofire/jobs";

const sql = getReferenceSchemaSql({
  fromVersion: 0,
  toVersion: requiredSchemaVersion,
});
```

This is useful for:

* CI validation
* generating reference migration output
* tooling that compares desired and installed versions

It is still your deployment system's responsibility to execute the SQL.

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
