# Cloudflare

This document describes the Cloudflare Worker integration surface for `@kumofire/jobs`.

## Runtime Boundary

Use `createCloudflareRuntime(...)` at the Worker boundary.

The Cloudflare runtime expects explicit bindings:

* `db`
  * a Cloudflare D1 binding
* `queue`
  * a Cloudflare Queue binding that sends `JobRunMessage`

The library does not accept a raw Worker `env` object.
User code should extract the specific bindings and pass them in.

## Worker Interfaces

The intended Worker shape is expressed around the standard Worker entrypoints:

* `fetch`
  * create runs
  * query run status
  * expose any application-specific APIs
* `scheduled`
  * call `runtime.dispatchScheduled(...)`
  * move due runs from D1 into the queue
* `queue`
  * call `runtime.consumeBatch(...)`
  * validate queue messages and execute handlers

That keeps the Cloudflare layer separate from any specific HTTP framework.

## Minimal Runtime Shape

```ts
import {
  createCloudflareRuntime,
  type CloudflareMessageBatch,
  type CloudflareQueue,
  type D1Database,
  type JobRunMessage,
} from "@kumofire/jobs";

type Bindings = {
  JOBS_DB: D1Database;
  JOBS_QUEUE: CloudflareQueue<JobRunMessage>;
};

const runtime = createCloudflareRuntime({
  handlers: {
    email: async ({ job }) => {
      console.log("send email", job.payload);
    },
  },
});

function resources(env: Bindings) {
  return {
    db: env.JOBS_DB,
    queue: env.JOBS_QUEUE,
  };
}

export default {
  async fetch(request: Request, env: Bindings) {
    const jobs = runtime.bind(resources(env));

    if (new URL(request.url).pathname === "/jobs/email" && request.method === "POST") {
      const payload = await request.json();
      const { jobId } = await jobs.create({
        name: "email",
        payload,
      });

      return Response.json({ jobId }, { status: 202 });
    }

    return new Response("Not found", { status: 404 });
  },

  scheduled(_controller: ScheduledController, env: Bindings) {
    return runtime.dispatchScheduled(resources(env));
  },

  queue(batch: CloudflareMessageBatch<unknown>, env: Bindings) {
    return runtime.consumeBatch(batch, resources(env));
  },
};
```

## Lifecycle

The current Cloudflare path is built around the single-run lifecycle:

1. `jobs.create(...)` creates a `scheduled` run.
2. `jobs.createSchedule(...)` registers a recurring schedule rule in D1.
3. If `runAt <= now`, the run is moved to `queued` immediately and a queue message is sent.
4. `runtime.dispatchScheduled(...)` materializes due schedules, moves due runs to `queued`, and sends queue messages.
5. The consumer moves the run through `running`, then `succeeded`, `retried`, or `failed`.

Use `jobs.create(...)` for one-shot runs and delayed runs with `runAt: Date`.
Use `jobs.createSchedule(...)` for recurring schedules.
Currently, recurring schedules support `scheduleType: "cron"`.
Use `timezone` when you want the cron rule evaluated in a specific time zone.

Queue messages stay intentionally small:

```json
{ "version": 1, "jobRunId": "job_run_1" }
```

The queue does not carry the full payload.
D1 remains the source of truth.

## Queue Consume Behavior

`runtime.consumeBatch(...)` behaves as follows:

* malformed queue bodies are acknowledged and ignored
* valid messages for missing or canceled runs resolve to `ignored`
* runtime-level failures cause the queue message to be retried

That keeps the queue integration aligned with Worker queue semantics while leaving job state in D1.

## Binding Setup

Your Worker needs:

* one D1 database
* one Queue producer binding
* one Queue consumer binding for the same queue
* one Cron Trigger that calls the Worker `scheduled()` handler

Example `wrangler.jsonc`:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "kumofire-jobs-cloudflare-example",
  "main": "src/index.ts",
  "compatibility_date": "2026-03-25",
  "triggers": {
    "crons": ["* * * * *"]
  },
  "d1_databases": [
    {
      "binding": "JOBS_DB",
      "database_name": "kumofire-jobs-example",
      "database_id": "REPLACE_WITH_REAL_DATABASE_ID"
    }
  ],
  "queues": {
    "producers": [
      {
        "binding": "JOBS_QUEUE",
        "queue": "kumofire-jobs-example"
      }
    ],
    "consumers": [
      {
        "queue": "kumofire-jobs-example"
      }
    ]
  }
}
```

## Cron Trigger Setup

Configure the dispatcher tick in `triggers.crons`.
Each entry is a Cloudflare Cron Trigger expression, and each match invokes your exported `scheduled()` handler.

Example:

```jsonc
{
  "triggers": {
    "crons": ["* * * * *"]
  }
}
```

Recommended default:

* use `* * * * *` to run once per minute
* keep `scheduled()` wired to `runtime.dispatchScheduled(resources(env))`
* treat the Worker cron as a dispatcher tick, not as the job rule itself

That means the Worker cron does not describe individual recurring jobs.
Individual recurring jobs are stored with `jobs.createSchedule({ scheduleType: "cron", scheduleExpr, ... })`.

## Handler And Definition Rules

At runtime, `createJobs(...)` and `createCloudflareRuntime(...)` build definitions from the handler map:

* definition `id` = job name
* definition `name` = job name
* definition `handler` = job name

Binding the same handler map repeatedly is expected.
The D1 adapter persists definitions idempotently.

## Example

A complete Worker example lives at [examples/cloudflare](https://github.com/tsugumi-sys/kumofire-jobs/tree/main/examples/cloudflare).
