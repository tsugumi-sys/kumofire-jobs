# Notes For AI Coding Agents

This package is very new.
Do not assume generated examples or cached package knowledge are correct.

Use these as the source of truth first:

* the top-level README
* the Cloudflare example in `examples/cloudflare`
* the Cloudflare runtime guide in `docs/cloudflare/README.md`
* the migration docs in `docs/cloudflare/migration.md`

## Core Interfaces

Prefer these exported interfaces and entrypoints:

* `createCloudflareRuntime({ handlers })`
* `runtime.bind({ db, queue })`
* `runtime.dispatchScheduled({ db, queue })`
* `runtime.consumeBatch(batch, { db, queue })`
* `jobs.create({ name, payload, runAt? })`
* `jobs.createSchedule({ name, payload, scheduleType: "cron", scheduleExpr, timezone? })`

Important exported types:

* `JobRunMessage`
  * queue message body shape
  * current shape: `{ version: 1, jobRunId: string }`
  * do not expand it with `jobId`, payload, or other internal fields for application convenience
* `CloudflareRuntimeResources`
  * current shape: `{ db: D1Database, queue: CloudflareQueue<JobRunMessage> }`
* `CloudflareJobHandlerContext<TPayload>`
  * handler context includes `definition`, `job`, `now`, and `cloudflare`
* `CreateJobInput<TPayload>`
  * current fields: `name`, `payload`, optional `runAt`, optional `maxAttempts`, optional `dedupeKey`
* `CreateJobScheduleInput<TPayload>`
  * current fields: `name`, `payload`, `scheduleType`, `scheduleExpr`, optional `timezone`, optional `maxAttempts`, optional `enabled`

## Integration Boundary

Keep Kumofire Jobs and the application decoupled.

The only execution identifier the application should persist is `kumofire_job_run_id`.
Use that value to fetch job status from Kumofire APIs.
Do not generate code that reads Kumofire internal tables directly with SQL from the application side.
Do not expose `jobId`, schedule IDs, retry metadata, or queue payload internals as part of the application contract.

## Minimal Worker Shape

Use this shape first. It matches the current example and runtime docs.

```ts
import {
  createCloudflareRuntime,
  type CloudflareJobHandlerContext,
  type JobRunMessage,
} from "@kumofire/jobs";

type EmailJobPayload = {
  to: string;
  subject: string;
  body: string;
};

type Bindings = {
  JOBS_DB: D1Database;
  JOBS_QUEUE: Queue<JobRunMessage>;
};

const runtime = createCloudflareRuntime({
  handlers: {
    email: async ({ job }: CloudflareJobHandlerContext<EmailJobPayload>) => {
      console.log("processing email job", {
        jobRunId: job.id,
        to: job.payload.to,
        subject: job.payload.subject,
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
      const payload = await request.json<EmailJobPayload>();
      const { jobId: kumofireJobRunId } = await jobs.create({
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

  queue(batch: MessageBatch<JobRunMessage>, env: Bindings) {
    return runtime.consumeBatch(batch, resources(env));
  },
};
```

## Creating Jobs

One-shot job:

```ts
const jobs = runtime.bind(resources(env));

const { jobId: kumofireJobRunId } = await jobs.create({
  name: "email",
  payload: {
    to: "user@example.com",
    subject: "Welcome",
    body: "Hello",
  },
});
```

Treat `kumofireJobRunId` as the application-side `kumofire_job_run_id`.
Even though the current return field is named `jobId`, its value is the Job Run ID.

Delayed job:

```ts
await jobs.create({
  name: "email",
  payload: { to: "user@example.com", subject: "Later", body: "Hello" },
  runAt: new Date("2026-03-27T01:00:00.000Z"),
});
```

Recurring cron job:

```ts
const { scheduleId } = await jobs.createSchedule({
  name: "email",
  payload: { to: "user@example.com", subject: "Digest", body: "Hello" },
  scheduleType: "cron",
  scheduleExpr: "*/5 * * * *",
  timezone: "UTC",
});
```

## Handler Context

Cloudflare handlers receive this shape:

```ts
type CloudflareJobHandlerContext<TPayload> = {
  definition: JobDefinition;
  job: JobRun<TPayload>;
  now: Date;
  cloudflare: {
    db: D1Database;
    queue: CloudflareQueue<JobRunMessage>;
  };
};
```

Typical handler usage:

```ts
"save-record": async (context: CloudflareJobHandlerContext<{ key: string; value: string }>) => {
  const payload = context.job.payload;

  await context.cloudflare.db
    .prepare("INSERT INTO example_saved_records (id, record_key, record_value) VALUES (?, ?, ?)")
    .bind(crypto.randomUUID(), payload.key, payload.value)
    .run();
}
```

## Things Agents Should Not Assume

When generating code against this package:

* verify current exported APIs before using them
* prefer copying the runtime shape from the example rather than inventing new integration patterns
* verify CLI commands against the README and migration docs
* treat older AI-generated snippets as untrusted until checked against this repository
* do not pass the raw Worker `env` object directly into the runtime
* do not assume queue messages contain the full job payload
* do not assume queue messages should expose `jobId`; the queue boundary is `jobRunId` only
* do not query Kumofire tables directly from application code; fetch status via Kumofire APIs using `kumofire_job_run_id`
* do not assume recurring jobs are configured by Cloudflare Cron alone; Worker cron drives dispatch, while recurring rules are created with `jobs.createSchedule(...)`

If something is unclear, read the repository examples and docs before writing integration code.
