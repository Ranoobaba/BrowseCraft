/** Shared BrowseCraft schemas and runtime types for voxel.exec training and inference. */

import { z } from "zod";

export const buildTiers = [
  "t1_absolute",
  "t2_relative_single_ref",
  "t3_primitives",
  "t4_structure_relative",
  "t5_modification",
  "t6_composition",
] as const;

export const textQaTiers = [
  "qa_directional_single_hop",
  "qa_multi_hop_chain",
  "qa_viewpoint_transform",
  "qa_topology",
] as const;

export const creativeCategories = [
  "architectural",
  "organic",
  "mechanical",
  "decorative",
] as const;

export type BuildTier = (typeof buildTiers)[number];
export type TextQaTier = (typeof textQaTiers)[number];
export type CreativeCategory = (typeof creativeCategories)[number];
export type TaskMode = "build" | "creative_build" | "text_qa";
export type SpanAxis = "x" | "y" | "z";
export type AnswerFormat = "single_token" | "entity_name" | "yes_no" | "coordinate";

export const blockPlacementSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
  blockId: z.string().min(1),
});

export type BlockPlacement = z.infer<typeof blockPlacementSchema>;

export const playerSpecSchema = z.object({
  x: z.number().int().default(0),
  y: z.number().int().default(64),
  z: z.number().int().default(0),
  facing: z.string().min(1).default("north"),
  dimension: z.string().min(1).default("minecraft:overworld"),
});

export type PlayerSpec = z.infer<typeof playerSpecSchema>;

export const structuralChecksSchema = z.object({
  requireConnected: z.boolean().default(false),
  requireGrounded: z.boolean().default(false),
  minSpan: z.number().int().min(1).nullable().default(null),
  spanAxis: z.enum(["x", "y", "z"]).nullable().default(null),
}).superRefine((value, context) => {
  if ((value.minSpan === null) !== (value.spanAxis === null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "minSpan and spanAxis must be set together",
      path: ["minSpan"],
    });
  }
});

export type StructuralChecks = z.infer<typeof structuralChecksSchema>;

