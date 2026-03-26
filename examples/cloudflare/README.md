# Cloudflare Hono Example

This example shows a minimal Worker product built with:

* Hono for HTTP routes
* D1 for job state
* Cloudflare Queues for delivery
* Cron Triggers for dispatching ready jobs
* `@kumofire/jobs` for create, dispatch, consume, and status lookup

## Endpoints

* `GET /`
  * health response
* `POST /jobs/email`
  * create an email job
* `POST /jobs/fail-always`
  * create a job that always throws
* `GET /jobs/:jobId`
  * read run status

The Worker also exports:

* `scheduled`
  * dispatches ready jobs from D1 into the queue
* `queue`
  * consumes queue messages and runs handlers

The example Wrangler config includes:

* `triggers.crons = ["* * * * *"]`
  * runs the `scheduled()` handler every minute
  * picks up ready jobs and enqueues them automatically

## Setup

1. Install dependencies.
2. Create a D1 database and a Queue.
3. Update `wrangler.jsonc` with the real D1 database id.
4. Apply Kumofire Jobs migrations before running the Worker.

Example:

```bash
cd examples/cloudflare
pnpm install
wrangler d1 create kumofire-jobs-example
wrangler queues create kumofire-jobs-example
pnpm exec kumofire-jobs cloudflare migrate --local --database kumofire-jobs-example
pnpm dev -- --test-scheduled
```

## Request Example

```bash
curl -X POST http://127.0.0.1:8787/jobs/email \
  -H 'content-type: application/json' \
  -d '{"to":"user@example.com","subject":"Welcome","body":"Hello"}'
```

Failing job:

```bash
curl -X POST http://127.0.0.1:8787/jobs/fail-always \
  -H 'content-type: application/json' \
  -d '{"reason":"expected example failure"}'
```

Then check the run:

```bash
curl http://127.0.0.1:8787/jobs/<job-id>
```

You can also test the scheduled dispatch path locally:

```bash
curl "http://127.0.0.1:8787/__scheduled?cron=*+*+*+*+*"
```
