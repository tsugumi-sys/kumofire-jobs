# `jobs.consume(...)`

Use `jobs.consume(...)` to execute a queued job run from a `JobRunMessage`.

This is the API that moves a run into `running`, calls the handler, and finalizes the outcome.

## Signature

```ts
await jobs.consume(message);
```

Input shape:

```ts
type JobRunMessage = {
  version: 1;
  kumofireJobRunId: string;
};
```

Return shape:

```ts
type ConsumeResult = {
  outcome: "ignored" | "succeeded" | "retried" | "failed" | "canceled";
  jobRunId: string;
};
```

## Example

```ts
await jobs.consume({
  version: 1,
  kumofireJobRunId: "job_run_123",
});
```

In Cloudflare Workers, this is usually called through:

```ts
await runtime.consumeBatch(batch, { db, queue });
```

## Behavior

`jobs.consume(...)` does the following:

1. validates the message version
2. loads the job run from storage
3. acquires a lease for the run
4. moves the run to `running`
5. resolves the handler for the run's job name
6. executes the handler
7. marks the run as `succeeded`, `retried`, or `failed`
8. releases the lease

## Outcomes

### `ignored`

Returned when the run should not be executed, for example:

* the run does not exist
* the run was canceled
* another consumer already holds the lease
* the run was already moved out of the expected state

### `succeeded`

Returned when the handler completes without throwing.

### `retried`

Returned when the handler throws and retries remain.
The run is moved back to `scheduled` with a new next run time.

### `failed`

Returned when the handler throws and retries are exhausted, or when a required handler is missing.

### `canceled`

Included in the public result type, but the current consume flow treats canceled or missing runs as `ignored`.

## Retry Behavior

Retry timing is controlled by the configured retry policy.

The default policy:

* allows up to 3 attempts
* uses exponential backoff capped at 60 seconds

You can override that policy when creating the jobs runtime.

## Cloudflare Batch Behavior

When using `runtime.consumeBatch(...)`:

* malformed queue messages are acknowledged and ignored
* valid messages are passed to `jobs.consume(...)`
* runtime-level failures cause the queue message to be retried

That keeps queue semantics separate from job state stored in D1.
