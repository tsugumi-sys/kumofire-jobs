# Overview

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

The integration boundary is intentionally narrow:

* Kumofire queue messages expose only `kumofireJobRunId`
* your application should persist only `kumofire_job_run_id`
* your application should fetch job status through the Kumofire API
* your application should not directly query Kumofire internal tables with SQL

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

## Read Next

* [Architecture](./architecture.md)
* [Cloudflare API Overview](./apis/cloudflare.md)
