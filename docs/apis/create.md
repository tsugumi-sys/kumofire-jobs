# `jobs.create(...)`

Use `jobs.create(...)` to create a one-shot job run.

This API is for:

* immediate execution
* delayed execution with `runAt`
* application-triggered background work

It is not for recurring schedules.
Use the schedules APIs for recurring work.

## Signature

```ts
await jobs.create({
  name,
  payload,
  runAt?,
  maxAttempts?,
  dedupeKey?,
});
```

Return shape:

```ts
{ kumofireJobRunId: string }
```

## Example

Create a job that should run immediately:

```ts
const { kumofireJobRunId } = await jobs.create({
  name: "email",
  payload: {
    to: "user@example.com",
    subject: "Welcome",
    body: "Hello",
  },
});
```

Create a job that should run later:

```ts
const { kumofireJobRunId } = await jobs.create({
  name: "email",
  payload: {
    to: "user@example.com",
    subject: "Reminder",
    body: "Hello again",
  },
  runAt: new Date("2026-03-27T01:00:00.000Z"),
});
```

## Input Fields

### `name`

The registered job name.
It must match a handler in the runtime handler map.

### `payload`

The JSON payload passed to the job handler.

### `runAt`

Optional execution time.

* if omitted, the run is due immediately
* if in the future, the run stays scheduled until dispatch moves it to the queue

### `maxAttempts`

Optional override for the maximum number of attempts for this run.

### `dedupeKey`

Optional idempotency key.
If a run with the same dedupe key already exists, the existing run is returned instead of creating a duplicate.

## Behavior

`jobs.create(...)` does the following:

1. verifies schema support
2. ensures job definitions exist
3. creates a job run in storage
4. if the run is already due, moves it to `queued` immediately
5. sends a queue message when the run is queued

## State Changes

A newly created run starts as `scheduled`.

If `runAt` is omitted or `runAt <= now`, the run is immediately moved to `queued`.

If `runAt > now`, the run remains `scheduled` until `jobs.dispatch(...)` or `runtime.dispatchScheduled(...)` picks it up.

## When To Use It

Use `jobs.create(...)` when:

* a user action creates background work now
* you need a delayed one-shot task
* you need application-side idempotency with `dedupeKey`

Do not use it for recurring business rules such as daily digests or periodic notifications.
Use the schedules APIs for that.
