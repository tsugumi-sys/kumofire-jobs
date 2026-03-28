# API Docs

This directory contains the API-oriented documentation for `@kumofire/jobs`.

Start here if you want the public integration surface rather than the architecture or migration details.

## Pages

* [Cloudflare API Overview](./cloudflare.md)
  * runtime-first overview for Cloudflare Workers
  * includes the migration CLI entrypoint
* [Create API](./create.md)
  * `jobs.create(...)`
  * one-shot and delayed job creation
* [Dispatch API](./dispatch.md)
  * `jobs.dispatch(...)`
  * moving due work from storage into the queue
* [Consume API](./consume.md)
  * `jobs.consume(...)`
  * executing queued runs and applying retry behavior
* [Schedules API](./schedules.md)
  * recurring schedule creation and management
  * includes `scheduleKey`-based APIs


## Scope

These pages focus on the public runtime and jobs APIs.

For operational and background details, see:

* [Architecture notes](../architecture.md)
