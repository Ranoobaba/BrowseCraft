import { Command } from "commander";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  buildTaskSchema,
  creativeBuildTaskSchema,
  textQaTaskSchema,
} from "../src/types.js";
import { generateBuildTasks } from "../src/tasks/build.js";
import { generateCreativeTasks } from "../src/tasks/creative.js";
import { generateTextQaTasks } from "../src/text-qa/index.js";

const program = new Command();

program
  .requiredOption("--mode <mode>", "build | creative | text-qa")
  .requiredOption("--seed <seed>", "base seed", (value) => Number.parseInt(value, 10))
  .requiredOption("--count <count>", "task count or per-tier count", (value) => Number.parseInt(value, 10))
  .requiredOption("--output <path>", "output JSONL path");

program.parse();

const options = program.opts<{
  mode: "build" | "creative" | "text-qa";
  seed: number;
  count: number;
  output: string;
}>();

let records: unknown[];

switch (options.mode) {
  case "build":
    records = generateBuildTasks({ seed: options.seed, perTier: options.count }).map((record) => buildTaskSchema.parse(record));
    break;
  case "creative":
    records = generateCreativeTasks({ seed: options.seed, count: options.count }).map((record) => creativeBuildTaskSchema.parse(record));
    break;
  case "text-qa":
    records = generateTextQaTasks({ seed: options.seed, perTier: options.count }).map((record) => textQaTaskSchema.parse(record));
    break;
  default:
    throw new Error(`Unsupported mode: ${options.mode}`);
}

const outputPath = resolve(options.output);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""), "utf8");
