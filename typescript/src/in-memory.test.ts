import { describe, expect, it } from "vitest";

import {
	createInMemoryQueueAdapter,
	createInMemoryStorageAdapter,
	createJobs,
} from "./index";

describe("in-memory adapter", () => {
	it("creates a job and dispatches it immediately when due", async () => {
		const now = new Date("2026-03-25T00:00:00.000Z");
		const storage = createInMemoryStorageAdapter();
		const queue = createInMemoryQueueAdapter();
		const jobs = createJobs({
			storage,
			queue,
			now: () => now,
			handlers: {
				email: () => {},
			},
		});

		const result = await jobs.create({
			name: "email",
			payload: { to: "user@example.com" },
		});

		expect(queue.messages).toEqual([{ version: 1, jobRunId: result.jobId }]);
		await expect(jobs.getStatus(result.jobId)).resolves.toMatchObject({
			id: result.jobId,
			status: "queued",
			attempt: 0,
		});
		await expect(storage.getRun(result.jobId)).resolves.toMatchObject({
			id: result.jobId,
			jobId: "email",
			jobName: "email",
			status: "queued",
		});
	});

	it("creates a future run as scheduled until dispatch() enqueues it", async () => {
		let now = new Date("2026-03-25T00:00:00.000Z");
		const storage = createInMemoryStorageAdapter();
		const queue = createInMemoryQueueAdapter();
		const jobs = createJobs({
			storage,
			queue,
			now: () => now,
			handlers: {
				report: () => {},
			},
		});

		const result = await jobs.create({
			name: "report",
			payload: { reportId: "weekly" },
			runAt: new Date("2026-03-25T00:05:00.000Z"),
		});

		expect(queue.messages).toEqual([]);
		await expect(jobs.getStatus(result.jobId)).resolves.toMatchObject({
			status: "scheduled",
		});

		now = new Date("2026-03-25T00:05:00.000Z");
		await expect(jobs.dispatch()).resolves.toEqual({ dispatched: 1 });
		expect(queue.messages).toEqual([{ version: 1, jobRunId: result.jobId }]);
		await expect(jobs.getStatus(result.jobId)).resolves.toMatchObject({
			status: "queued",
		});
	});

	it("marks a job as succeeded after the handler completes", async () => {
		const now = new Date("2026-03-25T00:00:00.000Z");
		const storage = createInMemoryStorageAdapter();
		const queue = createInMemoryQueueAdapter();
		let observedDefinitionId: string | null = null;
		const jobs = createJobs({
			storage,
			queue,
			now: () => now,
			handlers: {
				email: ({ definition }) => {
					observedDefinitionId = definition.id;
				},
			},
		});

		const { jobId } = await jobs.create({
			name: "email",
			payload: { to: "user@example.com" },
		});

		const message = queue.messages[0];
		if (!message) {
			throw new Error("expected a queue message");
		}
		await expect(jobs.consume(message)).resolves.toEqual({
			outcome: "succeeded",
			jobRunId: jobId,
		});
		await expect(jobs.getStatus(jobId)).resolves.toMatchObject({
			status: "succeeded",
			attempt: 0,
			lastError: null,
		});
		expect(observedDefinitionId).toBe("email");
	});

	it("moves a failed run back to scheduled when retries remain", async () => {
		let now = new Date("2026-03-25T00:00:00.000Z");
		const storage = createInMemoryStorageAdapter();
		const queue = createInMemoryQueueAdapter();
		const jobs = createJobs({
			storage,
			queue,
			now: () => now,
			retry: {
				maxAttempts: 3,
				getNextRunAt: ({ now: currentNow }) =>
					new Date(currentNow.getTime() + 5_000),
			},
			handlers: {
				email: () => {
					throw new Error("temporary failure");
				},
			},
		});

		const { jobId } = await jobs.create({
			name: "email",
			payload: { to: "user@example.com" },
		});

		const message = queue.messages[0];
		if (!message) {
			throw new Error("expected a queue message");
		}
		await expect(jobs.consume(message)).resolves.toEqual({
			outcome: "retried",
			jobRunId: jobId,
		});
		await expect(jobs.getStatus(jobId)).resolves.toMatchObject({
			status: "scheduled",
			attempt: 1,
			lastError: "temporary failure",
			scheduledFor: "2026-03-25T00:00:05.000Z",
		});

		now = new Date("2026-03-25T00:00:05.000Z");
		await expect(jobs.dispatch()).resolves.toEqual({ dispatched: 1 });
		expect(queue.messages).toEqual([
			{ version: 1, jobRunId: jobId },
			{ version: 1, jobRunId: jobId },
		]);
		await expect(jobs.getStatus(jobId)).resolves.toMatchObject({
			status: "queued",
			attempt: 1,
		});
	});

	it("marks a job as failed when retries are exhausted", async () => {
		let now = new Date("2026-03-25T00:00:00.000Z");
		const storage = createInMemoryStorageAdapter();
		const queue = createInMemoryQueueAdapter();
		const jobs = createJobs({
			storage,
			queue,
			now: () => now,
			retry: {
				maxAttempts: 2,
				getNextRunAt: ({ now: currentNow }) =>
					new Date(currentNow.getTime() + 5_000),
			},
			handlers: {
				email: () => {
					throw new Error("permanent failure");
				},
			},
		});

		const { jobId } = await jobs.create({
			name: "email",
			payload: { to: "user@example.com" },
		});

		const message = queue.messages[0];
		if (!message) {
			throw new Error("expected a queue message");
		}
		await jobs.consume(message);
		now = new Date("2026-03-25T00:00:05.000Z");
		await expect(jobs.dispatch()).resolves.toEqual({ dispatched: 1 });

		const retryMessage = queue.messages[1];
		if (!retryMessage) {
			throw new Error("expected a retry queue message");
		}

		await expect(jobs.consume(retryMessage)).resolves.toEqual({
			outcome: "failed",
			jobRunId: jobId,
		});
		await expect(jobs.getStatus(jobId)).resolves.toMatchObject({
			status: "failed",
			attempt: 2,
			lastError: "permanent failure",
		});
	});

	it("returns an existing job when dedupeKey matches", async () => {
		const now = new Date("2026-03-25T00:00:00.000Z");
		const storage = createInMemoryStorageAdapter();
		const queue = createInMemoryQueueAdapter();
		const jobs = createJobs({
			storage,
			queue,
			now: () => now,
			handlers: {
				email: () => {},
			},
		});

		const first = await jobs.create({
			name: "email",
			payload: { to: "user@example.com" },
			dedupeKey: "send:123",
		});
		const second = await jobs.create({
			name: "email",
			payload: { to: "other@example.com" },
			dedupeKey: "send:123",
		});

		expect(second).toEqual(first);
		expect(queue.messages).toHaveLength(1);
	});
});
