#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import process from "node:process";
import {
	type CommandExecution,
	CloudflareCliError,
	runCloudflareCli,
} from "./cloudflare/cli";

async function execute(command: CommandExecution) {
	return await new Promise<{
		stdout: string;
		stderr: string;
		exitCode: number;
	}>((resolve, reject) => {
		const child = spawn(command.command, command.args, {
			cwd: command.cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";

		child.stdout.on("data", (chunk: Buffer | string) => {
			stdout += String(chunk);
		});
		child.stderr.on("data", (chunk: Buffer | string) => {
			stderr += String(chunk);
		});
		child.on("error", (error) => {
			reject(
				new CloudflareCliError(
					`Failed to start Wrangler command "${command.command}": ${error.message}`,
				),
			);
		});
		child.on("close", (code) => {
			resolve({
				stdout,
				stderr,
				exitCode: code ?? 1,
			});
		});
	});
}

async function confirm(message: string): Promise<boolean> {
	const readline = createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	try {
		const answer = await readline.question(`${message}\n`);
		const normalized = answer.trim().toLowerCase();
		return normalized === "y" || normalized === "yes";
	} finally {
		readline.close();
	}
}

async function main() {
	try {
		await runCloudflareCli(process.argv.slice(2), {
			execute,
			confirm,
			log(message) {
				process.stdout.write(`${message}\n`);
			},
			error(message) {
				process.stderr.write(`${message}\n`);
			},
			isInteractive() {
				return Boolean(process.stdin.isTTY && process.stdout.isTTY);
			},
		});
	} catch (error) {
		if (error instanceof CloudflareCliError) {
			process.stderr.write(`${error.message}\n`);
			process.exitCode = error.exitCode;
			return;
		}

		throw error;
	}
}

void main();
