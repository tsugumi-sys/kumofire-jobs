import { describe, expect, it } from "vitest";

import {
	createInMemoryQueueAdapter,
	createInMemoryStorageAdapter,
	createJobs,
} from "./index";

describe("createJobs", () => {
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

		expect(queue.messages).toEqual([{ version: 1, jobId: result.jobId }]);
		await expect(jobs.getStatus(result.jobId)).resolves.toMatchObject({
			id: result.jobId,
			status: "queued",
			attempt: 0,
		});
	});

	it("registers a future job without dispatching it until dispatch() runs", async () => {
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

		now = new Date("2026-03-25T00:05:00.000Z");
		await expect(jobs.dispatch()).resolves.toEqual({ dispatched: 1 });
		expect(queue.messages).toEqual([{ version: 1, jobId: result.jobId }]);
	});

	it("marks a job as succeeded after the handler completes", async () => {
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
			jobId,
		});
		await expect(jobs.getStatus(jobId)).resolves.toMatchObject({
			status: "succeeded",
			attempt: 0,
			lastError: null,
		});
	});

	it("requeues a failed job when retries remain", async () => {
		const now = new Date("2026-03-25T00:00:00.000Z");
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
			jobId,
		});
		await expect(jobs.getStatus(jobId)).resolves.toMatchObject({
			status: "queued",
			attempt: 1,
			lastError: "temporary failure",
			nextRunAt: "2026-03-25T00:00:05.000Z",
		});
	});

	it("marks a job as failed when retries are exhausted", async () => {
		const now = new Date("2026-03-25T00:00:00.000Z");
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
		const retriedJob = await storage.getJob(jobId);
		if (!retriedJob) {
			throw new Error("expected a retried job");
		}
		await storage.seed({ ...retriedJob, status: "queued" });

		await expect(jobs.consume(message)).resolves.toEqual({
			outcome: "failed",
			jobId,
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
