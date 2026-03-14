import { describe, expect, test } from "vitest";
import { HeadlessVoxelWorld, buildWorldFromSetup, executeCode } from "../src/index.js";

describe("executeCode", () => {
  test("runs valid code and returns a diff", async () => {
    const world = new HeadlessVoxelWorld();
    const result = await executeCode(world, `
box(0, 64, 0, 1, 64, 1, "minecraft:stone");
line(0, 65, 0, 1, 65, 1, "minecraft:glass");
`);

    expect(result.success).toBe(true);
    expect(result.primitiveCount).toBe(2);
    expect(result.worldDiff).toContainEqual({ x: 0, y: 64, z: 0, blockId: "minecraft:stone" });
    expect(result.worldDiff).toContainEqual({ x: 1, y: 65, z: 1, blockId: "minecraft:glass" });
  });

  test("surfaces syntax errors", async () => {
    const result = await executeCode(new HeadlessVoxelWorld(), "box(");
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/syntax|unexpected|parse/i);
  });

  test("surfaces runtime errors", async () => {
    const result = await executeCode(new HeadlessVoxelWorld(), 'throw new Error("boom")');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/boom/);
  });

  test("blocks simple sandbox escapes through require shadowing", async () => {
    const result = await executeCode(new HeadlessVoxelWorld(), 'require("fs")');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/require/);
  });

  test("enforces the box volume cap", async () => {
    const result = await executeCode(new HeadlessVoxelWorld(), 'box(0, 0, 0, 20, 20, 20, "minecraft:stone")');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/4096/);
  });

  test("reads the seeded world through inspect", async () => {
    const world = buildWorldFromSetup({
      player: { x: 0, y: 64, z: 0, facing: "north", dimension: "minecraft:overworld" },
      setupBlocks: [{ x: 2, y: 64, z: 0, blockId: "minecraft:red_wool" }],
    });
    const result = await executeCode(world, `
const seen = inspect(0, 64, 0, 4, true, true);
if (seen.retainedBlockCount !== 1) {
  throw new Error("inspect mismatch");
}
block(2, 65, 0, "minecraft:torch");
`);
    expect(result.success).toBe(true);
    expect(result.worldDiff).toContainEqual({ x: 2, y: 65, z: 0, blockId: "minecraft:torch" });
  });
});
