import { createJobs } from "../core";
import type {
	ConsumeResult,
	CreateJobsOptions,
	DispatchResult,
	JobHandlerMap,
	JobRunMessage,
} from "../protocol";
import {
	type CloudflareQueue,
	createCloudflareQueueAdapter,
	createD1StorageAdapter,
	type D1Database,
} from "./index";

export interface CloudflareQueueMessage<TBody = unknown> {
	body: TBody;
	ack(): void;
	retry(): void;
}

export interface CloudflareMessageBatch<TBody = unknown> {
	messages: CloudflareQueueMessage<TBody>[];
}

export interface CloudflareRuntimeResources {
	db: D1Database;
	queue: CloudflareQueue<JobRunMessage>;
}

export interface CloudflareConsumeBatchResult {
	processed: number;
	acked: number;
	retried: number;
	results: ConsumeResult[];
}

type CloudflareRuntimeCoreOptions<THandlers extends JobHandlerMap> = Omit<
	CreateJobsOptions<THandlers>,
	"storage" | "queue"
>;

export interface CreateCloudflareRuntimeOptions<THandlers extends JobHandlerMap>
	extends CloudflareRuntimeCoreOptions<THandlers> {}

function isJobRunMessage(value: unknown): value is JobRunMessage {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const candidate = value as Partial<JobRunMessage>;
	return candidate.version === 1 && typeof candidate.jobRunId === "string";
}

export function createCloudflareRuntime<THandlers extends JobHandlerMap>(
	options: CreateCloudflareRuntimeOptions<THandlers>,
) {
	function bind(resources: CloudflareRuntimeResources) {
		return createJobs({
			...options,
			storage: createD1StorageAdapter({ db: resources.db }),
			queue: createCloudflareQueueAdapter(resources.queue),
		});
	}

	return {
		bind,

		dispatchScheduled(
			resources: CloudflareRuntimeResources,
			input?: { limit?: number },
		): Promise<DispatchResult> {
			return bind(resources).dispatch(input);
		},

		async consumeBatch(
			batch: CloudflareMessageBatch<unknown>,
			resources: CloudflareRuntimeResources,
		): Promise<CloudflareConsumeBatchResult> {
			const jobs = bind(resources);
			const results: ConsumeResult[] = [];
			let acked = 0;
			let retried = 0;

			for (const message of batch.messages) {
				if (!isJobRunMessage(message.body)) {
					message.ack();
					acked += 1;
					continue;
				}

				try {
					const result = await jobs.consume(message.body);
					message.ack();
					acked += 1;
					results.push(result);
				} catch {
					message.retry();
					retried += 1;
				}
			}

			return {
				processed: batch.messages.length,
				acked,
				retried,
				results,
			};
		},
	};
}
