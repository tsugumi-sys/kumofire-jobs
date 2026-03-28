import { describe, expect, it } from "vitest";
import {
	type CommandExecution,
	type CommandResult,
	parseCloudflareMigrateOptions,
	runCloudflareCli,
} from "./cloudflare/cli";

function createDependencies(params?: {
	results?: Array<CommandResult>;
	interactive?: boolean;
	confirmed?: boolean;
}) {
	const executions: CommandExecution[] = [];
	const logs: string[] = [];
	const errors: string[] = [];
	const results = [...(params?.results ?? [])];

	return {
		executions,
		logs,
		errors,
		deps: {
			async execute(command: CommandExecution): Promise<CommandResult> {
				executions.push(command);
				const next = results.shift();
				if (!next) {
					throw new Error(`Missing fake result for ${command.command}`);
				}
				return next;
			},
			async confirm() {
				return params?.confirmed ?? true;
			},
			log(message: string) {
				logs.push(message);
			},
			error(message: string) {
				errors.push(message);
			},
			isInteractive() {
				return params?.interactive ?? true;
			},
		},
	};
}

describe("cloudflare cli option parsing", () => {
	it("parses migrate options", () => {
		expect(
			parseCloudflareMigrateOptions([
				"--remote",
				"--database",
				"jobs-db",
				"--config",
				"wrangler.jsonc",
				"--cwd",
				"examples/cloudflare",
				"--dry-run",
				"--yes",
			]),
		).toEqual({
			target: "remote",
			database: "jobs-db",
			config: "wrangler.jsonc",
			cwd: "examples/cloudflare",
			dryRun: true,
			yes: true,
		});
	});

	it("rejects missing database", () => {
		expect(() => parseCloudflareMigrateOptions(["--remote"])).toThrowError(
			"Missing required flag: --database <name>",
		);
	});
});

describe("cloudflare cli migrate command", () => {
	it("prints dry-run output and does not apply migrations", async () => {
		const { deps, executions, logs } = createDependencies({
			results: [
				{
					stdout: JSON.stringify({
						results: [{ kumofire_table_exists: 1 }],
					}),
					stderr: "",
					exitCode: 0,
				},
				{
					stdout: JSON.stringify({
						results: [{ kumofire_version: 0 }],
					}),
					stderr: "",
					exitCode: 0,
				},
			],
		});

		await runCloudflareCli(
			[
				"cloudflare",
				"migrate",
				"--remote",
				"--database",
				"jobs-db",
				"--dry-run",
			],
			deps,
		);

		expect(executions).toHaveLength(2);
		expect(logs).toContain("Pending migrations: 3");
		expect(
			logs.some((line) =>
				line.startsWith("wrangler d1 execute jobs-db --remote"),
			),
		).toBe(true);
		expect(logs.at(-1)).not.toBe("Done. Schema version is now 3.");
	});

	it("prompts and applies pending migrations", async () => {
		const { deps, executions, logs } = createDependencies({
			results: [
				{
					stdout: JSON.stringify({
						results: [{ kumofire_table_exists: 0 }],
					}),
					stderr: "",
					exitCode: 0,
				},
				{
					stdout: "",
					stderr: "",
					exitCode: 0,
				},
				{
					stdout: "",
					stderr: "",
					exitCode: 0,
				},
				{
					stdout: "",
					stderr: "",
					exitCode: 0,
				},
				{
					stdout: JSON.stringify({
						results: [{ kumofire_table_exists: 1 }],
					}),
					stderr: "",
					exitCode: 0,
				},
				{
					stdout: JSON.stringify({
						results: [{ kumofire_version: 3 }],
					}),
					stderr: "",
					exitCode: 0,
				},
			],
		});

		await runCloudflareCli(
			["cloudflare", "migrate", "--local", "--database", "jobs-db"],
			deps,
		);

		expect(executions).toHaveLength(6);
		expect(executions[1]).toMatchObject({
			command: "wrangler",
			args: expect.arrayContaining(["--local", "--yes"]),
		});
		expect(executions[2]).toMatchObject({
			command: "wrangler",
			args: expect.arrayContaining(["--local", "--yes"]),
		});
		expect(executions[3]).toMatchObject({
			command: "wrangler",
			args: expect.arrayContaining(["--local", "--yes"]),
		});
		expect(logs).toContain("Applying migration 1: init");
		expect(logs).toContain("Applying migration 2: job_schedules");
		expect(logs).toContain("Applying migration 3: schedule_keys");
		expect(logs).toContain("Done. Schema version is now 3.");
	});

	it("fails in non-interactive mode without --yes", async () => {
		const { deps } = createDependencies({
			interactive: false,
			results: [
				{
					stdout: JSON.stringify({
						results: [{ kumofire_table_exists: 0 }],
					}),
					stderr: "",
					exitCode: 0,
				},
			],
		});

		await expect(
			runCloudflareCli(
				["cloudflare", "migrate", "--remote", "--database", "jobs-db"],
				deps,
			),
		).rejects.toThrowError(
			"Confirmation required for apply mode. Re-run with --yes in non-interactive environments.",
		);
	});
});
