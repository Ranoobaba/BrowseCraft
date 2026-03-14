/** Provider-agnostic trajectory collection for build, creative, and text-QA modes. */

import { randomUUID } from "node:crypto";
import pLimit from "p-limit";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateObject, generateText } from "ai";
import {
  trajectoryRecordSchema,
  visionJudgeScoreSchema,
  type BuildTier,
  type CreativeBuildTaskSpec,
  type TextQaTier,
  type TrajectoryRecord,
} from "../types.js";
import { buildDslSystemPrompt, buildTextQaSystemPrompt } from "../execute/system-prompt.js";
import { executeCode } from "../execute/execute-code.js";
import { extractCode } from "../execute/extract-code.js";
import { gradeBuildEpisode } from "../grading/build.js";
import { gradeCreativeEpisode, type VisionJudge } from "../grading/creative.js";
import { generateBuildTasks } from "../tasks/build.js";
import { generateCreativeTasks } from "../tasks/creative.js";
import { generateTextQaTasks, gradeTextQaAnswer, textQaFullPrompt } from "../text-qa/index.js";
import { buildWorld, buildWorldFromSetup } from "../world/setup.js";

export type ModelCall = (systemPrompt: string, userPrompt: string) => Promise<string>;

/** Build a default Anthropic text adapter via the Vercel AI SDK. */
export function createAnthropicModelCall(modelName: string, apiKey?: string): ModelCall {
  const provider = createAnthropic(apiKey ? { apiKey } : undefined);
  return async (systemPrompt, userPrompt) => {
    const response = await generateText({
      model: provider(modelName),
      system: systemPrompt,
      prompt: userPrompt,
    });
    return response.text;
  };
}

/** Build a default Anthropic vision judge for creative scoring. */
export function createAnthropicVisionJudge(modelName = "claude-3-5-haiku-latest", apiKey?: string): VisionJudge {
  const provider = createAnthropic(apiKey ? { apiKey } : undefined);
  return async ({ prompt, image }) => {
    const result = await generateObject({
      model: provider(modelName),
      schema: visionJudgeScoreSchema,
      system: "You judge voxel builds. Return numeric scores in [0,1] and one short summary.",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: [
                "Judge the rendered voxel build against the prompt.",
                `Prompt: ${prompt}`,
                "Return scores for promptAdherence, structuralQuality, visualRecognizability, and detailAndCreativity.",
              ].join("\n"),
            },
            {
              type: "image",
              image,
              mimeType: "image/png",
            },
          ],
        },
      ],
    });
    return result.object;
  };
}

