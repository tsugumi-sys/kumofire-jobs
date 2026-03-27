import type { JobQueueAdapter, JobRunMessage } from "../protocol";
import type { CloudflareQueue } from "./types";

export function createCloudflareQueueAdapter(
	queue: CloudflareQueue<JobRunMessage>,
): JobQueueAdapter {
	return {
		send(message) {
			return queue.send(message);
		},
	};
}
