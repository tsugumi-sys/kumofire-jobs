# Cloudflare Hono Example

This example shows a minimal Worker product built with:

* Hono for HTTP routes
* D1 for job state
* Cloudflare Queues for delivery
* `@kumofire/jobs` for create, dispatch, consume, and status lookup

## Endpoints

* `GET /`
  * health response
* `POST /jobs/email`
  * create an email job
* `GET /jobs/:jobId`
  * read run status

The Worker also exports:

* `scheduled`
  * dispatches due jobs from D1 into the queue
* `queue`
  * consumes queue messages and runs handlers

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
pnpm dev
```

## Request Example

```bash
curl -X POST http://127.0.0.1:8787/jobs/email \
  -H 'content-type: application/json' \
  -d '{"to":"user@example.com","subject":"Welcome","body":"Hello"}'
```

Then check the run:

```bash
curl http://127.0.0.1:8787/jobs/<job-id>
```
