/** Coordinate helpers for the headless voxel world and task generators. */

import type { BlockPlacement } from "../types.js";

export type Coord = readonly [number, number, number];
export type CoordKey = `${number},${number},${number}`;
export type BlockMap = Map<CoordKey, string>;

export function coordKey(x: number, y: number, z: number): CoordKey {
  return `${x},${y},${z}`;
}

export function coordFromKey(key: CoordKey | string): Coord {
  const parts = key.split(",").map((value) => Number.parseInt(value, 10));
  const x = parts[0]!;
  const y = parts[1]!;
  const z = parts[2]!;
  return [x, y, z];
}

export function placementCoord(block: Pick<BlockPlacement, "x" | "y" | "z">): Coord {
  return [block.x, block.y, block.z];
}

export function placementKey(block: Pick<BlockPlacement, "x" | "y" | "z">): CoordKey {
  return coordKey(block.x, block.y, block.z);
}

export function compareCoords(left: Coord, right: Coord): number {
  if (left[0] !== right[0]) {
    return left[0] - right[0];
  }
  if (left[1] !== right[1]) {
    return left[1] - right[1];
  }
  return left[2] - right[2];
}

export function sortPlacements(blocks: BlockPlacement[]): BlockPlacement[] {
  return [...blocks].sort((left, right) =>
    compareCoords(
      [left.x, left.y, left.z],
      [right.x, right.y, right.z],
    ),
  );
}

export function placementsToRecord(blocks: Iterable<BlockPlacement>): Record<CoordKey, string> {
  const entries: Record<string, string> = {};
  for (const block of blocks) {
    entries[placementKey(block)] = block.blockId;
  }
  return entries as Record<CoordKey, string>;
}

export function recordToPlacements(blocks: Record<string, string>): BlockPlacement[] {
  return Object.entries(blocks).map(([key, blockId]) => {
    const [x, y, z] = coordFromKey(key);
    return { x, y, z, blockId };
  });
}

export const axisOffsets = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
] as const satisfies ReadonlyArray<Coord>;