export const buildTaskSchema = z.object({
  taskId: z.string().min(1),
  tier: z.enum(buildTiers),
  family: z.string().min(1),
  seed: z.string().min(1),
  prompt: z.string().min(1),
  player: playerSpecSchema.default({}),
  setupBlocks: z.array(blockPlacementSchema).default([]),
  targetBlocks: z.array(blockPlacementSchema).default([]),
  preservedBlocks: z.array(blockPlacementSchema).default([]),
  expectedPrimitiveCount: z.number().int().min(1),
  structuralChecks: structuralChecksSchema.default({}),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type BuildTaskSpec = z.infer<typeof buildTaskSchema>;

export const creativeBuildTaskSchema = z.object({
  taskId: z.string().min(1),
  mode: z.literal("creative_build").default("creative_build"),
  family: z.literal("creative_prompt"),
  category: z.enum(creativeCategories),
  seed: z.string().min(1),
  prompt: z.string().min(1),
  player: playerSpecSchema.default({}),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type CreativeBuildTaskSpec = z.infer<typeof creativeBuildTaskSchema>;

export const textQaTaskSchema = z.object({
  taskId: z.string().min(1),
  tier: z.enum(textQaTiers),
  family: z.string().min(1),
  seed: z.string().min(1),
  prompt: z.string().min(1),
  player: playerSpecSchema.default({}),
  setupBlocks: z.array(blockPlacementSchema).default([]),
  expectedAnswer: z.string().min(1),
  answerFormat: z.enum(["single_token", "entity_name", "yes_no", "coordinate"]),
  canonicalReasoning: z.array(z.string().min(1)).min(1),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type TextQATaskSpec = z.infer<typeof textQaTaskSchema>;

export const worldContextSchema = z.object({
  player: playerSpecSchema,
  blocks: z.record(z.string(), z.string().min(1)),
});

export type WorldContext = z.infer<typeof worldContextSchema>;

export const buildExecutionResultSchema = z.object({
  success: z.boolean(),
  error: z.string().nullable(),
  primitiveCount: z.number().int().min(0),
  executionTimeMs: z.number().min(0),
  finalSnapshot: worldContextSchema,
  worldDiff: z.array(blockPlacementSchema),
});

export type BuildExecutionResult = z.infer<typeof buildExecutionResultSchema>;

export const rewardConfigSchema = z.object({
  formatMode: z.enum(["gate", "weighted"]).default("gate"),
  weightCorrectness: z.number().min(0).default(0.7),
  weightEfficiency: z.number().min(0).default(0.2),
  weightStructural: z.number().min(0).default(0.1),
  weightFormat: z.number().min(0).default(0.1),
  efficiencyMinCorrectness: z.number().min(0).max(1).default(0.1),
  binaryRewardThreshold: z.number().min(0).max(1).default(0.8),
});

export type RewardConfig = z.infer<typeof rewardConfigSchema>;

export const rewardBreakdownSchema = z.object({
  taskId: z.string().min(1),
  tier: z.string().min(1),
  taskMode: z.enum(["build", "creative_build", "text_qa"]),
  formatValid: z.boolean(),
  formatScore: z.number().min(0).max(1),
  correctnessScore: z.number().min(0).max(1),
  efficiencyScore: z.number().min(0).max(1),
  structuralScore: z.number().min(0).max(1),
  rewardRaw: z.number(),
  rewardNormalized: z.number().min(0).max(1),
  rewardBinary: z.number().min(0).max(1),
  details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});

export type RewardBreakdown = z.infer<typeof rewardBreakdownSchema>;

export const trajectoryRecordSchema = z.object({
  episodeId: z.string().min(1),
  taskId: z.string().min(1),
  tier: z.string().min(1),
  family: z.string().min(1),
  seed: z.string().min(1),
  taskMode: z.enum(["build", "creative_build", "text_qa"]),
  model: z.string(),
  systemPrompt: z.string(),
  userPrompt: z.string(),
  modelOutput: z.string(),
  extractedCode: z.string().nullable().default(null),
  executionSuccess: z.boolean().nullable().default(null),
  executionError: z.string().nullable().default(null),
  primitiveCount: z.number().int().min(0).nullable().default(null),
  executionTimeMs: z.number().min(0).nullable().default(null),
  rewardRaw: z.number(),
  rewardNormalized: z.number().min(0).max(1),
  rewardBinary: z.number().min(0).max(1),
  worldDiff: z.array(blockPlacementSchema).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type TrajectoryRecord = z.infer<typeof trajectoryRecordSchema>;

export const textQaGradeSchema = z.object({
  taskId: z.string().min(1),
  tier: z.enum(textQaTiers),
  taskMode: z.literal("text_qa").default("text_qa"),
  answer: z.string(),
  expectedAnswer: z.string(),
  normalizedAnswer: z.string(),
  normalizedExpectedAnswer: z.string(),
  answerFormat: z.enum(["single_token", "entity_name", "yes_no", "coordinate"]),
  correct: z.boolean(),
  rewardRaw: z.number(),
  rewardNormalized: z.number().min(0).max(1),
  rewardBinary: z.number().min(0).max(1),
});

export type TextQAGradeResult = z.infer<typeof textQaGradeSchema>;

export const stageManifestRecordSchema = z.object({
  stage: z.enum(["spatial-sft", "spatial-grpo", "creative-sft", "creative-grpo"]),
  taskMode: z.enum(["build", "creative_build", "text_qa"]),
  input: z.record(z.string(), z.unknown()),
  rubric: z.record(z.string(), z.unknown()).nullable().default(null),
  metadata: z.record(z.string(), z.unknown()),
});

export type StageManifestRecord = z.infer<typeof stageManifestRecordSchema>;

export const visionJudgeScoreSchema = z.object({
  promptAdherence: z.number().min(0).max(1),
  structuralQuality: z.number().min(0).max(1),
  visualRecognizability: z.number().min(0).max(1),
  detailAndCreativity: z.number().min(0).max(1),
  summary: z.string(),
});

export type VisionJudgeScore = z.infer<typeof visionJudgeScoreSchema>;

export function defaultPlayerSpec(overrides: Partial<PlayerSpec> = {}): PlayerSpec {
  return playerSpecSchema.parse(overrides);
}

export function defaultStructuralChecks(overrides: Partial<StructuralChecks> = {}): StructuralChecks {
  return structuralChecksSchema.parse(overrides);
}

export function normalizeSeed(seed: number | string | bigint): string {
  return typeof seed === "bigint" ? seed.toString() : `${seed}`;
}
