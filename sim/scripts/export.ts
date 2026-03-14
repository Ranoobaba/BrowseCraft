import { Command } from "commander";
import { resolve } from "node:path";
import { exportStageManifests } from "../src/export/stage-manifests.js";
import { readJsonl, writeJsonl } from "../src/export/jsonl.js";
import { stageManifestRecordSchema, trajectoryRecordSchema } from "../src/types.js";

const program = new Command();

program
  .requiredOption("--input <path>", "trajectory JSONL")
  .requiredOption("--output-dir <dir>", "output directory")
  .option("--stage <stage>", "single stage to emit");

program.parse();

const options = program.opts<{ input: string; outputDir: string; stage?: "spatial-sft" | "spatial-grpo" | "creative-sft" | "creative-grpo" }>();
const records = (await readJsonl(resolve(options.input), trajectoryRecordSchema)).map((record) => trajectoryRecordSchema.parse(record));
const manifests = exportStageManifests(records);

for (const [stage, rows] of Object.entries(manifests) as Array<[keyof typeof manifests, typeof manifests[keyof typeof manifests]]>) {
  if (options.stage && options.stage !== stage) {
    continue;
  }
  await writeJsonl(resolve(options.outputDir, `${stage}.jsonl`), stageManifestRecordSchema, rows);
}

console.log(JSON.stringify({ outputDir: resolve(options.outputDir), stages: Object.keys(manifests) }, null, 2));
