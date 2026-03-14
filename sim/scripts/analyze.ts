import { Command } from "commander";
import { resolve } from "node:path";
import { readJsonl } from "../src/export/jsonl.js";
import { trajectoryRecordSchema } from "../src/types.js";

const program = new Command();

program.requiredOption("--input <path>", "trajectory JSONL");
program.parse();

const options = program.opts<{ input: string }>();
const records = await readJsonl(resolve(options.input), trajectoryRecordSchema);

const byTier = new Map<string, { count: number; rewardSum: number; successCount: number; primitiveSum: number }>();
for (const record of records) {
  const current = byTier.get(record.tier) ?? { count: 0, rewardSum: 0, successCount: 0, primitiveSum: 0 };
  current.count += 1;
  current.rewardSum += record.rewardNormalized;
  current.successCount += record.rewardBinary;
  current.primitiveSum += record.primitiveCount ?? 0;
  byTier.set(record.tier, current);
}

console.log(JSON.stringify({
  count: records.length,
  byTier: Object.fromEntries([...byTier.entries()].map(([tier, stats]) => [tier, {
    count: stats.count,
    meanReward: stats.rewardSum / stats.count,
    successRate: stats.successCount / stats.count,
    meanPrimitiveCount: stats.primitiveSum / stats.count,
  }])),
}, null, 2));
