import { PNG } from "pngjs";
import { describe, expect, test } from "vitest";
import { creativeStructuralHeuristic, exportStageManifests, renderCreativeComposite } from "../src/index.js";

describe("creative grading and export", () => {
  test("renders a non-empty PNG composite", () => {
    const image = renderCreativeComposite([
      { x: 0, y: 64, z: 0, blockId: "minecraft:stone" },
      { x: 1, y: 64, z: 0, blockId: "minecraft:oak_planks" },
      { x: 0, y: 65, z: 0, blockId: "minecraft:glass" },
    ]);
    const parsed = PNG.sync.read(image);
    expect(parsed.width).toBeGreaterThan(32);
    expect(parsed.height).toBeGreaterThan(32);
  });

  test("flags degenerate creative builds with a low heuristic score", () => {
    const heuristic = creativeStructuralHeuristic([{ x: 0, y: 64, z: 0, blockId: "minecraft:stone" }]);
    expect(heuristic.score).toBeLessThan(0.3);
  });

  test("exports reward_normalized and curriculum weights", () => {
    const manifests = exportStageManifests([
      {
        episodeId: "e1",
        taskId: "t4_structure_relative:top_of_tower:1:0",
        tier: "t4_structure_relative",
        family: "top_of_tower",
        seed: "1",
        taskMode: "build",
        model: "test-model",
        systemPrompt: "system",
        userPrompt: "user",
        modelOutput: "block(0,64,0,'minecraft:stone')",
        extractedCode: "block(0,64,0,'minecraft:stone')",
        executionSuccess: true,
        executionError: null,
        primitiveCount: 1,
        executionTimeMs: 10,
        rewardRaw: 0.8,
        rewardNormalized: 0.8,
        rewardBinary: 0,
        worldDiff: [],
        metadata: {},
      },
      {
        episodeId: "e2",
        taskId: "creative_build:architectural:1:0",
        tier: "architectural",
        family: "creative_prompt",
        seed: "1",
        taskMode: "creative_build",
        model: "test-model",
        systemPrompt: "system",
        userPrompt: "user",
        modelOutput: "box(0,64,0,1,65,1,'minecraft:stone')",
        extractedCode: "box(0,64,0,1,65,1,'minecraft:stone')",
        executionSuccess: true,
        executionError: null,
        primitiveCount: 1,
        executionTimeMs: 10,
        rewardRaw: 0.7,
        rewardNormalized: 0.7,
        rewardBinary: 1,
        worldDiff: [],
        metadata: { category: "architectural" },
      },
    ]);

    expect(manifests["spatial-grpo"][0]?.rubric).toEqual({ rewardNormalized: 0.8 });
    expect(manifests["spatial-grpo"][0]?.metadata.curriculumWeight).toBe(1);
    expect(manifests["creative-grpo"][0]?.rubric).toEqual({ rewardNormalized: 0.7 });
  });
});
