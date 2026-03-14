/** Shared geometry helpers used by build and text-QA task generation. */

import type { BlockPlacement } from "../types.js";
import { PythonRandom } from "./python-random.js";

export const markerBlocks = [
  "minecraft:red_wool",
  "minecraft:blue_wool",
  "minecraft:green_wool",
  "minecraft:yellow_wool",
  "minecraft:purple_wool",
  "minecraft:orange_wool",
  "minecraft:cyan_wool",
  "minecraft:black_wool",
  "minecraft:white_wool",
] as const;

export const markerNames: Record<string, string> = {
  "minecraft:red_wool": "red marker",
  "minecraft:blue_wool": "blue marker",
  "minecraft:green_wool": "green marker",
  "minecraft:yellow_wool": "yellow marker",
  "minecraft:purple_wool": "purple marker",
  "minecraft:orange_wool": "orange marker",
  "minecraft:cyan_wool": "cyan marker",
  "minecraft:black_wool": "black marker",
  "minecraft:white_wool": "white marker",
};

export const cardinalOffsets: Record<string, readonly [number, number, number]> = {
  north: [0, 0, -1],
  south: [0, 0, 1],
  east: [1, 0, 0],
  west: [-1, 0, 0],
};

export const oppositeCardinal: Record<string, string> = {
  north: "south",
  south: "north",
  east: "west",
  west: "east",
};

export function blockName(blockId: string): string {
  return blockId.replace("minecraft:", "").replaceAll("_", " ");
}

export function markerName(blockId: string): string {
  return markerNames[blockId] ?? blockName(blockId);
}

export function lineBlocks(options: {
  axis: "x" | "y" | "z";
  start: readonly [number, number, number];
  length: number;
  blockId: string;
}): BlockPlacement[] {
  const offsets = {
    x: [1, 0, 0],
    y: [0, 1, 0],
    z: [0, 0, 1],
  } as const;
  const [dx, dy, dz] = offsets[options.axis];

  return Array.from({ length: options.length }, (_, step) => ({
    x: options.start[0] + dx * step,
    y: options.start[1] + dy * step,
    z: options.start[2] + dz * step,
    blockId: options.blockId,
  }));
}

export function filledRect(options: {
  origin: readonly [number, number, number];
  width: number;
  depth: number;
  blockId: string;
}): BlockPlacement[] {
  const [ox, oy, oz] = options.origin;
  const blocks: BlockPlacement[] = [];

  for (let x = ox; x < ox + options.width; x += 1) {
    for (let z = oz; z < oz + options.depth; z += 1) {
      blocks.push({ x, y: oy, z, blockId: options.blockId });
    }
  }

  return blocks;
}

export function dedupeBlocks(blocks: Iterable<BlockPlacement>): BlockPlacement[] {
  const deduped = new Map<string, BlockPlacement>();
  for (const block of blocks) {
    deduped.set(`${block.x},${block.y},${block.z}`, block);
  }
  return [...deduped.values()];
}

export function removeCoords(blocks: Iterable<BlockPlacement>, removedCoords: Set<string>): BlockPlacement[] {
  return [...blocks].filter((block) => !removedCoords.has(`${block.x},${block.y},${block.z}`));
}

export function roomShell(options: {
  origin: readonly [number, number, number];
  width: number;
  height: number;
  depth: number;
  wallBlock: string;
}): BlockPlacement[] {
  const [ox, oy, oz] = options.origin;
  const maxX = ox + options.width - 1;
  const maxY = oy + options.height - 1;
  const maxZ = oz + options.depth - 1;
  const blocks: BlockPlacement[] = [];

  for (let x = ox; x <= maxX; x += 1) {
    for (let y = oy; y <= maxY; y += 1) {
      for (let z = oz; z <= maxZ; z += 1) {
        if (x === ox || x === maxX || z === oz || z === maxZ) {
          blocks.push({ x, y, z, blockId: options.wallBlock });
        }
      }
    }
  }

  return blocks;
}

