# Cloudflare Migration CLI

This document proposes a library-owned migration CLI for the Cloudflare path.

## Goal

Users of `@kumofire/jobs` should not need to know the Kumofire Jobs database schema.

The library already owns:

* the storage contract
* the schema version contract
* the ordered migration set

The library should therefore also own applying Cloudflare migrations.

## Problem

The current migration story still leaks storage details to application code:

* users must know that D1 schema setup is required
* users must know where the SQL lives
* users must apply raw SQL themselves
* users must reason about schema version drift

That is the wrong abstraction boundary if Cloudflare support is meant to be exposed as a runtime interface rather than as a database schema package.

## Proposed Interface

Add a packaged CLI command:

```bash
kumofire-jobs cloudflare migrate --local --database kumofire-jobs-example
kumofire-jobs cloudflare migrate --remote --database kumofire-jobs-example
kumofire-jobs cloudflare migrate --remote --database kumofire-jobs-example --dry-run
```

The CLI should be non-interactive by default so it works in:

* CI
* deployment pipelines
* local scripts

Apply mode should require explicit user confirmation by default.
`--yes` should suppress that confirmation for CI and scripted execution.

## Command Set

### `kumofire-jobs cloudflare migrate`

Applies all pending Cloudflare migrations to a D1 database.

Expected flags:

* `--local`
  * target Wrangler local D1 state
* `--remote`
  * target the remote Cloudflare D1 database
* `--database <name>`
  * D1 database name passed through to Wrangler
* `--config <path>`
  * optional Wrangler config path
* `--cwd <path>`
  * optional working directory for Wrangler resolution
* `--dry-run`
  * print pending migrations without applying them
* `--yes`
  * skip the pre-execution confirmation prompt

Rules:

* exactly one of `--local` or `--remote` is required
* the command applies only missing migrations
* migrations run in ascending version order
* the command exits non-zero on failure
* `--dry-run` performs planning only and does not modify the database
* apply mode must show the exact Wrangler command before execution
* apply mode must ask for confirmation unless `--yes` is set

## Migration Algorithm

`migrate` should do the following:

1. Resolve target mode: local or remote.
2. Resolve the D1 database name and optional Wrangler config path.
3. Read the current installed schema version from `kumofire_schema_version`.
4. Compare it with the library-bundled `schemaMigrations`.
5. Select migrations where `migration.version > currentVersion`.
6. If no migrations are pending, exit successfully without confirmation.
7. If `--dry-run` is set, print the plan and exit without confirmation.
8. Build the exact `wrangler d1 execute ...` command for each pending migration.
9. Print the command or commands that will be executed.
10. Ask for confirmation unless `--yes` is set.
11. Apply pending migrations in order.
12. Re-read the schema version after apply.
13. Exit successfully only if the final version matches `requiredSchemaVersion`.

If the version table does not exist yet, the command should treat the database as version `0`.

## Source Of Truth

The CLI should use the library-bundled migration metadata:

* `schemaMigrations`
* `requiredSchemaVersion`

That keeps one source of truth for:

* runtime verification
* migration planning
* migration execution

Users should not need to import SQL files manually.

## Execution Boundary

There are two viable execution models.

### Option A

The CLI shells out to `wrangler d1 execute`.

Pros:

* aligns with official Cloudflare workflow
* does not require duplicating D1 auth or transport logic
* works for both local and remote paths

Cons:

* introduces a Wrangler dependency at execution time
* requires careful command construction and error handling

### Option B

The CLI talks to D1 through Cloudflare APIs directly.

Pros:

* no Wrangler subprocess dependency
* full control over output and error handling

Cons:

* significantly larger implementation surface
* duplicates Cloudflare operational concerns the user likely already solves with Wrangler

Recommended decision:

* use Wrangler as the execution backend
* keep the migration planning and version logic in `@kumofire/jobs`

## Confirmation

The CLI should confirm before any write operation.

Rules:

* `--dry-run` never prompts
* apply mode prompts for both `--local` and `--remote`
* `--yes` skips the prompt
* no prompt is shown if there are no pending migrations

Example prompt for local apply:

```txt
About to apply 1 Kumofire Jobs migration to the local D1 database "kumofire-jobs-example".
Command:
wrangler d1 execute kumofire-jobs-example --local --command "<SQL>"
Continue? [y/N]
```

Example prompt for remote apply:

```txt
About to apply 1 Kumofire Jobs migration to the remote D1 database "kumofire-jobs-example".
Command:
wrangler d1 execute kumofire-jobs-example --remote --command "<SQL>"
Continue? [y/N]
```

If multiple migrations are pending, the CLI should print each command in order before asking for confirmation.

## Error Handling

The CLI should fail clearly for:

* both `--local` and `--remote` specified
* neither `--local` nor `--remote` specified
* missing `--database`
* Wrangler not installed or not resolvable
* D1 target not found
* failed SQL execution
* schema version still behind after apply
* confirmation declined

Example error shape:

```txt
Cloudflare migration failed: database schema is at version 0 but version 1 is required.
Run: kumofire-jobs cloudflare migrate --remote --database kumofire-jobs-example
```

## Output

The CLI output should stay short and script-friendly.

Example:

```txt
Target: remote
Database: kumofire-jobs-example
Current version: 0
Required version: 1
Pending migrations: 1
Command:
wrangler d1 execute kumofire-jobs-example --remote --command "<SQL>"
Applying migration 1: init
Done. Schema version is now 1.
```

For `--dry-run`:

```txt
Target: remote
Database: kumofire-jobs-example
Current version: 1
Required version: 1
Status: up to date
```

## Packaging

The npm package should expose a binary:

```json
{
  "bin": {
    "kumofire-jobs": "./dist/cli.mjs"
  }
}
```

The CLI implementation should live in the published package, not in example code.

## Why This Is Better

This approach keeps the boundary consistent:

* applications depend on Kumofire interfaces
* Kumofire owns its schema lifecycle
* runtime version checks and migration execution use the same source of truth

It also improves upgrade safety because the package can move users from:

* "apply this SQL file manually"

to:

* "run the library migration command"

## Non-Goals

This proposal does not require:

* an interactive prompt-first CLI
* user-managed SQL files
* application-specific migration frameworks such as Drizzle
* exposing Kumofire tables as part of the public Cloudflare API
