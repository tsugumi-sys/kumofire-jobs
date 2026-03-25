# Kumofire Jobs Design Doc (Draft)

## Purpose

Provide a reusable asynchronous job foundation, including batch-style jobs, as a library on top of Cloudflare.

* the application server creates jobs, checks status, and triggers execution
* the queue consumer consumes messages, runs jobs, and updates state
* D1 is treated as the single source of truth for job state
* queue messages should contain only `jobId` in principle, while the payload itself lives in D1

## Assumptions

Cloudflare can run a queue consumer and a cron trigger within a single Worker.
In real deployments, however, the queue consumer and cron trigger may be split across different Workers while still sharing the same database.
This system is designed to work in either setup.

Whether the runtime is a single Worker or multiple Workers, jobs are managed through a shared database as the single source of truth.

This draft targets the single-job lifecycle first: create, dispatch, consume, retry, and state management.
After that foundation is stable, it is expected to extend toward multi-step orchestration built from dependent jobs.

## Non-Goals (Initial)

* an execution platform that allows users to upload and run arbitrary code
* advanced workflows with long-lived, multi-stage, or complex state-machine behavior
* although future Workflows integration should remain possible, the initial design does not include it
* offloading large payloads to external object storage such as R2

---

## Overall Architecture

### Single-Worker Setup

```
[Single Worker]
  - HTTP handler
  - Queue consumer
  - Cron trigger (optional)
  - Job handlers
      |                \
      | read/write      \ enqueue/consume
      v                  v
   [D1: jobs]        [Queues]
```

* the same Worker handles both job creation and job execution
* the HTTP handler creates jobs, stores them in D1, and sends `jobId` to the queue
* the queue consumer receives `jobId`, reads the job from D1, executes the handler, and updates state
* if retry is based on `next_run_at`, the same Worker may re-dispatch due jobs from its cron trigger

### Split-Worker Setup

```
[Application Worker]                  [Consumer Worker]
  - HTTP handler                        - Queue consumer
  - create/status API                   - Job handlers
                                         - Cron trigger (optional)
         |                                     |
         | read/write                          | read/write
         v                                     v
                [D1: jobs]
                     ^
                     |
         dispatch(jobId) / consume(jobId)
                     |
                  [Queues]
```

* the Application Worker handles job creation, status lookup, and optional dispatch
* the Consumer Worker handles queue consumption, lock acquisition, handler execution, and state updates
* both Workers rely on the same D1 database as the single source of truth
* the cron trigger may exist on either side depending on operational needs

## Design Principles

* only `jobId` should travel through the queue
* payload should be stored and read from D1
* the library owns job state, while the application owns business results
* schema ownership should be separated between the library and the application
* the library should provide the required schema contract and reference SQL, while the application chooses how to apply migrations
* the library must not run automatic `ALTER` or automatic migration apply in production

---

## Library Packaging

Initially, the library should be distributed as a single package.
Internally, responsibilities should still be separated so that entrypoints or packages can be split later if needed.

### Intended Modules

* `jobs`
  * `create`
  * `dispatch`
  * `getStatus`
  * `consume`
* `core`
  * D1 schema and migration SQL
  * JobStore persistence layer
  * schema version checks
  * state transitions, locks, and serialization rules
* `handlers`
  * job handler registration
  * retry policy

The public API should remain small, while creation, dispatch, and consumption remain separate internally.

---

## Data Model (D1)

### jobs (Required)

* `id` TEXT PRIMARY KEY (`uuid` or `ulid`)
* `name` TEXT NOT NULL (job type)
* `status` TEXT NOT NULL (`queued` / `running` / `succeeded` / `failed` / `canceled`)
* `dedupe_key` TEXT NULL (optional idempotency key)
* `payload` TEXT NULL (JSON)
* `attempt` INTEGER NOT NULL DEFAULT 0
* `max_attempts` INTEGER NOT NULL DEFAULT `<default>`
* `next_run_at` TEXT NULL (used for cron-driven retry)
* `created_at` TEXT NOT NULL
* `updated_at` TEXT NOT NULL
* `started_at` TEXT NULL
* `finished_at` TEXT NULL
* `last_error` TEXT NULL (trimmed message / stack)

#### Example Indexes

* `(status, next_run_at)`
* `(dedupe_key)` UNIQUE (optional, when dedupe is enabled)

### job_locks (Optional but Recommended)

Used to suppress duplicate execution under at-least-once delivery.

* `job_id` TEXT PRIMARY KEY
* `lease_until` TEXT NOT NULL
* `updated_at` TEXT NOT NULL

Locks should use a lease model with expiration.
The design should not assume perfect atomicity between job state updates and lock release.
Instead, locks should recover naturally when the lease expires.
Any residual chance of re-execution must ultimately be absorbed by handler idempotency.

### schema_version (Recommended)

* `version` INTEGER NOT NULL
* `updated_at` TEXT NOT NULL

The library should validate the minimum required schema version at startup or execution time and fail with a clear error if it is not satisfied.

---

## Migration Strategy

### Why Ownership Is Split

Applications often already have an established migration workflow through Prisma, Drizzle, Wrangler, raw SQL, or something else.
If the library assumes its own migration apply mechanism, it will likely conflict with that existing workflow.

Because of that, ownership should be split as follows:

* the library defines what schema is required
* the application decides how that schema is applied

What matters is that the required schema exists, not which migration tool applied it.

### Policy

* the library should ship versioned incremental SQL files
* those SQL files should be treated as reference implementations, while the application keeps control over migration execution
* library upgrades should append new migration files rather than rewriting existing history
* the library must not run automatic schema changes or automatic apply in production

