# Schedules API

Use the schedules API to manage recurring job execution.

This is the API family for:

* creating recurring schedules
* reading recurring schedule state
* updating recurring schedules
* disabling recurring schedules
* reconciling one schedule per application-owned record

## Recommended Model

For application integrations, prefer `scheduleKey`.

A `scheduleKey` is an application-provided stable identifier for a recurring rule, for example:

* `digest:user:123`
* `screening-notification:session:abc`
* `billing-reminder:subscription:sub_456`

This lets the application find and update the same recurring schedule later without depending on raw SQL or first storing an internal schedule id.

## Schedule Shape

Public schedule reads return `JobSchedule | null`.

Current schedule fields:

```ts
type JobSchedule = {
  id: string;
  jobId: string;
  jobName: string;
  scheduleKey: string | null;
  scheduleType: "once" | "interval" | "cron";
  scheduleExpr: string;
  timezone: string | null;
  nextRunAt: string | null;
  lastScheduledAt: string | null;
  enabled: boolean;
  payload: JsonValue;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
};
```

Currently, recurring scheduling support is implemented for `scheduleType: "cron"`.

## `jobs.createSchedule(...)`

Creates a recurring schedule.

```ts
const { scheduleId } = await jobs.createSchedule({
  name: "digest",
  payload: { userId: "user_123" },
  scheduleKey: "digest:user:user_123",
  scheduleType: "cron",
  scheduleExpr: "0 5 * * *",
  timezone: "Asia/Tokyo",
  enabled: true,
});
```

Return shape:

```ts
{ scheduleId: string }
```

Behavior:

* resolves the job definition by `name`
* computes the next run time from the cron rule
* stores the schedule row
* if `enabled` is `false`, stores `nextRunAt = null`

## `jobs.getSchedule(scheduleId)`

Reads a schedule by internal schedule id.

```ts
const schedule = await jobs.getSchedule(scheduleId);
```

Return:

* `JobSchedule | null`

Use this when you already have the internal schedule id.

## `jobs.getScheduleByKey(scheduleKey)`

Reads a schedule by application-owned identity.

```ts
const schedule = await jobs.getScheduleByKey(
  "digest:user:user_123",
);
```

Return:

* `JobSchedule | null`

Use this when your application owns the stable schedule identity.

## `jobs.updateSchedule(scheduleId, patch)`

Updates an existing schedule by internal schedule id.

```ts
const updated = await jobs.updateSchedule(scheduleId, {
  scheduleExpr: "30 6 * * *",
  timezone: "Asia/Tokyo",
  payload: { userId: "user_123" },
  enabled: true,
});
```

Return:

* updated `JobSchedule | null`

Supported fields:

* `name`
* `payload`
* `scheduleType`
* `scheduleExpr`
* `timezone`
* `maxAttempts`
* `enabled`

Behavior:

* omitted fields keep their existing values
* changing timing fields recomputes `nextRunAt`
* setting `enabled: false` clears `nextRunAt`
* changing `name` re-resolves the job definition

## `jobs.updateScheduleByKey(scheduleKey, patch)`

Updates an existing schedule by `scheduleKey`.

```ts
await jobs.updateScheduleByKey("digest:user:user_123", {
  enabled: false,
});
```

Return:

* updated `JobSchedule | null`

This is usually the best update path for application code.

## `jobs.upsertSchedule(...)`

Creates or updates a recurring schedule by `scheduleKey`.

```ts
const { scheduleId } = await jobs.upsertSchedule({
  scheduleKey: "digest:user:user_123",
  name: "digest",
  payload: { userId: "user_123" },
  scheduleType: "cron",
  scheduleExpr: "0 5 * * *",
  timezone: "Asia/Tokyo",
  enabled: true,
});
```

Behavior:

* creates the schedule if it does not exist
* updates the existing schedule if it already exists
* returns the schedule id in both cases

This is the recommended API when the application wants exactly one recurring schedule per business object.

## `jobs.disableSchedule(scheduleId)`

Disables a schedule by internal id.

```ts
await jobs.disableSchedule(scheduleId);
```

Behavior:

* sets `enabled = false`
* sets `nextRunAt = null`
* keeps the schedule row for later inspection or re-enable flows

Return:

* updated `JobSchedule | null`

## `jobs.disableScheduleByKey(scheduleKey)`

Disables a schedule by application-owned key.

```ts
await jobs.disableScheduleByKey("digest:user:user_123");
```

Return:

* updated `JobSchedule | null`

## Typical Application Pattern

Use this pattern when a recurring rule belongs to an application-owned record:

1. create or enable it with `upsertSchedule(...)`
2. look it up later with `getScheduleByKey(...)`
3. update it when business configuration changes
4. disable it when the owning record is turned off

## Notes

The application should not directly query `kumofire_job_schedules` with raw SQL.
Use the schedules API instead.

The Worker cron trigger is a dispatcher tick.
It is not the place where individual recurring business rules are stored.
Individual recurring rules live in Kumofire schedule records.
