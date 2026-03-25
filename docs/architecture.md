# Kumofire Jobs Architecture

## Scope

This document defines the architecture and protocol direction for Kumofire Jobs.

The initial execution foundation remains:

* create
* dispatch
* consume
* retry
* status management

The architecture should also leave room for:

* recurring jobs
* manual runs
* future multi-step orchestration

## Runtime Model

Kumofire Jobs assumes the following runtime components:

* application side
  * manages job definitions
  * creates manual runs where needed
  * reads run status and history
* dispatcher side
  * scans due schedules and due runs
  * creates runs from schedules
  * dispatches due runs to the queue
* consumer side
  * consumes queue messages
  * executes handlers
  * updates run status
* storage adapter
  * provides the single source of truth for definitions, schedules, and runs
* queue adapter
  * delivers `jobRunId`

These components may live in a single Worker or be split across multiple Workers.
The initial implementation treats Cloudflare D1 and Cloudflare Queues as the first adapters.

## Protocol

The protocol is intended to be language-agnostic.
It is defined around schema, queue message format, and state transitions rather than TypeScript-specific helpers.

## Entities

### Job

A Job is the definition of work.

It answers:

* what this job is
* which handler should run
* what default input or options are associated with it

Recommended logical fields:

* `id`
* `name`
* `handler`
* `payload_template`
* `default_options`
* `created_at`
* `updated_at`

This row should hold definition-oriented information and remain relatively stable.

### Job Schedule

A Job Schedule is a rule that decides when a job should be started.

It answers:

* when this job should run
* whether the schedule is enabled
* what the next due time is

Recommended logical fields:

* `id`
* `job_id`
* `schedule_type`
  * `once`
  * `interval`
  * `cron`
* `schedule_expr`
* `timezone`
* `next_run_at`
* `last_scheduled_at`
* `enabled`
* `created_at`
* `updated_at`

The important point is that this is not the execution itself.
It is the rule that creates or authorizes executions.

One job may have multiple schedules.

### Job Run

A Job Run is one concrete execution instance.

It answers:

* which job ran
* which schedule, if any, caused it
* when it was supposed to run
* what actually happened

Recommended logical fields:

* `id`
* `job_id`
* `job_schedule_id`
  * nullable for manual runs
* `status`
* `scheduled_for`
* `started_at`
* `finished_at`
* `attempt`
* `input_payload`
* `output_payload`
* `error_message`
* `created_at`
* `updated_at`

This is the execution unit of the system.
Queue dispatch and consumption should operate on Job Runs, not Job definitions.

### Job Lock

A Job Lock is a lease used to suppress duplicate execution of the same Job Run.

Required logical fields:

* `job_run_id`
* `lease_until`
* `updated_at`

The lock is treated as a lease, not as a permanent lock.
The design does not assume perfect atomicity between run state updates and lock release.

## Queue Message

The queue message payload should be minimal.

```json
{ "jobRunId": "01J..." }
```

The queue must not carry the full payload or job state.
It should only deliver `jobRunId`, while the source of truth remains in the storage adapter.

## Run Status Model

The initial run statuses are:

* `scheduled`
* `queued`
* `running`
* `succeeded`
* `failed`
* `canceled`

Meaning:

* `scheduled`
  * run exists in storage
  * not yet enqueued
  * becomes dispatchable when `scheduled_for <= now`
* `queued`
  * already dispatched to the queue
  * waiting for consumer pickup
* `running`
  * acquired by a consumer and currently executing a handler
* `succeeded`
  * completed successfully
* `failed`
  * ended without retry, or exceeded retry limit
* `canceled`
  * removed from execution by an external action

## State Transitions

Base transitions for a Job Run:

* create run
  * a new run is created as `scheduled`
* dispatch
  * a run with `status = scheduled` and `scheduled_for <= now` is sent to the queue
  * dispatch moves the run to `queued`
* consume start
  * after acquiring a lock, the consumer moves the run from `queued` to `running`
* success
  * `running -> succeeded`
* retry
  * `running -> scheduled`
  * increments `attempt` and sets a new `scheduled_for`
* terminal failure
  * `running -> failed`

State transitions should be idempotent and must tolerate duplicate processing under at-least-once delivery.

## Create Protocol

`jobs.create(...)` should create a Job Run.

For a manual or one-shot invocation it does the following:

* resolves the Job definition
* creates a `job_runs` row
* sets `job_schedule_id = null` for direct manual creation
* stores `runAt` into `scheduled_for` if provided
* may dispatch immediately when `runAt <= now`
* only registers the run when `runAt > now`, leaving later dispatch to the dispatcher

When deduplication is used, deduplication applies to run creation, not to the Job definition itself.

## Schedule Dispatch Protocol

The dispatcher has two responsibilities.

### 1. Dispatch due runs

Select Job Runs that satisfy:

* `status = scheduled`
* `scheduled_for <= now`

Then send each selected `jobRunId` to the queue.

### 2. Materialize due schedules

Select Job Schedules that satisfy:

* `enabled = true`
* `next_run_at <= now`

For each due schedule:

* create a Job Run
* stamp `job_id`
* stamp `job_schedule_id`
* set `scheduled_for`
* advance `next_run_at` to the next due time

This allows one global scheduler trigger to handle:

* one-shot delayed runs
* retries
* recurring jobs

## Consume Protocol

For each queue message, `jobs.consume(...)` does the following:

1. validates schema version
2. reads the Job Run row from `jobRunId`
3. resolves the Job definition from `job_id`
4. acquires a Job Lock using a lease
5. moves the Job Run from `queued` to `running`
6. restores the input payload
7. executes the handler
8. moves the Job Run to `succeeded` on success
9. increments `attempt` and sets `scheduled` plus a new `scheduled_for` when retryable
10. moves the Job Run to `failed` when not retryable

Lock release may fail, so the design relies on lease expiry for natural recovery.
Any remaining chance of re-execution must ultimately be absorbed by handler idempotency.

## Ownership Boundaries

Kumofire Jobs owns:

* job definition protocol
* schedule protocol
* run state
* retry state
* lock state
* dispatch / consume protocol

The application owns:

* handler implementation
* business results produced by handlers
* API exposure and authorization

The application reads status through Job Runs and reads final business results from its own tables or storage after completion.

## Adapters

Kumofire Jobs core does not depend directly on a specific database or message queue.
Instead, it implements the protocol through a storage adapter and a queue adapter interface.

### Storage Adapter

The storage adapter is responsible for at least:

* managing Job definitions
* managing Job schedules
* creating Job Runs
* fetching Job Runs and Job definitions
* persisting run status transitions
* listing dispatchable runs
* listing due schedules
* updating retry state
* advancing schedule state
* acquiring and expiring lease locks
* validating schema version

The initial implementation uses a D1 adapter.

### Queue Adapter

The queue adapter is responsible for at least:

* sending `jobRunId` messages
* receiving messages in a form the consumer can interpret

The initial implementation uses a Cloudflare Queues adapter.

## Design Intent

This separation keeps the core protocol and job lifecycle vendor-agnostic while still allowing Cloudflare to be the first concrete adapter implementation.

The three-way split:

* `jobs`
* `job_schedules`
* `job_runs`

is the intended long-term model because it separates:

* what the job is
* when it should run
* what actually happened
