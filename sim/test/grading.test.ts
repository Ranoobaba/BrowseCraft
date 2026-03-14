import { describe, expect, test } from "vitest";
import { gradeBuildEpisode, HeadlessVoxelWorld, iouScore, placementMap } from "../src/index.js";
import type { BuildTaskSpec } from "../src/index.js";

describe("build grading", () => {
  test("handles IoU edge cases", () => {
    expect(iouScore(new Map(), new Map())).toBe(1);
    expect(iouScore(placementMap([{ x: 0, y: 64, z: 0, blockId: "minecraft:stone" }]), new Map())).toBe(0);
  });

  test("format gating zeros failed execution rewards", () => {
    const task: BuildTaskSpec = {
      taskId: "t1_absolute:absolute_single_block:1:0",
      tier: "t1_absolute",
      family: "absolute_single_block",
      seed: "1",
      prompt: "Place one block.",
      player: { x: 0, y: 64, z: 0, facing: "north", dimension: "minecraft:overworld" },
      setupBlocks: [],
      targetBlocks: [{ x: 0, y: 64, z: 0, blockId: "minecraft:stone" }],
      preservedBlocks: [],
      expectedPrimitiveCount: 1,
      structuralChecks: { requireConnected: false, requireGrounded: true, minSpan: null, spanAxis: null },
      metadata: {},
    };
    const world = new HeadlessVoxelWorld();
    const reward = gradeBuildEpisode({
      task,
      finalWorld: world,
      worldDiff: [],
      executionSuccess: false,
      primitiveCount: 0,
    });
    expect(reward.rewardNormalized).toBe(0);
    expect(reward.rewardBinary).toBe(0);
  });

  test("scores efficiency from primitive counts", () => {
    const task: BuildTaskSpec = {
      taskId: "t1_absolute:absolute_single_block:1:0",
      tier: "t1_absolute",
      family: "absolute_single_block",
      seed: "1",
      prompt: "Place one block.",
      player: { x: 0, y: 64, z: 0, facing: "north", dimension: "minecraft:overworld" },
      setupBlocks: [],
      targetBlocks: [{ x: 0, y: 64, z: 0, blockId: "minecraft:stone" }],
      preservedBlocks: [],
      expectedPrimitiveCount: 1,
      structuralChecks: { requireConnected: false, requireGrounded: true, minSpan: null, spanAxis: null },
      metadata: {},
    };
    const world = new HeadlessVoxelWorld();
    world.placeBlocks([{ x: 0, y: 64, z: 0, blockId: "minecraft:stone" }]);
    const reward = gradeBuildEpisode({
      task,
      finalWorld: world,
      worldDiff: [{ x: 0, y: 64, z: 0, blockId: "minecraft:stone" }],
      executionSuccess: true,
      primitiveCount: 2,
    });
    expect(reward.details.efficiencyBase).toBe(0.5);
  });
});
