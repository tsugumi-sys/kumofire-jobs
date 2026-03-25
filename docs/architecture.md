# Kumofire Jobs Architecture

## Scope

This document defines the architecture and protocol for the Kumofire Jobs single-job execution foundation.
The initial scope is single-job `create / dispatch / consume / retry / status management`.

Multi-step orchestration built from dependent jobs is a future extension.
This architecture is expected to leave room for that extension.

## Runtime Model

Kumofire Jobs assumes the following runtime components:

* application side
  * creates jobs
  * reads job status
* dispatcher side
  * scans due jobs and dispatches them to the queue
* consumer side
  * consumes queue messages
  * executes handlers
  * updates job status
* storage adapter
  * provides the single source of truth for job state
* queue adapter
  * delivers `jobId`

These components may live in a single Worker or be split across multiple Workers.
The initial implementation treats Cloudflare D1 and Cloudflare Queues as the first adapters.

## Protocol

The protocol is intended to be language-agnostic.
It is defined around schema, queue message format, and status transitions rather than TypeScript-specific helpers.

### Entities

#### Job

A Job is a unit of execution persisted through the storage adapter.

Required logical fields:

* `id`
  * unique job identifier
* `name`
  * identifier for the job type
* `status`
  * current job status
* `payload`
  * input JSON required by the handler
* `attempt`
  * current attempt count
* `max_attempts`
  * maximum allowed attempts
* `next_run_at`
  * the next time the job may be dispatched
* `created_at`
* `updated_at`
* `started_at`
* `finished_at`
* `last_error`

#### Job Lock

A Job Lock is a lease used to suppress duplicate execution of the same job.

Required logical fields:

* `job_id`
* `lease_until`
* `updated_at`

The lock is treated as a lease, not as a permanent lock.
The design does not assume perfect atomicity between job state updates and lock release.

### Queue Message

The queue message payload should be minimal.

```json
{ "jobId": "01J..." }
```

The queue must not carry the full payload or job state.
It should only deliver `jobId`, while the source of truth remains in the storage adapter.

### Status Model

The initial scope uses the following statuses:

* `queued`
* `running`
* `succeeded`
* `failed`
* `canceled`

Meaning:

* `queued`
  * waiting for execution
  * becomes dispatchable when `next_run_at <= now`
* `running`
  * acquired by a consumer and currently executing a handler
* `succeeded`
  * completed successfully
* `failed`
  * ended without retry, or exceeded retry limit
* `canceled`
  * removed from execution by an external action

### State Transitions

Base transitions in the initial scope:

* create
  * a new job is created as `queued`
* dispatch
  * a job with `status = queued` and `next_run_at <= now` is sent to the queue
* consume start
  * after acquiring a lock, the consumer moves the job from `queued` to `running`
* success
  * `running -> succeeded`
* retry
  * `running -> queued`
  * increments `attempt` and sets a new `next_run_at`
* terminal failure
  * `running -> failed`

State transitions should be idempotent and must tolerate duplicate processing under at-least-once delivery.

### Create Protocol

`jobs.create(...)` does the following:

* creates a job row in the storage adapter
* stores `runAt` into `next_run_at` if provided
* may dispatch immediately when `runAt <= now`
* only registers the job in storage when `runAt > now`, leaving later dispatch to the dispatcher

When `dedupe_key` is used, deduplication is the responsibility of job creation.
This prevents semantic duplicate registration, not duplicate execution of the same job instance.

### Dispatch Protocol

`jobs.dispatch(...)` selects jobs that satisfy:

* `status = queued`
* `next_run_at <= now`

It then sends each selected `jobId` to the queue.
Dispatch also covers re-dispatch for due retries.

### Consume Protocol

For each queue message, `jobs.consume(...)` does the following:

1. validates schema version
2. reads the job row from `jobId`
3. acquires a job lock using a lease
4. moves the job from `queued` to `running`
5. restores the payload
6. executes the handler
7. moves the job to `succeeded` on success
8. increments `attempt` and sets `queued` plus a new `next_run_at` when retryable
9. moves the job to `failed` when not retryable

Lock release may fail, so the design relies on lease expiry for natural recovery.
Any remaining chance of re-execution must ultimately be absorbed by handler idempotency.

### Ownership Boundaries

Kumofire Jobs owns:

* job state
* retry state
* lock state
* dispatch / consume protocol

The application owns:

* handler implementation
* business results produced by handlers
* result storage
* API exposure and authorization

The application polls status by `job_id` and reads final results from its own tables or storage after completion.

## Adapters

Kumofire Jobs core does not depend directly on a specific database or message queue.
Instead, it implements the protocol through a storage adapter and a queue adapter interface.

### Storage Adapter

The storage adapter is responsible for at least:

* creating jobs
* fetching jobs
* persisting status transitions
* listing dispatchable jobs
* updating retry state
* acquiring and expiring lease locks
* validating schema version

The initial implementation uses a D1 adapter.

### Queue Adapter

The queue adapter is responsible for at least:

* sending `jobId` messages
* receiving messages in a form the consumer can interpret

The initial implementation uses a Cloudflare Queues adapter.

### Design Intent

This separation keeps the core protocol and job lifecycle vendor-agnostic while still allowing Cloudflare to be the first concrete adapter implementation.
