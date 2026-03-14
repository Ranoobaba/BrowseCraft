import { Command } from "commander";
import { createAnthropicModelCall, collectTrajectories } from "../src/collect/index.js";

const program = new Command();

program
  .requiredOption("--model <model>", "model id")
  .requiredOption("--seed <seed>", "base seed", (value) => Number.parseInt(value, 10))
  .option("--per-tier <count>", "tasks per tier", (value) => Number.parseInt(value, 10), 2)
  .option("--concurrency <count>", "concurrency", (value) => Number.parseInt(value, 10), 4);

program.parse();

const options = program.opts<{
  model: string;
  seed: number;
  perTier: number;
  concurrency: number;
}>();

const records = await collectTrajectories({
  mode: "build",
  seed: options.seed,
  model: options.model,
  modelCall: createAnthropicModelCall(options.model, process.env.ANTHROPIC_API_KEY),
  perTier: options.perTier,
  concurrency: options.concurrency,
});

const byTier = new Map<string, { count: number; rewardSum: number; success: number }>();
for (const record of records) {
  const current = byTier.get(record.tier) ?? { count: 0, rewardSum: 0, success: 0 };
  current.count += 1;
  current.rewardSum += record.rewardNormalized;
  current.success += record.rewardBinary;
  byTier.set(record.tier, current);
}

console.log(JSON.stringify({
  model: options.model,
  seed: options.seed,
  perTier: options.perTier,
  summary: Object.fromEntries([...byTier.entries()].map(([tier, stats]) => [tier, {
    count: stats.count,
    meanReward: stats.rewardSum / stats.count,
    successRate: stats.success / stats.count,
  }])),
}, null, 2));
