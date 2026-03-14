import { describe, expect, test } from "vitest";
import { HeadlessVoxelWorld, buildWorldFromSetup, connectedComponentCount } from "../src/index.js";

describe("HeadlessVoxelWorld", () => {
  test("places, fills, diffs, and undoes blocks", () => {
    const world = new HeadlessVoxelWorld();
    const before = world.snapshot();

    expect(world.placeBlocks([{ x: 1, y: 64, z: 1, blockId: "minecraft:stone" }])).toEqual({ placedCount: 1 });
    expect(world.blockAt([1, 64, 1])).toBe("minecraft:stone");

    const fill = world.fillRegion({
      fromCorner: { x: 0, y: 64, z: 0 },
      toCorner: { x: 1, y: 64, z: 1 },
      blockId: "minecraft:oak_planks",
    });
    expect(fill.placedCount).toBe(4);

    const diff = world.diff(before);
    expect(Object.keys(diff)).toHaveLength(4);
    expect(world.undoLast()).toEqual({ undoneCount: 4 });
    expect(world.blockAt([1, 64, 1])).toBe("minecraft:stone");
  });

  test("inspect clamps radius, filters terrain, and detects redundancy", () => {
    const world = buildWorldFromSetup({
      player: { x: 0, y: 64, z: 0, facing: "north", dimension: "minecraft:overworld" },
      setupBlocks: [{ x: 2, y: 64, z: 0, blockId: "minecraft:red_wool" }],
    });

    const first = world.inspectArea({ center: { x: 0, y: 64, z: 0 }, radius: 99, detailed: false, filterTerrain: true });
    expect(first.radius).toBe(12);
    expect(first.radiusClamped).toBe(true);
    expect(first.blockCounts?.["minecraft:red_wool"]).toBe(1);
    expect(first.blockCounts?.["minecraft:grass_block"]).toBeUndefined();

    const second = world.inspectArea({ center: { x: 0, y: 64, z: 0 }, radius: 12, detailed: false, filterTerrain: true });
    expect(second.redundantWithPrevious).toBe(true);

    const detailed = world.inspectArea({ center: { x: 0, y: 64, z: 0 }, radius: 99, detailed: true, filterTerrain: true });
    expect(detailed.radius).toBe(6);
    expect(detailed.nonAirBlocks).toEqual([{ x: 2, y: 64, z: 0, blockId: "minecraft:red_wool" }]);
  });

  test("reports connectivity and bounding boxes", () => {
    const world = new HeadlessVoxelWorld();
    world.placeBlocks([
      { x: 0, y: 64, z: 0, blockId: "minecraft:stone" },
      { x: 1, y: 64, z: 0, blockId: "minecraft:stone" },
      { x: 5, y: 64, z: 0, blockId: "minecraft:stone" },
    ]);

    const report = world.validationReport();
    expect(report.blockCount).toBe(3);
    expect(report.componentCount).toBe(2);
    expect(report.bbox?.min).toEqual({ x: 0, y: 64, z: 0 });
    expect(report.bbox?.max).toEqual({ x: 5, y: 64, z: 0 });
    expect(connectedComponentCount([[0, 64, 0], [1, 64, 0], [5, 64, 0]])).toBe(2);
  });
});
