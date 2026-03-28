# `jobs.dispatch(...)`

Use `jobs.dispatch(...)` to move due work from storage into the queue.

This includes:

* one-shot runs whose scheduled time has arrived
* recurring schedules whose next run is due

## Signature

```ts
await jobs.dispatch({ limit? });
```

Return shape:

```ts
{ dispatched: number }
```

## Example

```ts
const result = await jobs.dispatch({ limit: 100 });

console.log(result.dispatched);
```

In Cloudflare Workers, this is usually called through:

```ts
await runtime.dispatchScheduled({ db, queue });
```

## What It Dispatches

`jobs.dispatch(...)` checks two kinds of due work:

* due recurring schedules
* due scheduled job runs

For recurring schedules, dispatch does more than queue a message.
It first materializes a new run from the schedule, advances the schedule to its next occurrence, and then queues the new run.

For one-shot delayed jobs, dispatch simply moves the run from `scheduled` to `queued` and sends the queue message.

## Behavior

For recurring schedules:

1. read due schedules
2. calculate the next occurrence
3. advance the schedule row
4. create a new run linked to that schedule
5. move the new run to `queued`
6. send a queue message

For ordinary scheduled runs:

1. read due job runs
2. move each run to `queued`
3. send a queue message

## `limit`

Use `limit` to cap how many due items are processed in one dispatch call.

```ts
await jobs.dispatch({ limit: 50 });
```

If omitted, the current default is `100`.

## When To Use It

Use `jobs.dispatch(...)` when your environment needs an explicit dispatch step between storage and execution.

In Cloudflare Workers, wire the dispatcher tick to the Worker `scheduled()` handler and call `runtime.dispatchScheduled(...)`.

## Notes

`jobs.dispatch(...)` does not execute handlers directly.
It only moves due work into the queue.

Actual handler execution happens later through `jobs.consume(...)` or `runtime.consumeBatch(...)`.
