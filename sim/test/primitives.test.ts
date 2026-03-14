import { describe, expect, test } from "vitest";
import { cylinderPlacements, linePlacements, spherePlacements } from "../src/index.js";

describe("geometry primitives", () => {
  test("produces a 3D Bresenham diagonal", () => {
    expect(linePlacements(0, 0, 0, 2, 2, 2, "minecraft:stone")).toEqual([
      { x: 0, y: 0, z: 0, blockId: "minecraft:stone" },
      { x: 1, y: 1, z: 1, blockId: "minecraft:stone" },
      { x: 2, y: 2, z: 2, blockId: "minecraft:stone" },
    ]);
  });

  test("voxelizes a small sphere", () => {
    const sphere = spherePlacements(0, 0, 0, 1, "minecraft:glass");
    expect(sphere).toHaveLength(7);
    expect(sphere).toContainEqual({ x: 0, y: 0, z: 0, blockId: "minecraft:glass" });
    expect(sphere).toContainEqual({ x: 1, y: 0, z: 0, blockId: "minecraft:glass" });
  });

  test("voxelizes a y-axis cylinder", () => {
    const cylinder = cylinderPlacements(0, 0, 0, 1, 2, "minecraft:stone", "y");
    expect(cylinder).toHaveLength(10);
    expect(cylinder).toContainEqual({ x: 0, y: 1, z: 0, blockId: "minecraft:stone" });
    expect(cylinder).toContainEqual({ x: 1, y: 0, z: 0, blockId: "minecraft:stone" });
  });
});
