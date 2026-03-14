import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { generateBuildTasks, generateTextQaTasks } from "../src/index.js";

function normalizeBuild(task: any) {
  return canonicalize({
    taskId: task.taskId,
    prompt: task.prompt,
    player: task.player,
    setupBlocks: task.setupBlocks,
    targetBlocks: task.targetBlocks,
    preservedBlocks: task.preservedBlocks,
    structuralChecks: task.structuralChecks,
    metadata: task.metadata,
  });
}

function normalizeFixtureBuild(task: any) {
  return canonicalize({
    taskId: task.task_id,
    prompt: task.prompt,
    player: task.player,
    setupBlocks: task.setup_blocks.map((block: any) => ({ x: block.x, y: block.y, z: block.z, blockId: block.block_id })),
    targetBlocks: task.target_blocks.map((block: any) => ({ x: block.x, y: block.y, z: block.z, blockId: block.block_id })),
    preservedBlocks: task.preserved_blocks.map((block: any) => ({ x: block.x, y: block.y, z: block.z, blockId: block.block_id })),
    structuralChecks: {
      requireConnected: task.structural_checks.require_connected,
      requireGrounded: task.structural_checks.require_grounded,
      minSpan: task.structural_checks.min_span,
      spanAxis: task.structural_checks.span_axis,
    },
    metadata: task.metadata,
  });
}

function normalizeTextQa(task: any) {
  return canonicalize({
    taskId: task.taskId,
    prompt: task.prompt,
    player: task.player,
    setupBlocks: task.setupBlocks,
    expectedAnswer: task.expectedAnswer,
    answerFormat: task.answerFormat,
    canonicalReasoning: task.canonicalReasoning,
    metadata: task.metadata,
  });
}

function normalizeFixtureTextQa(task: any) {
  return canonicalize({
    taskId: task.task_id,
    prompt: task.prompt,
    player: task.player,
    setupBlocks: task.setup_blocks.map((block: any) => ({ x: block.x, y: block.y, z: block.z, blockId: block.block_id })),
    expectedAnswer: task.expected_answer,
    answerFormat: task.answer_format,
    canonicalReasoning: task.canonical_reasoning,
    metadata: task.metadata,
  });
}

function canonicalize(value: any): any {
  if (typeof value === "number") {
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    const normalized = value.map((entry) => canonicalize(entry));
    if (normalized.every((entry) => entry && typeof entry === "object" && "x" in entry && "y" in entry && "z" in entry)) {
      return normalized.sort((left, right) => left.x - right.x || left.y - right.y || left.z - right.z);
    }
    return normalized;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, entry]) => [snakeToCamel(key), canonicalize(entry)])
        .sort(([left], [right]) => left.localeCompare(right)),
    );
  }
  return value;
}

function snakeToCamel(value: string): string {
  return value.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase());
}

describe("deterministic task generation", () => {
  test("matches the saved Python seed-45 build fixtures", () => {
    const expected = JSON.parse(readFileSync(new URL("./fixtures/seed45_build_tasks.json", import.meta.url), "utf8"));
    const actual = generateBuildTasks({ seed: 45, perTier: 2 }).map(normalizeBuild);
    expect(actual).toEqual(expected.map(normalizeFixtureBuild));
  });

  test("matches the saved Python seed-45 text-QA fixtures", () => {
    const expected = JSON.parse(readFileSync(new URL("./fixtures/seed45_text_qa_tasks.json", import.meta.url), "utf8"));
    const actual = generateTextQaTasks({ seed: 45, perTier: 2 }).map(normalizeTextQa);
    expect(actual).toEqual(expected.map(normalizeFixtureTextQa));
  });
});
