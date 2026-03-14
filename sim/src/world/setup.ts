/** World bootstrap helpers shared by execution, grading, and collection. */

import type { BlockPlacement, BuildTaskSpec, PlayerSpec, TextQATaskSpec } from "../types.js";
import { HeadlessVoxelWorld, placementsFromDiff } from "./headless-world.js";

/** Build the old flat-terrain baseline plus task setup blocks. */
export function buildWorldFromSetup(options: {
  player: PlayerSpec;
  setupBlocks: Iterable<BlockPlacement>;
  terrainRadius?: number;
}): HeadlessVoxelWorld {
  const world = new HeadlessVoxelWorld({ player: options.player });
  world.flatTerrain({ radius: options.terrainRadius ?? 24 });

  for (const placement of options.setupBlocks) {
    world.setBlock([placement.x, placement.y, placement.z], placement.blockId);
  }

  return world;
}

/** Build the default world for a build or text-QA task. */
export function buildWorld(task: BuildTaskSpec | TextQATaskSpec, terrainRadius = 24): HeadlessVoxelWorld {
  return buildWorldFromSetup({
    player: task.player,
    setupBlocks: task.setupBlocks,
    terrainRadius,
  });
}

/** Convert a serialized diff object into sorted placements. */
export function diffToPlacements(diff: Record<string, string>): BlockPlacement[] {
  return placementsFromDiff(diff);
}