### Example User Flow

1. upgrade the library with `npm install`
2. review the bundled incremental SQL to understand the required schema changes
3. apply equivalent changes through Prisma, Drizzle, Wrangler, raw SQL, or the application's own migration system
4. verify that the deployed schema satisfies `requiredSchemaVersion` before production rollout

### What the Library Provides

* versioned incremental SQL such as `sql/0001_init.sql`, `sql/0002_add_dedupe.sql`, ...
* `requiredSchemaVersion`
* an API that verifies whether the current database satisfies the required schema version

### Optional Helper CLI

Automatic apply is out of scope, but helper CLI commands may still be provided.

* `jobs schema:list`
* `jobs schema:print --from <x> --to <y>`
* `jobs schema:write --from <x> --to <y> --out <file>`

The CLI should help users extract reference SQL, not take over migration ownership.

---

## Queue Message Format

### Minimal Payload

```json
{ "jobId": "01J..." }
```

### Possible Future Extensions

* `{ jobId, runAt }` for delayed re-dispatch or cron integration
* `{ jobId, traceId }` for tracing and observability

---

## Jobs Interface

### Initialization

```ts
const jobs = createJobs<Env>({
  namespace: "vp",
  db: (env) => env.DB,
  queue: (env) => env.QUEUE,
  handlers: {
    dailyAgg: async (ctx) => ({ ok: true }),
  },
  retry: {
    maxAttempts: 5,
    backoff: "exponential",
    baseMs: 5_000,
    maxMs: 10 * 60_000,
  },
});
```

### Public API

* `create(env, { name, input, dedupeKey?, runAt?, options? }) -> jobId`
  * creates a job row in D1 and stores the payload
  * saves `runAt` as `next_run_at`
  * dispatches immediately when `runAt <= now`
  * only registers the job when `runAt > now`, leaving later dispatch to `dispatch()`
* `dispatch(env, { limit? }) -> { dispatched: number }`
  * picks jobs with `next_run_at <= now` and sends them to the queue
* `getStatus(env, jobId) -> { status, attempt, ... }`
* `cancel(env, jobId)` (future)

### Idempotency at Create Time

When `dedupeKey` is provided:

* if `dedupeKey` has a UNIQUE constraint, insert failure may return the existing `jobId`
* without that constraint, stronger coordination would be needed, so UNIQUE is preferred

---

### queue entry

```ts
export default {
  async queue(batch, env, ctx) {
    await jobs.consume(env, batch, { concurrency: 4 });
  },
  async scheduled(_event, env, ctx) {
    await jobs.dispatch(env, { limit: 100 });
  }
}
```

### Consumption Responsibilities

For each message (`jobId`):

1. validate schema (`schema_version >= required`)
2. read the `jobs` row
3. acquire a lock (`job_locks` lease)
   * if lock acquisition fails, skip because another consumer is already processing it
4. move status from `queued` to `running` idempotently
5. restore payload from D1
6. execute the handler
7. on success:
   * set status to `succeeded`
8. on failure:
   * increment `attempt`
   * if retryable, set `next_run_at` and move back to `queued`
   * otherwise, mark it as `failed`
9. release the lock, or rely on lease expiration as practical recovery

---

## Retry Design

This design intentionally avoids depending on queue-native delay features.

* when a handler fails, the consumer computes `next_run_at` and returns the job to `queued`
* a cron trigger periodically calls `jobs.dispatch()`
  * it scans `status = queued AND next_run_at <= now()` and re-dispatches matching jobs

Pros: straightforward implementation and operations
Cons: requires cron plus scanning, though this is realistic with D1

---

## Payload and Result Ownership

* the library stores `payload` in D1 as input needed for job execution
* the library owns job state management
* the application owns the business result produced by the handler
* for that reason, the library does not include a `result` column and does not define where results must be stored
* the application polls job state by `job_id` and reads final results from its own tables or storage after completion
* the initial scope does not assume arbitrarily large payload support
* if large payloads become necessary, R2 integration can be added later as a separate design

---

## Boundaries and Responsibilities

### Provided by the Library

* job store (D1)
* job protocol (`jobId` queue message, status transitions, locking, retry policy)
* jobs API (`create / dispatch / consume / getStatus`)
* migration SQL for users to adopt

### Implemented by the Application

* HTTP API routing where needed
* job handlers
* migration application steps in CI/CD
* monitoring and alerting, with logs as a reasonable starting point

---

## Developer Experience Direction

### Do Not Assume a Single Worker

The API should still work when the job creation side and the job execution side are deployed separately.

### Error Design

* schema mismatch:
  * the error should clearly tell the user to apply migrations
* missing handler:
  * mark the job as `failed` with an explicit misconfiguration error
* corrupted payload:
  * mark the job as `failed` because retry will not repair invalid payload data

## Minimal Setup Flow

1. `npm i @kumofire/jobs`
2. review the bundled incremental SQL and bring it into the application's migration system
3. apply migrations in development and confirm that the schema satisfies `requiredSchemaVersion`
4. wire `jobs.create()` and `jobs.getStatus()` into a single Worker
5. wire `jobs.dispatch()` into the same Worker's `scheduled()`
6. wire `jobs.consume()` into the same Worker's `queue()`
7. verify that production uses the same schema version before release

---

## Future Extension Ideas

* add multi-step orchestration by managing dependencies between multiple jobs
* webhook notifications when jobs complete
* monitoring metrics such as success / failure / delay
* admin UI for listing and replaying jobs
* integrate with Workflows if long-lived orchestration becomes necessary