/** Collect episodes for one task mode. */
export async function collectTrajectories(options: {
  mode: "build" | "creative" | "text_qa";
  seed: number;
  model: string;
  modelCall: ModelCall;
  perTier?: number;
  count?: number;
  buildTiers?: readonly BuildTier[];
  textQaTiers?: readonly TextQaTier[];
  concurrency?: number;
  visionJudge?: VisionJudge;
}): Promise<TrajectoryRecord[]> {
  const concurrency = options.concurrency ?? 4;
  const limit = pLimit(concurrency);

  if (options.mode === "build") {
    const tasks = generateBuildTasks({
      seed: options.seed,
      perTier: options.perTier ?? 1,
      tiers: options.buildTiers,
    });
    return Promise.all(tasks.map((task) => limit(async () => {
      const systemPrompt = buildDslSystemPrompt({
        mode: "build",
        existingStructures: task.setupBlocks.length > 0,
      });
      const userPrompt = buildBuildUserPrompt(task.prompt, task.player.facing, task.player.x, task.player.y, task.player.z);
      const modelOutput = await options.modelCall(systemPrompt, userPrompt);
      const extractedCode = extractCode(modelOutput);
      const world = buildWorld(task);
      const execution = await executeCode(world, extractedCode);
      const finalWorld = buildWorldFromSetup({
        player: execution.finalSnapshot.player,
        setupBlocks: [],
      });
      for (const [coordKey, blockId] of Object.entries(execution.finalSnapshot.blocks)) {
        const [x, y, z] = coordKey.split(",").map(Number) as [number, number, number];
        finalWorld.setBlock([x, y, z], blockId);
      }
      const reward = gradeBuildEpisode({
        task,
        finalWorld,
        worldDiff: execution.worldDiff,
        executionSuccess: execution.success,
        primitiveCount: execution.primitiveCount,
      });
      return trajectoryRecordSchema.parse({
        episodeId: randomUUID(),
        taskId: task.taskId,
        tier: task.tier,
        family: task.family,
        seed: task.seed,
        taskMode: "build",
        model: options.model,
        systemPrompt,
        userPrompt,
        modelOutput,
        extractedCode,
        executionSuccess: execution.success,
        executionError: execution.error,
        primitiveCount: execution.primitiveCount,
        executionTimeMs: execution.executionTimeMs,
        rewardRaw: reward.rewardRaw,
        rewardNormalized: reward.rewardNormalized,
        rewardBinary: reward.rewardBinary,
        worldDiff: execution.worldDiff,
        metadata: task.metadata,
      });
    })));
  }

  if (options.mode === "creative") {
    const tasks = generateCreativeTasks({ seed: options.seed, count: options.count ?? 1 });
    return Promise.all(tasks.map((task) => limit(async () => collectCreativeTrajectory(task, options))));
  }

  const tasks = generateTextQaTasks({
    seed: options.seed,
    perTier: options.perTier ?? 1,
    tiers: options.textQaTiers,
  });
  return Promise.all(tasks.map((task) => limit(async () => {
    const systemPrompt = buildTextQaSystemPrompt();
    const userPrompt = textQaFullPrompt(task);
    const modelOutput = await options.modelCall(systemPrompt, userPrompt);
    const grade = gradeTextQaAnswer(task, modelOutput);
    return trajectoryRecordSchema.parse({
      episodeId: randomUUID(),
      taskId: task.taskId,
      tier: task.tier,
      family: task.family,
      seed: task.seed,
      taskMode: "text_qa",
      model: options.model,
      systemPrompt,
      userPrompt,
      modelOutput,
      extractedCode: null,
      executionSuccess: null,
      executionError: null,
      primitiveCount: null,
      executionTimeMs: null,
      rewardRaw: grade.rewardRaw,
      rewardNormalized: grade.rewardNormalized,
      rewardBinary: grade.rewardBinary,
      worldDiff: [],
      metadata: task.metadata,
    });
  })));
}

async function collectCreativeTrajectory(
  task: CreativeBuildTaskSpec,
  options: {
    model: string;
    modelCall: ModelCall;
    visionJudge?: VisionJudge;
  },
): Promise<TrajectoryRecord> {
  const systemPrompt = buildDslSystemPrompt({ mode: "creative_build", existingStructures: false });
  const userPrompt = buildCreativeUserPrompt(task.prompt, task.player.facing, task.player.x, task.player.y, task.player.z);
  const modelOutput = await options.modelCall(systemPrompt, userPrompt);
  const extractedCode = extractCode(modelOutput);
  const world = buildWorldFromSetup({ player: task.player, setupBlocks: [] });
  const execution = await executeCode(world, extractedCode);
  const reward = await gradeCreativeEpisode({
    task,
    worldDiff: execution.worldDiff,
    executionSuccess: execution.success,
    primitiveCount: execution.primitiveCount,
    judge: options.visionJudge,
  });

  return trajectoryRecordSchema.parse({
    episodeId: randomUUID(),
    taskId: task.taskId,
    tier: task.category,
    family: task.family,
    seed: task.seed,
    taskMode: "creative_build",
    model: options.model,
    systemPrompt,
    userPrompt,
    modelOutput,
    extractedCode,
    executionSuccess: execution.success,
    executionError: execution.error,
    primitiveCount: execution.primitiveCount,
    executionTimeMs: execution.executionTimeMs,
    rewardRaw: reward.rewardRaw,
    rewardNormalized: reward.rewardNormalized,
    rewardBinary: reward.rewardBinary,
    worldDiff: execution.worldDiff,
    metadata: {
      ...task.metadata,
      category: task.category,
    },
  });
}

function buildBuildUserPrompt(prompt: string, facing: string, x: number, y: number, z: number): string {
  return [
    prompt,
    `Player state: you are at (${x}, ${y}, ${z}) facing ${facing}.`,
    "The world starts on flat terrain with nearby structures exactly as described by the task.",
  ].join("\n");
}

function buildCreativeUserPrompt(prompt: string, facing: string, x: number, y: number, z: number): string {
  return [
    prompt,
    `Player state: you are at (${x}, ${y}, ${z}) facing ${facing}.`,
    "Build on the flat terrain around you.",
  ].join("\n");
}
