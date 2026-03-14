/** Core grading metrics for voxel diffs and world structure. */

import type { BlockPlacement } from "../types.js";
import { HeadlessVoxelWorld } from "../world/headless-world.js";

/** Convert placements into a coord-keyed map. */
export function placementMap(blocks: Iterable<BlockPlacement>): Map<string, string> {
  return new Map([...blocks].map((block) => [`${block.x},${block.y},${block.z}`, block.blockId]));
}

/** Convert a coord-keyed block map into a typed set. */
export function typedSet(blockMap: Map<string, string>): Set<string> {
  return new Set([...blockMap.entries()].map(([coord, blockId]) => `${coord}:${blockId}`));
}

/** Compute typed IoU between actual and expected changed blocks. */
export function iouScore(actual: Map<string, string>, expected: Map<string, string>): number {
  const actualSet = typedSet(actual);
  const expectedSet = typedSet(expected);

  if (actualSet.size === 0 && expectedSet.size === 0) {
    return 1;
  }

  const union = new Set([...actualSet, ...expectedSet]);
  let intersection = 0;
  for (const value of actualSet) {
    if (expectedSet.has(value)) {
      intersection += 1;
    }
  }
  return union.size === 0 ? 0 : intersection / union.size;
}

/** Return 1 for exact typed equality and 0 otherwise. */
export function exactMatch(actual: Map<string, string>, expected: Map<string, string>): number {
  if (actual.size !== expected.size) {
    return 0;
  }
  for (const [coord, blockId] of actual) {
    if (expected.get(coord) !== blockId) {
      return 0;
    }
  }
  return 1;
}

/** Check 6-neighbor connectivity for a set of coords. */
export function isConnected(coords: Set<string>): boolean {
  if (coords.size === 0) {
    return false;
  }

  const remaining = new Set(coords);
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

  return remaining.size === 0;
}

/** Return the fraction of coords supported by either the structure or the ground. */
export function groundingRatio(world: HeadlessVoxelWorld, coords: Set<string>): number {
  if (coords.size === 0) {
    return 0;
  }

  let supported = 0;

  for (const coord of coords) {
    const [x, y, z] = coord.split(",").map(Number) as [number, number, number];
    const below = `${x},${y - 1},${z}`;
    if (coords.has(below)) {
      supported += 1;
      continue;
    }
    if (world.blockAt([x, y - 1, z]) !== "minecraft:air") {
      supported += 1;
    }
  }

  return supported / coords.size;
}

/** Compute the occupied span along one axis. */
export function spanLength(coords: Set<string>, axis: "x" | "y" | "z"): number {
  if (coords.size === 0) {
    return 0;
  }
  const index = { x: 0, y: 1, z: 2 }[axis];
  const values = [...coords].map((coord) => Number.parseInt(coord.split(",")[index]!, 10));
  return Math.max(...values) - Math.min(...values) + 1;
}

/** Check how many preserved blocks stayed unchanged. */
export function preservationScore(world: HeadlessVoxelWorld, expectedUnchanged: Iterable<BlockPlacement>): number {
  const blocks = [...expectedUnchanged];
  if (blocks.length === 0) {
    return 1;
  }

  let preserved = 0;
  for (const placement of blocks) {
    if (world.blockAt([placement.x, placement.y, placement.z]) === placement.blockId) {
      preserved += 1;
    }
  }

  return preserved / blocks.length;
}
