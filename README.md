# Kumofire Jobs

Kumofire Jobs is a job processing library for Cloudflare Workers.

## Why This Module?

If you are building multiple Cloudflare Worker projects, you often need the same job execution foundation in each one:

* create a job run
* dispatch due work
* consume queue messages
* retry failed runs
* track status in durable storage

Re-implementing that lifecycle in every project creates repeated schema work, repeated queue wiring, and repeated failure handling.

Kumofire Jobs exists to centralize that logic into one reusable module so each Cloudflare project can share:

* the same runtime contract
* the same D1 and Queue integration model
* the same migration flow
* the same job status semantics

## How To Use

Install:

```bash
npm install @kumofire/jobs
```

Run migrations for local D1:

```bash
kumofire-jobs cloudflare migrate --local --database kumofire-jobs-example
```

Run migrations for remote D1:

```bash
kumofire-jobs cloudflare migrate --remote --database kumofire-jobs-example
```

Preview pending migrations without applying them:

```bash
kumofire-jobs cloudflare migrate --remote --database kumofire-jobs-example --dry-run
```

Quick Cloudflare Worker shape:

```ts
import {
  createCloudflareRuntime,
  type JobRunMessage,
} from "@kumofire/jobs";

type Bindings = {
  JOBS_DB: D1Database;
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

  queue(batch: MessageBatch<JobRunMessage>, env: Bindings) {
    return runtime.consumeBatch(batch, resources(env));
  },
};
```

The migration CLI:

* checks the current D1 schema version
* compares it with the library-required version
* prints the exact Wrangler command before apply
* asks for confirmation unless `--yes` is set

## See More Details

* [TypeScript package](https://github.com/tsugumi-sys/kumofire-jobs/tree/main/typescript)
* [Cloudflare runtime guide](https://github.com/tsugumi-sys/kumofire-jobs/blob/main/docs/cloudflare/README.md)
* [Cloudflare migration guide](https://github.com/tsugumi-sys/kumofire-jobs/blob/main/docs/cloudflare/migration.md)
* [Cloudflare migration CLI proposal](https://github.com/tsugumi-sys/kumofire-jobs/blob/main/docs/cloudflare/migration-cli.md)
* [Cloudflare example](https://github.com/tsugumi-sys/kumofire-jobs/tree/main/examples/cloudflare)
