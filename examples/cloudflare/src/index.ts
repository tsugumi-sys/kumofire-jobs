import { Hono } from "hono";
import {
	createCloudflareRuntime,
	type CloudflareJobHandlerContext,
	type JobRunMessage,
} from "@kumofire/jobs";

type EmailJobPayload = {
	to: string;
	subject: string;
	body: string;
};

type AlwaysFailJobPayload = {
	reason?: string;
};

type SaveRecordJobPayload = {
	key: string;
	value: string;
};

type Bindings = {
	JOBS_DB: D1Database;
	JOBS_QUEUE: Queue<JobRunMessage>;
};

async function ensureExampleRecordsTable(db: D1Database) {
	await db
		.prepare(`CREATE TABLE IF NOT EXISTS example_saved_records (
	id TEXT PRIMARY KEY,
	record_key TEXT NOT NULL,
	record_value TEXT NOT NULL,
	job_run_id TEXT NOT NULL,
	created_at TEXT NOT NULL
)`)
		.run();
}

const runtime = createCloudflareRuntime({
	handlers: {
		email: async ({ job }) => {
			const payload = job.payload as EmailJobPayload;

			console.log("processing email job", {
				kumofireJobRunId: job.id,
				to: payload.to,
				subject: payload.subject,
			});
		},
		"fail-always": async ({ job }) => {
			const payload = job.payload as AlwaysFailJobPayload;

			console.log("processing fail-always job", {
				kumofireJobRunId: job.id,
				reason: payload.reason ?? "intentional failure",
			});

			throw new Error(payload.reason ?? "intentional failure");
		},
		"save-record": async (
			context: CloudflareJobHandlerContext<SaveRecordJobPayload>,
		) => {
			const payload = context.job.payload as SaveRecordJobPayload;

			await ensureExampleRecordsTable(context.cloudflare.db);
			await context.cloudflare.db
				.prepare(`INSERT INTO example_saved_records (
	id,
	record_key,
	record_value,
	job_run_id,
	created_at
) VALUES (?, ?, ?, ?, ?)`)
				.bind(
					crypto.randomUUID(),
					payload.key,
					payload.value,
					context.job.id ?? "",
					context.now.toISOString(),
				)
				.run();

			console.log("saved example record", {
				kumofireJobRunId: context.job.id,
				key: payload.key,
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
	const { kumofireJobRunId } = await jobs.create({
		name: "email",
		payload,
	});

	return c.json({ kumofire_job_run_id: kumofireJobRunId }, 202);
});

app.post("/jobs/fail-always", async (c) => {
	const payload = await c.req.json<AlwaysFailJobPayload>();
	const jobs = runtime.bind(getResources(c.env));
	const { kumofireJobRunId } = await jobs.create({
		name: "fail-always",
		payload,
	});

	return c.json({ kumofire_job_run_id: kumofireJobRunId }, 202);
});

app.post("/jobs/save-record", async (c) => {
	const payload = await c.req.json<SaveRecordJobPayload>();
	const jobs = runtime.bind(getResources(c.env));
	const { kumofireJobRunId } = await jobs.create({
		name: "save-record",
		payload,
	});

	return c.json({ kumofire_job_run_id: kumofireJobRunId }, 202);
});

app.get("/jobs/:kumofireJobRunId", async (c) => {
	const jobs = runtime.bind(getResources(c.env));
	const status = await jobs.getStatus(c.req.param("kumofireJobRunId"));

	if (!status) {
		return c.json({ error: "Job run not found" }, 404);
	}

	return c.json(status);
});

export default {
	fetch: app.fetch,

	queue(batch: MessageBatch<JobRunMessage>, env: Bindings) {
		return runtime.consumeBatch(batch, getResources(env));
	},

	scheduled(_controller: ScheduledController, env: Bindings) {
		return runtime.dispatchScheduled(getResources(env));
	},
};
