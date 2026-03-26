import { requiredSchemaVersion, schemaMigrations } from "./schema";

export interface CloudflareMigrateOptions {
	target: "local" | "remote";
	database: string;
	config?: string;
	cwd?: string;
	dryRun: boolean;
	yes: boolean;
}

export interface CommandExecution {
	command: string;
	args: string[];
	cwd?: string;
}

export interface CommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface CloudflareCliDependencies {
	execute(command: CommandExecution): Promise<CommandResult>;
	confirm(message: string): Promise<boolean>;
	log(message: string): void;
	error(message: string): void;
	isInteractive(): boolean;
}

export class CloudflareCliError extends Error {
	readonly exitCode: number;

	constructor(message: string, exitCode = 1) {
		super(message);
		this.name = "CloudflareCliError";
		this.exitCode = exitCode;
	}
}

type SchemaMigration = (typeof schemaMigrations)[number];

function toPosixPath(path: string): string {
	return path.replaceAll("\\", "/");
}

function quoteShellArg(value: string): string {
	if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) {
		return value;
	}

	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function formatCommand(command: string, args: string[]): string {
	return [command, ...args].map(quoteShellArg).join(" ");
}

function withOptionalString<T extends Record<string, unknown>>(
	record: T,
	key: string,
	value: string | undefined,
): T & Record<string, unknown> {
	if (value === undefined) {
		return record;
	}

	return {
		...record,
		[key]: value,
	};
}

function buildWranglerArgs(
	options: CloudflareMigrateOptions,
	params: { sql: string; json: boolean; yes: boolean },
): string[] {
	const args = [
		"d1",
		"execute",
		options.database,
		options.target === "local" ? "--local" : "--remote",
		"--command",
		params.sql,
	];

	if (params.json) {
		args.push("--json");
	}

	if (params.yes) {
		args.push("--yes");
	}

	if (options.config) {
		args.push("--config", options.config);
	}

	if (options.cwd) {
		args.push("--cwd", options.cwd);
	}

	return args;
}

function findNumberField(value: unknown, fieldName: string): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return null;
	}

	if (Array.isArray(value)) {
		for (const entry of value) {
			const nested = findNumberField(entry, fieldName);
			if (nested !== null) {
				return nested;
			}
		}

		return null;
	}

	if (typeof value !== "object" || value === null) {
		return null;
	}

	const record = value as Record<string, unknown>;
	const direct = record[fieldName];
	if (typeof direct === "number" && Number.isFinite(direct)) {
		return direct;
	}

	if (typeof direct === "string") {
		const parsed = Number(direct);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}

	for (const nestedValue of Object.values(record)) {
		const nested = findNumberField(nestedValue, fieldName);
		if (nested !== null) {
			return nested;
		}
	}

	return null;
}

async function executeWranglerJson(
	deps: CloudflareCliDependencies,
	options: CloudflareMigrateOptions,
	sql: string,
): Promise<unknown> {
	const execution = withOptionalString(
		{
			command: "wrangler",
			args: buildWranglerArgs(options, { sql, json: true, yes: false }),
		},
		"cwd",
		options.cwd,
	) as CommandExecution;
	const result = await deps.execute(execution);

	if (result.exitCode !== 0) {
		const detail =
			result.stderr.trim() || result.stdout.trim() || "unknown error";
		throw new CloudflareCliError(`Wrangler command failed: ${detail}`);
	}

	try {
		return JSON.parse(result.stdout);
	} catch {
		throw new CloudflareCliError(
			`Wrangler command did not return valid JSON: ${result.stdout.trim() || "<empty>"}`,
		);
	}
}

async function getCurrentSchemaVersion(
	deps: CloudflareCliDependencies,
	options: CloudflareMigrateOptions,
): Promise<number> {
	const tableCheckSql =
		"SELECT COUNT(*) AS kumofire_table_exists FROM sqlite_master WHERE type = 'table' AND name = 'kumofire_schema_version'";
	const tableCheckResult = await executeWranglerJson(
		deps,
		options,
		tableCheckSql,
	);
	const tableExists = findNumberField(
		tableCheckResult,
		"kumofire_table_exists",
	);

	if (tableExists === null) {
		throw new CloudflareCliError(
			"Could not determine whether kumofire_schema_version exists from Wrangler output.",
		);
	}

	if (tableExists === 0) {
		return 0;
	}

	const versionSql =
		"SELECT COALESCE(MAX(version), 0) AS kumofire_version FROM kumofire_schema_version";
	const versionResult = await executeWranglerJson(deps, options, versionSql);
	const currentVersion = findNumberField(versionResult, "kumofire_version");

	if (currentVersion === null) {
		throw new CloudflareCliError(
			"Could not determine current schema version from Wrangler output.",
		);
	}

	return currentVersion;
}

