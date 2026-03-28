# Kumofire Jobs

Queue-based asynchronous jobs for Cloudflare Workers.

Kumofire Jobs gives you a reusable execution model for:

* one-shot jobs
* delayed jobs
* cron-based recurring jobs
* queue-backed execution on Cloudflare Workers

Instead of rebuilding the same job lifecycle in each project, this library centralizes:

* durable job registration
* scheduled dispatch
* queue consumption
* retry and lease handling
* run status tracking

## Start Here

* [Overview](./overview.md)
* [Cloudflare API Overview](./apis/cloudflare.md)
* [Architecture](./architecture.md)
* [Development](./development.md)

## Minimal Hono Example

```ts
import { Hono } from "hono";
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
        kumofireJobRunId: job.id,
        to: job.payload.to,
        subject: job.payload.subject,
      });
    },
  },
});

function getResources(env: Bindings) {
  return {
    db: env.JOBS_DB,
    queue: env.JOBS_QUEUE,
  };
}

const app = new Hono<{ Bindings: Bindings }>();

app.post("/jobs/email", async (c) => {
  const payload = await c.req.json<EmailJobPayload>();
  const jobs = runtime.bind(getResources(c.env));
  const { kumofireJobRunId } = await jobs.create({
    name: "email",
    payload,
  });

  return c.json({ kumofire_job_run_id: kumofireJobRunId }, 202);
});

export default {
  fetch: app.fetch,

  queue(batch: MessageBatch<JobRunMessage>, env: Bindings) {
    return runtime.consumeBatch(batch, getResources(env));
  },
};
```