export function enclosureShell(options: {
  origin: readonly [number, number, number];
  width: number;
  depth: number;
  height: number;
  wallBlock: string;
}): BlockPlacement[] {
  const [ox, oy, oz] = options.origin;
  const maxX = ox + options.width - 1;
  const maxZ = oz + options.depth - 1;
  const blocks: BlockPlacement[] = [];

  for (let x = ox; x <= maxX; x += 1) {
    for (let y = oy; y < oy + options.height; y += 1) {
      for (let z = oz; z <= maxZ; z += 1) {
        if (x === ox || x === maxX || z === oz || z === maxZ) {
          blocks.push({ x, y, z, blockId: options.wallBlock });
        }
      }
    }
  }

  return blocks;
}

export function tower(options: {
  base: readonly [number, number, number];
  height: number;
  blockId: string;
}): BlockPlacement[] {
  const [bx, by, bz] = options.base;
  return Array.from({ length: options.height }, (_, dy) => ({
    x: bx,
    y: by + dy,
    z: bz,
    blockId: options.blockId,
  }));
}

export function occupiedCoords(...groups: Iterable<BlockPlacement>[]): Set<string> {
  const occupied = new Set<string>();
  for (const group of groups) {
    for (const block of group) {
      occupied.add(`${block.x},${block.y},${block.z}`);
    }
  }
  return occupied;
}

export function horizontalFacingOffset(facing: string): readonly [number, number] {
  switch (facing) {
    case "north":
      return [0, -1];
    case "south":
      return [0, 1];
    case "east":
      return [1, 0];
    case "west":
      return [-1, 0];
    default:
      throw new Error(`Unsupported facing: ${facing}`);
  }
}

export function playerRelativeOffset(facing: string, relation: string, distance: number): readonly [number, number] {
  const [forwardDx, forwardDz] = horizontalFacingOffset(facing);
  const [leftDx, leftDz] = [forwardDz, -forwardDx];
  const [rightDx, rightDz] = [-forwardDz, forwardDx];

  switch (relation) {
    case "front":
      return [forwardDx * distance, forwardDz * distance];
    case "behind":
      return [-forwardDx * distance, -forwardDz * distance];
    case "left":
      return [leftDx * distance, leftDz * distance];
    case "right":
      return [rightDx * distance, rightDz * distance];
    default:
      throw new Error(`Unsupported player-relative relation: ${relation}`);
  }
}

export function playerRelativeDirection(facing: string, dx: number, dz: number): string {
  const [forwardDx, forwardDz] = horizontalFacingOffset(facing);
  const [leftDx, leftDz] = [forwardDz, -forwardDx];
  const [rightDx, rightDz] = [-forwardDz, forwardDx];

  if (dx === forwardDx && dz === forwardDz) {
    return "front";
  }
  if (dx === -forwardDx && dz === -forwardDz) {
    return "behind";
  }
  if (dx === leftDx && dz === leftDz) {
    return "left";
  }
  if (dx === rightDx && dz === rightDz) {
    return "right";
  }

  throw new Error("Unsupported player-relative offset");
}

export function chainPositions(options: {
  rng: PythonRandom;
  start: readonly [number, number, number];
  hopCount: number;
  stepDistance: number;
}): {
  positions: Array<readonly [number, number, number]>;
  steps: string[];
} {
  const positions: Array<readonly [number, number, number]> = [options.start];
  const steps: string[] = [];
  const used = new Set<string>([options.start.join(",")]);
  let lastDirection: string | null = null;

  for (let hop = 0; hop < options.hopCount; hop += 1) {
    const candidates = Object.keys(cardinalOffsets);
    options.rng.shuffle(candidates);
    let chosen: string | null = null;

    for (const direction of candidates) {
      if (lastDirection && direction === oppositeCardinal[lastDirection]) {
        continue;
      }

      const [dx, , dz] = cardinalOffsets[direction]!;
      const candidate = [
        positions.at(-1)![0] + dx * options.stepDistance,
        positions.at(-1)![1],
        positions.at(-1)![2] + dz * options.stepDistance,
      ] as const;

      if (used.has(candidate.join(","))) {
        continue;
      }

      chosen = direction;
      positions.push(candidate);
      used.add(candidate.join(","));
      break;
    }

    if (!chosen) {
      throw new Error("could not generate non-overlapping chain positions");
    }

    steps.push(chosen);
    lastDirection = chosen;
  }

  return { positions, steps };
}
