/** Creative-build grading, including structural prefiltering and optional vision judging. */

import { rewardBreakdownSchema, rewardConfigSchema, visionJudgeScoreSchema, type CreativeBuildTaskSpec, type RewardBreakdown, type RewardConfig, type VisionJudgeScore } from "../types.js";
import type { BlockPlacement } from "../types.js";
import { renderCreativeComposite } from "./creative-renderer.js";
import { isConnected } from "./metrics.js";

export type VisionJudge = (input: { prompt: string; image: Buffer }) => Promise<VisionJudgeScore>;

/** Grade one creative build episode. */
export async function gradeCreativeEpisode(args: {
  task: CreativeBuildTaskSpec;
  worldDiff: BlockPlacement[];
  executionSuccess: boolean;
  primitiveCount: number;
  judge?: VisionJudge;
  config?: Partial<RewardConfig>;
}): Promise<RewardBreakdown> {
  const config = rewardConfigSchema.parse(args.config ?? {});
  const formatValid = args.executionSuccess;

  if (!formatValid) {
    return rewardBreakdownSchema.parse({
      taskId: args.task.taskId,
      tier: args.task.category,
      taskMode: "creative_build",
      formatValid: false,
      formatScore: 0,
      correctnessScore: 0,
      efficiencyScore: 0,
      structuralScore: 0,
      rewardRaw: 0,
      rewardNormalized: 0,
      rewardBinary: 0,
      details: {
        heuristicScore: 0,
      },
    });
  }

  const heuristic = creativeStructuralHeuristic(args.worldDiff);
  const efficiency = Math.min(1, 24 / Math.max(args.primitiveCount, 1));

  if (heuristic.score < 0.3 || !args.judge) {
    const rewardNormalized = heuristic.score;
    return rewardBreakdownSchema.parse({
      taskId: args.task.taskId,
      tier: args.task.category,
      taskMode: "creative_build",
      formatValid: true,
      formatScore: 1,
      correctnessScore: heuristic.score,
      efficiencyScore: efficiency,
      structuralScore: heuristic.score,
      rewardRaw: rewardNormalized,
      rewardNormalized,
      rewardBinary: rewardNormalized >= config.binaryRewardThreshold ? 1 : 0,
      details: {
        heuristicScore: roundScore(heuristic.score),
        heuristicBlockCount: heuristic.blockCount,
        heuristicComponentCount: heuristic.componentCount,
        heuristicMaterialDiversity: roundScore(heuristic.materialDiversity),
        heuristicHeightVariation: roundScore(heuristic.heightVariation),
        visionSkipped: true,
      },
    });
  }

  const image = renderCreativeComposite(args.worldDiff);
  const judgeScore = visionJudgeScoreSchema.parse(await args.judge({ prompt: args.task.prompt, image }));
  const rewardNormalized = clamp01((
    judgeScore.promptAdherence
    + judgeScore.structuralQuality
    + judgeScore.visualRecognizability
    + judgeScore.detailAndCreativity
  ) / 4);

  return rewardBreakdownSchema.parse({
    taskId: args.task.taskId,
    tier: args.task.category,
    taskMode: "creative_build",
    formatValid: true,
    formatScore: 1,
    correctnessScore: judgeScore.promptAdherence,
    efficiencyScore: efficiency,
    structuralScore: (heuristic.score + judgeScore.structuralQuality + judgeScore.visualRecognizability) / 3,
    rewardRaw: rewardNormalized,
    rewardNormalized,
    rewardBinary: rewardNormalized >= config.binaryRewardThreshold ? 1 : 0,
    details: {
      heuristicScore: roundScore(heuristic.score),
      heuristicBlockCount: heuristic.blockCount,
      heuristicComponentCount: heuristic.componentCount,
      promptAdherence: roundScore(judgeScore.promptAdherence),
      structuralQuality: roundScore(judgeScore.structuralQuality),
      visualRecognizability: roundScore(judgeScore.visualRecognizability),
      detailAndCreativity: roundScore(judgeScore.detailAndCreativity),
      visionSkipped: false,
    },
  });
}

/** Fast local structural filter for creative mode. */
export function creativeStructuralHeuristic(blocks: readonly BlockPlacement[]): {
  score: number;
  blockCount: number;
  componentCount: number;
  materialDiversity: number;
  heightVariation: number;
} {
  const visible = blocks.filter((block) => block.blockId !== "minecraft:air");
  if (visible.length === 0) {
    return { score: 0, blockCount: 0, componentCount: 0, materialDiversity: 0, heightVariation: 0 };
  }

  const xs = visible.map((block) => block.x);
  const ys = visible.map((block) => block.y);
  const zs = visible.map((block) => block.z);
  const coords = new Set(visible.map((block) => `${block.x},${block.y},${block.z}`));
  const materials = new Set(visible.map((block) => block.blockId));
  const heightVariation = Math.max(...ys) - Math.min(...ys) + 1;
  const spanX = Math.max(...xs) - Math.min(...xs) + 1;
  const spanZ = Math.max(...zs) - Math.min(...zs) + 1;
  const componentCount = countComponents(coords);
  const scores = [
    clamp01(visible.length / 48),
    clamp01((spanX + spanZ) / 18),
    clamp01(heightVariation / 8),
    clamp01(materials.size / 5),
    clamp01(componentCount === 0 ? 0 : 1 / componentCount),
    isConnected(coords) ? 1 : clamp01(0.4 / componentCount),
  ];
  const densityGate = clamp01(visible.length / 8);

  return {
    score: (scores.reduce((sum, value) => sum + value, 0) / scores.length) * densityGate,
    blockCount: visible.length,
    componentCount,
    materialDiversity: materials.size,
    heightVariation,
  };
}

function countComponents(coords: Set<string>): number {
  const remaining = new Set(coords);
  let components = 0;

  while (remaining.size > 0) {
    components += 1;
    const seed = remaining.values().next().value as string;
    const queue = [seed];
    remaining.delete(seed);
    while (queue.length > 0) {
      const [x, y, z] = queue.pop()!.split(",").map(Number) as [number, number, number];
      const neighbors = [
        `${x + 1},${y},${z}`,
        `${x - 1},${y},${z}`,
        `${x},${y + 1},${z}`,
        `${x},${y - 1},${z}`,
        `${x},${y},${z + 1}`,
        `${x},${y},${z - 1}`,
      ];
      for (const neighbor of neighbors) {
        if (remaining.has(neighbor)) {
          remaining.delete(neighbor);
          queue.push(neighbor);
        }
      }
    }
  }

  return components;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function roundScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
