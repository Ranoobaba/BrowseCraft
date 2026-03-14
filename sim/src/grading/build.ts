/** Build-task grading and reward composition. */

import { rewardBreakdownSchema, rewardConfigSchema, type BuildTaskSpec, type RewardBreakdown, type RewardConfig } from "../types.js";
import { HeadlessVoxelWorld } from "../world/headless-world.js";
import { exactMatch, groundingRatio, iouScore, isConnected, placementMap, preservationScore, spanLength } from "./metrics.js";

/** Grade one executed build episode. */
export function gradeBuildEpisode(args: {
  task: BuildTaskSpec;
  finalWorld: HeadlessVoxelWorld;
  worldDiff: BuildTaskSpec["targetBlocks"];
  executionSuccess: boolean;
  primitiveCount: number;
  config?: Partial<RewardConfig>;
}): RewardBreakdown {
  const config = rewardConfigSchema.parse(args.config ?? {});
  const expectedChanged = placementMap(args.task.targetBlocks);
  const actualChanged = placementMap(args.worldDiff);
  const formatValid = args.executionSuccess;
  const actualPrimitiveCount = Math.max(args.primitiveCount, 1);
  const efficiencyBase = Math.min(1, args.task.expectedPrimitiveCount / actualPrimitiveCount);

  let correctnessScore: number;
  const details: Record<string, string | number | boolean> = {
    expectedPrimitiveCount: args.task.expectedPrimitiveCount,
    actualPrimitiveCount: args.primitiveCount,
  };

  if (args.task.tier === "t1_absolute" || args.task.tier === "t2_relative_single_ref") {
    correctnessScore = exactMatch(actualChanged, expectedChanged);
  } else if (args.task.tier === "t5_modification") {
    const changedIou = iouScore(actualChanged, expectedChanged);
    const preservation = preservationScore(args.finalWorld, args.task.preservedBlocks);
    correctnessScore = (0.7 * changedIou) + (0.3 * preservation);
    details.changedIou = roundScore(changedIou);
    details.preservation = roundScore(preservation);
  } else {
    correctnessScore = iouScore(actualChanged, expectedChanged);
  }

  const structuralScore = computeStructuralScore(args.task, args.finalWorld);
  const effectiveEfficiency = correctnessScore < config.efficiencyMinCorrectness ? 0 : efficiencyBase * correctnessScore;
  const formatScore = formatValid ? 1 : 0;

  let rewardRaw: number;
  let rewardNormalized: number;

  if (config.formatMode === "gate") {
    if (!formatValid) {
      rewardRaw = 0;
      rewardNormalized = 0;
    } else {
      rewardRaw = (config.weightCorrectness * correctnessScore)
        + (config.weightEfficiency * effectiveEfficiency)
        + (config.weightStructural * structuralScore);
      const maxRaw = config.weightCorrectness + config.weightEfficiency + config.weightStructural;
      rewardNormalized = maxRaw === 0 ? 0 : clamp01(rewardRaw / maxRaw);
    }
  } else {
    rewardRaw = (config.weightFormat * formatScore)
      + (config.weightCorrectness * correctnessScore)
      + (config.weightEfficiency * effectiveEfficiency)
      + (config.weightStructural * structuralScore);
    const maxRaw = config.weightFormat + config.weightCorrectness + config.weightEfficiency + config.weightStructural;
    rewardNormalized = maxRaw === 0 ? 0 : clamp01(rewardRaw / maxRaw);
  }

  const rewardBinary = rewardNormalized >= config.binaryRewardThreshold ? 1 : 0;
  details.correctness = roundScore(correctnessScore);
  details.efficiencyBase = roundScore(efficiencyBase);
  details.efficiencyEffective = roundScore(effectiveEfficiency);
  details.efficiencyMinCorrectness = roundScore(config.efficiencyMinCorrectness);
  details.binaryRewardThreshold = roundScore(config.binaryRewardThreshold);
  details.structural = roundScore(structuralScore);

  return rewardBreakdownSchema.parse({
    taskId: args.task.taskId,
    tier: args.task.tier,
    taskMode: "build",
    formatValid,
    formatScore,
    correctnessScore,
    efficiencyScore: effectiveEfficiency,
    structuralScore,
    rewardRaw,
    rewardNormalized,
    rewardBinary,
    details,
  });
}

function computeStructuralScore(task: BuildTaskSpec, world: HeadlessVoxelWorld): number {
  const checks = task.structuralChecks;
  const targetNonAir = new Set(task.targetBlocks.filter((block) => block.blockId !== "minecraft:air").map((block) => `${block.x},${block.y},${block.z}`));
  const achievedNonAir = new Set([...targetNonAir].filter((coord) => {
    const [x, y, z] = coord.split(",").map(Number) as [number, number, number];
    return world.blockAt([x, y, z]) !== "minecraft:air";
  }));
  const components: number[] = [];

  if (checks.requireConnected) {
    components.push(isConnected(achievedNonAir) ? 1 : 0);
  }
  if (checks.requireGrounded) {
    components.push(groundingRatio(world, achievedNonAir));
  }
  if (checks.spanAxis !== null && checks.minSpan !== null) {
    components.push(spanLength(achievedNonAir, checks.spanAxis) >= checks.minSpan ? 1 : 0);
  }

  if (components.length === 0) {
    return 1;
  }
  return components.reduce((sum, score) => sum + score, 0) / components.length;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function roundScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
