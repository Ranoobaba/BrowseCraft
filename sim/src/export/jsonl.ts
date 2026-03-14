/** JSONL helpers shared by collection, export, and offline analysis scripts. */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ZodSchema } from "zod";

/** Read newline-delimited JSON into validated records. */
export async function readJsonl<T>(path: string, schema: ZodSchema<T>): Promise<T[]> {
  const contents = await readFile(path, "utf8");
  const records: T[] = [];

  for (const [index, line] of contents.split("\n").entries()) {
    const stripped = line.trim();
    if (!stripped) {
      continue;
    }
    records.push(schema.parse(JSON.parse(stripped), { path: [index + 1] }));
  }

  return records;
}

/** Write validated records as JSONL. */
export async function writeJsonl<T>(path: string, schema: ZodSchema<T>, records: readonly T[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const payload = records.map((record) => JSON.stringify(schema.parse(record))).join("\n");
  await writeFile(path, payload.length > 0 ? `${payload}\n` : "", "utf8");
}
