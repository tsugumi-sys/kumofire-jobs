import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const rootDir = resolve(import.meta.dirname, "..");
const sqlPath = resolve(rootDir, "sql/sqlite/0001_init.sql");
const outputPath = resolve(rootDir, "src/cloudflare/schema.ts");

const sql = readFileSync(sqlPath, "utf8").trimEnd();

const output = `// This file is generated from sql/sqlite/0001_init.sql.
// Do not edit it directly.

export const requiredSchemaVersion = 1;

export const schemaMigrations = [
\t{
\t\tversion: 1,
\t\tname: "init",
\t\tsql: ${JSON.stringify(sql)},
\t},
] as const;
`;

writeFileSync(outputPath, output);
