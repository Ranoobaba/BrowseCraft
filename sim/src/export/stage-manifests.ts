/** Export SFT and GRPO manifests for spatial and creative stages. */

import {
  stageManifestRecordSchema,
  trajectoryRecordSchema,
  type StageManifestRecord,
  type TrajectoryRecord,
} from "../types.js";
import { curriculumWeights, rollingMeanRewards, taskFamilyKey } from "../curriculum/index.js";

/** Build the four stage manifests from collected trajectories. */
export function exportStageManifests(records: readonly TrajectoryRecord[]): Record<StageManifestRecord["stage"], StageManifestRecord[]> {
  const validated = records.map((record) => trajectoryRecordSchema.parse(record));
  const spatialBuild = validated.filter((record) => record.taskMode === "build");
  const creative = validated.filter((record) => record.taskMode === "creative_build");
  const textQa = validated.filter((record) => record.taskMode === "text_qa");
  const spatialRlRewards = rollingMeanRewards(spatialBuild.filter((record) =>
    ["t4_structure_relative", "t5_modification", "t6_composition"].includes(record.tier),
  ), (row) => taskFamilyKey(row.taskId));
  const creativeRewards = rollingMeanRewards(
    creative.map((record) => ({
      taskId: record.taskId,
      tier: record.tier,
      rewardNormalized: record.rewardNormalized,
      category: String(record.metadata.category ?? "creative_prompt"),
    })),
    (row) => row.category ?? "creative_prompt",
  );
  const spatialWeights = curriculumWeights(spatialRlRewards);
  const creativeWeights = curriculumWeights(creativeRewards);

  const output: Record<StageManifestRecord["stage"], StageManifestRecord[]> = {
    "spatial-sft": [],
    "spatial-grpo": [],
    "creative-sft": [],
    "creative-grpo": [],
  };

  for (const record of spatialBuild) {
    if (["t1_absolute", "t2_relative_single_ref", "t3_primitives"].includes(record.tier) && record.executionSuccess && record.rewardBinary === 1) {
      output["spatial-sft"].push(stageManifestRecordSchema.parse({
        stage: "spatial-sft",
        taskMode: "build",
        input: {
          systemPrompt: record.systemPrompt,
          userPrompt: record.userPrompt,
          code: record.extractedCode ?? record.modelOutput,
        },
        rubric: null,
        metadata: {
          taskId: record.taskId,
          tier: record.tier,
          family: record.family,
          seed: record.seed,
          rewardNormalized: record.rewardNormalized,
        },
      }));
    }

    if (["t4_structure_relative", "t5_modification", "t6_composition"].includes(record.tier)) {
      const familyKey = taskFamilyKey(record.taskId);
      output["spatial-grpo"].push(stageManifestRecordSchema.parse({
        stage: "spatial-grpo",
        taskMode: "build",
        input: {
          systemPrompt: record.systemPrompt,
          userPrompt: record.userPrompt,
          modelOutput: record.modelOutput,
          code: record.extractedCode ?? "",
        },
        rubric: {
          rewardNormalized: record.rewardNormalized,
        },
        metadata: {
          taskId: record.taskId,
          tier: record.tier,
          family: record.family,
          seed: record.seed,
          rewardRaw: record.rewardRaw,
          rewardNormalized: record.rewardNormalized,
          rewardBinary: record.rewardBinary,
          curriculumWeight: spatialWeights[familyKey] ?? 1,
        },
      }));
    }
  }

  for (const record of textQa) {
    if (record.rewardBinary === 1) {
      output["spatial-sft"].push(stageManifestRecordSchema.parse({
        stage: "spatial-sft",
        taskMode: "text_qa",
        input: {
          systemPrompt: record.systemPrompt,
          userPrompt: record.userPrompt,
          answer: record.modelOutput,
        },
        rubric: null,
        metadata: {
          taskId: record.taskId,
          tier: record.tier,
          family: record.family,
          seed: record.seed,
          rewardNormalized: record.rewardNormalized,
        },
      }));
    }
  }

  for (const record of creative) {
    const category = String(record.metadata.category ?? "creative_prompt");
    if (record.rewardNormalized > 0.6) {
      output["creative-sft"].push(stageManifestRecordSchema.parse({
        stage: "creative-sft",
        taskMode: "creative_build",
        input: {
          systemPrompt: record.systemPrompt,
          userPrompt: record.userPrompt,
          code: record.extractedCode ?? record.modelOutput,
        },
        rubric: null,
        metadata: {
          taskId: record.taskId,
          family: record.family,
          seed: record.seed,
          category,
          rewardNormalized: record.rewardNormalized,
        },
      }));
    }

    output["creative-grpo"].push(stageManifestRecordSchema.parse({
      stage: "creative-grpo",
      taskMode: "creative_build",
      input: {
        systemPrompt: record.systemPrompt,
        userPrompt: record.userPrompt,
        modelOutput: record.modelOutput,
        code: record.extractedCode ?? "",
      },
      rubric: {
        rewardNormalized: record.rewardNormalized,
      },
      metadata: {
        taskId: record.taskId,
        family: record.family,
        seed: record.seed,
        category,
        rewardRaw: record.rewardRaw,
        rewardNormalized: record.rewardNormalized,
        rewardBinary: record.rewardBinary,
        curriculumWeight: creativeWeights[category] ?? 1,
      },
    }));
  }

  return output;
}
