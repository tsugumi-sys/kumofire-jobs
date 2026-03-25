import { Hono } from "hono";
import {
	createCloudflareRuntime,
	type CloudflareMessageBatch,
	type CloudflareQueue,
	type D1Database,
	type JobRunMessage,
} from "@kumofire/jobs";

type EmailJobPayload = {
	to: string;
	subject: string;
	body: string;
};

type Bindings = {
	JOBS_DB: D1Database;
	JOBS_QUEUE: CloudflareQueue<JobRunMessage>;
};

const runtime = createCloudflareRuntime({
	handlers: {
		email: async ({ job }) => {
			const payload = job.payload as EmailJobPayload;

			console.log("processing email job", {
				jobRunId: job.id,
				to: payload.to,
				subject: payload.subject,
			});
		},
	},
});

function getResources(env: Bindings) {
	return {
		db: env.JOBS_DB,
		queue: env.JOBS_QUEUE,
	};
}

const app = new Hono<{ Bindings: Bindings }>();

app.get("/", (c) => {
	return c.json({
		name: "kumofire-jobs-cloudflare-example",
	});
});

app.post("/jobs/email", async (c) => {
	const payload = await c.req.json<EmailJobPayload>();
	const jobs = runtime.bind(getResources(c.env));
	const { jobId } = await jobs.create({
		name: "email",
		payload,
	});

	return c.json({ jobId }, 202);
});

app.get("/jobs/:jobId", async (c) => {
	const jobs = runtime.bind(getResources(c.env));
	const status = await jobs.getStatus(c.req.param("jobId"));

	if (!status) {
		return c.json({ error: "Job run not found" }, 404);
	}

	return c.json(status);
});

export default {
	fetch: app.fetch,

	queue(batch: CloudflareMessageBatch<unknown>, env: Bindings) {
		return runtime.consumeBatch(batch, getResources(env));
	},

	scheduled(_controller: ScheduledController, env: Bindings) {
		return runtime.dispatchScheduled(getResources(env));
	},
};