function parseFlagValue(
	args: string[],
	index: number,
	flag: string,
): { value: string; nextIndex: number } {
	const value = args[index + 1];
	if (!value || value.startsWith("--")) {
		throw new CloudflareCliError(`Missing value for ${flag}`);
	}

	return { value, nextIndex: index + 1 };
}

export function parseCloudflareMigrateOptions(
	args: string[],
): CloudflareMigrateOptions {
	let database: string | undefined;
	let config: string | undefined;
	let cwd: string | undefined;
	let target: CloudflareMigrateOptions["target"] | undefined;
	let dryRun = false;
	let yes = false;

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];

		switch (arg) {
			case "--local":
				if (target) {
					throw new CloudflareCliError(
						"Specify exactly one of --local or --remote.",
					);
				}
				target = "local";
				break;
			case "--remote":
				if (target) {
					throw new CloudflareCliError(
						"Specify exactly one of --local or --remote.",
					);
				}
				target = "remote";
				break;
			case "--database": {
				const parsed = parseFlagValue(args, index, "--database");
				database = parsed.value;
				index = parsed.nextIndex;
				break;
			}
			case "--config": {
				const parsed = parseFlagValue(args, index, "--config");
				config = parsed.value;
				index = parsed.nextIndex;
				break;
			}
			case "--cwd": {
				const parsed = parseFlagValue(args, index, "--cwd");
				cwd = parsed.value;
				index = parsed.nextIndex;
				break;
			}
			case "--dry-run":
				dryRun = true;
				break;
			case "--yes":
				yes = true;
				break;
			default:
				throw new CloudflareCliError(`Unknown argument: ${arg}`);
		}
	}

	if (!target) {
		throw new CloudflareCliError("Specify exactly one of --local or --remote.");
	}

	if (!database) {
		throw new CloudflareCliError("Missing required flag: --database <name>");
	}

	return withOptionalString(
		withOptionalString(
			{
				target,
				database,
				dryRun,
				yes,
			},
			"config",
			config,
		),
		"cwd",
		cwd,
	) as CloudflareMigrateOptions;
}

function createConfirmationMessage(
	options: CloudflareMigrateOptions,
	commands: string[],
): string {
	const location = options.target === "local" ? "local" : "remote";
	const lines = [
		`About to apply ${commands.length} Kumofire Jobs migration${commands.length === 1 ? "" : "s"} to the ${location} D1 database "${options.database}".`,
		"Command:",
		...commands,
		"Continue? [y/N]",
	];

	return lines.join("\n");
}

function createNoPendingOutput(
	options: CloudflareMigrateOptions,
	currentVersion: number,
): string[] {
	return [
		`Target: ${options.target}`,
		`Database: ${options.database}`,
		`Current version: ${currentVersion}`,
		`Required version: ${requiredSchemaVersion}`,
		"Status: up to date",
	];
}

function createDryRunOutput(params: {
	options: CloudflareMigrateOptions;
	currentVersion: number;
	commands: string[];
	migrations: SchemaMigration[];
}): string[] {
	const lines = [
		`Target: ${params.options.target}`,
		`Database: ${params.options.database}`,
		`Current version: ${params.currentVersion}`,
		`Required version: ${requiredSchemaVersion}`,
		`Pending migrations: ${params.migrations.length}`,
	];

	if (params.commands.length > 0) {
		lines.push("Command:");
		lines.push(...params.commands);
	}

	return lines;
}

function createApplyOutput(params: {
	options: CloudflareMigrateOptions;
	currentVersion: number;
	commands: string[];
	migrations: SchemaMigration[];
}): string[] {
	const lines = [
		`Target: ${params.options.target}`,
		`Database: ${params.options.database}`,
		`Current version: ${params.currentVersion}`,
		`Required version: ${requiredSchemaVersion}`,
		`Pending migrations: ${params.migrations.length}`,
	];

	if (params.commands.length > 0) {
		lines.push("Command:");
		lines.push(...params.commands);
	}

	return lines;
}

