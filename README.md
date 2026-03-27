# Kumofire Jobs

Kumofire Jobs is a simple queue-based asynchronous job system for Cloudflare Workers.

It supports:

* one-shot jobs
* cron-based recurring jobs

## Why This Exists

If you are familiar with Cloudflare, you can build a similar asynchronous job system yourself.
But in practice, you still need to solve the same set of requirements:

* register jobs in durable storage
* dispatch ready jobs to a queue
* consume queue messages and run handlers
* handle retries
* handle idempotency
* handle execution locks
* track job status

Building that flow repeatedly across projects is painful.

Kumofire Jobs centralizes that lifecycle into one reusable module so projects can share the same:

* job state model
* D1 and Queue integration
* migration flow
* dispatch and consume behavior
* retry, locking, and status semantics

## How It Works On Cloudflare

This library is queue-based.
On Cloudflare, your Worker exposes `fetch()`, `scheduled()`, and `queue()`.
`fetch()` registers jobs in D1, Cloudflare Cron triggers the dispatcher on `scheduled()`, and the dispatcher pushes ready jobs into Cloudflare Queue for the consumer on `queue()` to process.

```
[ PHASE 1: REGISTRATION ]         [ PHASE 2: DISPATCH ]          [ PHASE 3: EXECUTION ]
 -------------------------         ---------------------          ----------------------

 +-----------------------+         +-------------------+          +--------------------+
 |  Your Worker (API)    |         |  Cloudflare Cron  |          |  Cloudflare Queue  |
 |  (Registering a job)  |         |  (The heartbeat)  |          |  (The trigger)     |
 +-----------+-----------+         +---------+---------+          +---------+----------+
             |                               |                              |
             | 1. Create Job                 | 2. Periodically              | 4. Pick up
             v                               v  (Dispatch Tick)             v
     +-------+-------+               +-------+-------+              +-------+-------+
     |      D1       | <-----------+ |  Dispatcher   | +----------> |    Consumer   |
     | (Job Storage) |   3. Find     |  (Runtime)    |   4. Push    |    (Runtime)  |
     +---------------+      Ready    +---------------+              +-------+-------+
                            Jobs                                            |
                                                                            | 5. Run
                                                                            v
                                                                    +-------+-------+
                                                                    |  Your Handler |
                                                                    |  (Email, etc) |
                                                                    +---------------+
```

| Phase | Component | Behavior |
| --- | --- | --- |
| 1. Registration | Your Worker (API) | Register a job and save its payload and execution time in D1. |
| 2. Dispatch | Cloudflare Cron + Dispatcher | Run the dispatch tick, find ready jobs in D1, and push them into Cloudflare Queue. |
| 3. Execution | Consumer + Your Handler | Consume queue messages and run your handler code, such as sending an email. |

## Quick Setup

Install:

```bash
npm install @kumofire/jobs
```

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

Add a Cron Trigger to your Worker config so ready jobs are periodically dispatched:

```jsonc
{
  "triggers": {
    "crons": ["* * * * *"]
  }
}
```

With this config, Cloudflare calls `scheduled()` every minute.
That lets the Worker scan D1 and put ready jobs into the queue.

## Example

Quick Cloudflare Worker shape:

```ts
import {
  createCloudflareRuntime,
  type JobRunMessage,
} from "@kumofire/jobs";

type Bindings = {
  DB: D1Database;
  JOBS_QUEUE: Queue<JobRunMessage>;
};

const runtime = createCloudflareRuntime({
  handlers: {
    email: async ({ job }) => {
      console.log("processing", job.id);
    },
    "save-record": async ({ job, cloudflare }) => {
      await cloudflare.db
        .prepare("INSERT INTO example_saved_records (id, value) VALUES (?, ?)")
        .bind(crypto.randomUUID(), JSON.stringify(job.payload))
        .run();
    },
  },
});

function resources(env: Bindings) {
  return {
    db: env.DB,
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

  queue(batch: MessageBatch<JobRunMessage>, env: Bindings) {
    return runtime.consumeBatch(batch, resources(env));
  },
};
```

Create a one-shot delayed job:

```ts
await jobs.create({
  name: "email",
  payload: { to: "user@example.com" },
  runAt: new Date("2026-03-27T01:00:00.000Z"),
});
```

Create a cron-based recurring job:

```ts
await jobs.createSchedule({
  name: "email",
  payload: { to: "user@example.com" },
  scheduleType: "cron",
  scheduleExpr: "*/5 * * * *",
});
```

## See More Details

* [Cloudflare example](https://github.com/tsugumi-sys/kumofire-jobs/tree/main/examples/cloudflare)
* [Cloudflare migration guide](https://github.com/tsugumi-sys/kumofire-jobs/blob/main/docs/cloudflare/migration.md)
* [Cloudflare runtime guide](https://github.com/tsugumi-sys/kumofire-jobs/blob/main/docs/cloudflare/README.md)
* [TypeScript package](https://github.com/tsugumi-sys/kumofire-jobs/tree/main/typescript)
