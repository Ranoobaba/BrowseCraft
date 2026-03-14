import { Command } from "commander";
import { resolve } from "node:path";
import { createAnthropicModelCall, createAnthropicVisionJudge, collectTrajectories } from "../src/collect/index.js";
import { writeJsonl } from "../src/export/jsonl.js";
import { trajectoryRecordSchema } from "../src/types.js";

const program = new Command();

program
  .requiredOption("--mode <mode>", "build | creative | text_qa")
  .requiredOption("--model <model>", "model id")
  .requiredOption("--seed <seed>", "base seed", (value) => Number.parseInt(value, 10))
  .requiredOption("--output <path>", "output JSONL path")
  .option("--per-tier <count>", "tasks per tier", (value) => Number.parseInt(value, 10))
  .option("--count <count>", "task count for creative mode", (value) => Number.parseInt(value, 10))
  .option("--concurrency <count>", "concurrency", (value) => Number.parseInt(value, 10), 4)
  .option("--vision-model <model>", "vision judge model id", "claude-3-5-haiku-latest");

program.parse();

const options = program.opts<{
  mode: "build" | "creative" | "text_qa";
  model: string;
  seed: number;
  output: string;
  perTier?: number;
  count?: number;
  concurrency: number;
  visionModel: string;
}>();

const modelCall = createAnthropicModelCall(options.model, process.env.ANTHROPIC_API_KEY);
const visionJudge = options.mode === "creative"
  ? createAnthropicVisionJudge(options.visionModel, process.env.ANTHROPIC_API_KEY)
  : undefined;
const records = await collectTrajectories({
  mode: options.mode,
  seed: options.seed,
  model: options.model,
  modelCall,
  perTier: options.perTier,
  count: options.count,
  concurrency: options.concurrency,
  visionJudge,
});

await writeJsonl(resolve(options.output), trajectoryRecordSchema, records);
console.log(JSON.stringify({ count: records.length, output: resolve(options.output) }, null, 2));
