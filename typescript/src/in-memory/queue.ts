import type { JobQueueAdapter, JobRunMessage } from "../protocol";

export interface InMemoryQueueAdapter extends JobQueueAdapter {
	messages: JobRunMessage[];
}

export function createInMemoryQueueAdapter(): InMemoryQueueAdapter {
	const messages: JobRunMessage[] = [];

	return {
		messages,
		async send(message) {
			messages.push(message);
		},
	};
}
