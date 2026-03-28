# Cloudflare API Overview

This page describes the Cloudflare-facing integration pattern for `@kumofire/jobs`.

Focus on the runtime boundary first:

* use `createCloudflareRuntime(...)` at the Worker boundary
* use `runtime.bind({ db, queue })` inside request handlers when you need the `jobs` API
* use `runtime.dispatchScheduled(...)` from the Worker `scheduled()` handler
* use `runtime.consumeBatch(...)` from the Worker `queue()` handler

This page is an overview.
API-specific details live in the other pages under `docs/apis/`.

## Runtime Model

The Cloudflare integration is built around explicit resources:

* `db`
  * a Cloudflare D1 binding
* `queue`
  * a Cloudflare Queue binding carrying `JobRunMessage`

The runtime does not take the raw Worker `env` object directly.
Extract the required bindings and pass only those bindings into the runtime.

## CLI

Before using the Cloudflare runtime against D1, apply the Kumofire Jobs schema migrations.

Run migrations for local D1:

```bash
npm exec -- kumofire-jobs cloudflare migrate --local --database kumofire-jobs-example
```

Run migrations for remote D1:

```bash
npm exec -- kumofire-jobs cloudflare migrate --remote --database kumofire-jobs-example
```

Preview pending migrations without applying them:

```bash
npm exec -- kumofire-jobs cloudflare migrate --remote --database kumofire-jobs-example --dry-run
```

The Cloudflare runtime expects the database schema to already be up to date.
If the D1 schema version is too old, runtime calls fail fast until the migrations are applied.

## Minimal Worker Example

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
      console.log("processing email job", {
        kumofireJobRunId: job.id,
        payload: job.payload,
      });
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
      const { kumofireJobRunId } = await jobs.create({
        name: "email",
        payload,
      });

      return Response.json({ kumofire_job_run_id: kumofireJobRunId }, { status: 202 });
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

## How The Pieces Fit Together

In a typical Worker:

* `fetch()`
  * create one-shot or delayed runs
  * create or manage recurring schedules
  * read run status or schedule state
* `scheduled()`
  * call `runtime.dispatchScheduled(...)`
  * move due runs and due schedules into the queue
* `queue()`
  * call `runtime.consumeBatch(...)`
  * execute job handlers

## Runtime Entry Points

### `createCloudflareRuntime({ handlers, ...options })`

Creates a reusable runtime definition.
This is where you register job handlers.

### `runtime.bind({ db, queue })`

Returns the `jobs` API bound to specific D1 and Queue resources.
Use this in `fetch()` handlers or other request-scoped entrypoints.

### `runtime.dispatchScheduled({ db, queue }, { limit? })`

Dispatches due work from D1 into the queue.
This is usually called from the Worker `scheduled()` handler.

### `runtime.consumeBatch(batch, { db, queue })`

Consumes a Cloudflare Queue batch and executes job handlers.
This is usually called from the Worker `queue()` handler.

## Lifecycle Summary

The Cloudflare path looks like this:

1. `jobs.create(...)` creates a job run.
2. `jobs.createSchedule(...)` or `jobs.upsertSchedule(...)` stores a recurring rule in D1.
3. `runtime.dispatchScheduled(...)` moves due work into the queue.
4. `runtime.consumeBatch(...)` validates messages and runs handlers.
5. Each run moves through `scheduled`, `queued`, `running`, then `succeeded`, `retried`, or `failed`.

## Queue Message Shape

Cloudflare queue messages are intentionally small:

```json
{ "version": 1, "kumofireJobRunId": "job_run_1" }
```

The queue does not carry the full job payload.
D1 remains the source of truth.

## Related Pages

* [Create API](./create.md)
* [Dispatch API](./dispatch.md)
* [Consume API](./consume.md)
* [Schedules API](./schedules.md)