export async function runCloudflareMigrate(
	options: CloudflareMigrateOptions,
	deps: CloudflareCliDependencies,
): Promise<void> {
	const currentVersion = await getCurrentSchemaVersion(deps, options);
	const pendingMigrations = schemaMigrations.filter(
		(migration) => migration.version > currentVersion,
	);

	if (pendingMigrations.length === 0) {
		for (const line of createNoPendingOutput(options, currentVersion)) {
			deps.log(line);
		}
		return;
	}

	const commands = pendingMigrations.map((migration) =>
		formatCommand(
			"wrangler",
			buildWranglerArgs(options, {
				sql: migration.sql,
				json: false,
				yes: true,
			}),
		),
	);

	const output = options.dryRun
		? createDryRunOutput({
				options,
				currentVersion,
				commands,
				migrations: pendingMigrations,
			})
		: createApplyOutput({
				options,
				currentVersion,
				commands,
				migrations: pendingMigrations,
			});

	for (const line of output) {
		deps.log(line);
	}

	if (options.dryRun) {
		return;
	}

	if (!options.yes) {
		if (!deps.isInteractive()) {
			throw new CloudflareCliError(
				"Confirmation required for apply mode. Re-run with --yes in non-interactive environments.",
			);
		}

		const confirmed = await deps.confirm(
			createConfirmationMessage(options, commands),
		);
		if (!confirmed) {
			throw new CloudflareCliError("Migration canceled by user.");
		}
	}

	for (const [index, migration] of pendingMigrations.entries()) {
		deps.log(`Applying migration ${migration.version}: ${migration.name}`);

		const execution = withOptionalString(
			{
				command: "wrangler",
				args: buildWranglerArgs(options, {
					sql: migration.sql,
					json: false,
					yes: true,
				}),
			},
			"cwd",
			options.cwd,
		) as CommandExecution;
		const result = await deps.execute(execution);
		if (result.exitCode !== 0) {
			const detail =
				result.stderr.trim() || result.stdout.trim() || "unknown error";
			throw new CloudflareCliError(`Wrangler command failed: ${detail}`);
		}

		if (index === pendingMigrations.length - 1) {
			const finalVersion = await getCurrentSchemaVersion(deps, options);
			if (finalVersion !== requiredSchemaVersion) {
				throw new CloudflareCliError(
					`Cloudflare migration failed: database schema is at version ${finalVersion} but version ${requiredSchemaVersion} is required.`,
				);
			}

			deps.log(`Done. Schema version is now ${finalVersion}.`);
		}
	}
}

function createHelpText(): string {
	return [
		"Usage:",
		"  kumofire-jobs cloudflare migrate --local|--remote --database <name> [--config <path>] [--cwd <path>] [--dry-run] [--yes]",
		"",
		"Examples:",
		"  kumofire-jobs cloudflare migrate --local --database kumofire-jobs-example",
		"  kumofire-jobs cloudflare migrate --remote --database kumofire-jobs-example",
		"  kumofire-jobs cloudflare migrate --remote --database kumofire-jobs-example --dry-run",
	].join("\n");
}

export async function runCloudflareCli(
	args: string[],
	deps: CloudflareCliDependencies,
): Promise<void> {
	if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
		deps.log(createHelpText());
		return;
	}

	const [group, command, ...rest] = args;
	if (group !== "cloudflare" || command !== "migrate") {
		throw new CloudflareCliError(
			`Unsupported command: ${args.join(" ")}\n\n${createHelpText()}`,
		);
	}

	await runCloudflareMigrate(parseCloudflareMigrateOptions(rest), deps);
}

export function formatDisplayedWranglerCommand(
	options: CloudflareMigrateOptions,
	sql: string,
): string {
	return formatCommand(
		"wrangler",
		buildWranglerArgs(options, {
			sql,
			json: false,
			yes: true,
		}),
	);
}

export function normalizeCwdForDisplay(
	cwd: string | undefined,
): string | undefined {
	return cwd ? toPosixPath(cwd) : undefined;
}
