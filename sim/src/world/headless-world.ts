/** Authoritative headless voxel world used by generation, execution, and grading. */

import { defaultPlayerSpec, type BlockPlacement, type PlayerSpec, type WorldContext } from "../types.js";
import {
  axisOffsets,
  compareCoords,
  coordFromKey,
  coordKey,
  placementCoord,
  placementKey,
  type BlockMap,
  type Coord,
  type CoordKey,
} from "./coords.js";

const terrainBlockIds = new Set([
  "minecraft:grass_block",
  "minecraft:dirt",
  "minecraft:coarse_dirt",
  "minecraft:podzol",
  "minecraft:mycelium",
  "minecraft:rooted_dirt",
  "minecraft:bedrock",
  "minecraft:sand",
  "minecraft:red_sand",
  "minecraft:gravel",
  "minecraft:deepslate",
  "minecraft:tuff",
]);

type UndoEntry = readonly [CoordKey, string];

type InspectRequest = {
  center: Coord;
  effectiveRadius: number;
  requestedRadius: number;
  detailed: boolean;
  filterTerrain: boolean;
  worldRevision: number;
};

export type ValidationReport = {
  blockCount: number;
  height: { min: number | null; max: number | null };
  bbox: BoundingBox | null;
  dimensions: { x: number; y: number; z: number };
  connected: boolean;
  componentCount: number;
};

export type BoundingBox = {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
};

export type InspectAreaSummary = {
  requestedRadius: number;
  radius: number;
  sampledBlocks: number;
  center: { x: number; y: number; z: number };
  detailed: boolean;
  filterTerrain: boolean;
  radiusClamped: boolean;
  redundantWithPrevious: boolean;
  effectiveRadiusUnchanged: boolean;
  blockCounts?: Record<string, number>;
  retainedBlockCount?: number;
  retainedBbox?: BoundingBox | null;
  topBlockIds?: Array<{ blockId: string; count: number }>;
  nonAirBlocks?: Array<{ x: number; y: number; z: number; blockId: string }>;
};

/** HeadlessVoxelWorld matches the old Python simulator semantics block-for-block. */
export class HeadlessVoxelWorld {
  readonly player: PlayerSpec;
  readonly blocks: BlockMap;

  #undoStack: UndoEntry[] = [];
  #undoBatches: UndoEntry[][] = [];
  #worldRevision = 0;
  #lastInspectRequest: InspectRequest | null = null;

  constructor(options: { player?: Partial<PlayerSpec>; blocks?: Record<string, string> | Iterable<BlockPlacement> } = {}) {
    this.player = defaultPlayerSpec(options.player);
    this.blocks = new Map();

    if (options.blocks) {
      if (Symbol.iterator in Object(options.blocks)) {
        for (const block of options.blocks as Iterable<BlockPlacement>) {
          this.setBlock(placementCoord(block), block.blockId);
        }
      } else {
        for (const [key, blockId] of Object.entries(options.blocks)) {
          const [x, y, z] = coordFromKey(key);
          this.setBlock([x, y, z], blockId);
        }
      }
    }
  }

  /** Rebuild a world from a serialized snapshot. */
  static fromSnapshot(snapshot: WorldContext): HeadlessVoxelWorld {
    return new HeadlessVoxelWorld({
      player: snapshot.player,
      blocks: snapshot.blocks,
    });
  }

  /** Return the canonical block id at the requested coordinate. */
  blockAt(coord: Coord): string {
    return this.blocks.get(coordKey(coord[0], coord[1], coord[2])) ?? "minecraft:air";
  }

  /** Return a plain coord-keyed snapshot of the current world blocks. */
  snapshot(): Record<CoordKey, string> {
    return Object.fromEntries(this.blocks) as Record<CoordKey, string>;
  }

  /** Serialize the world state for transport into execution or backend messages. */
  serialize(): WorldContext {
    return {
      player: { ...this.player },
      blocks: this.snapshot(),
    };
  }

  /** Diff two coord-keyed snapshots using the old Python simulator semantics. */
  diff(before: Record<string, string>, after: Record<string, string> = this.snapshot()): Record<CoordKey, string> {
    const changed: Record<string, string> = {};
    const keys = new Set<string>([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      const beforeBlock = before[key] ?? "minecraft:air";
      const afterBlock = after[key] ?? "minecraft:air";
      if (beforeBlock !== afterBlock) {
        changed[key] = afterBlock;
      }
    }
    return changed as Record<CoordKey, string>;
  }

  /** Summarize the world diff for CLI analysis and grading diagnostics. */
  diffReport(before: Record<string, string>, after: Record<string, string> = this.snapshot()): {
    changedCount: number;
    addedCount: number;
    removedCount: number;
    updatedCount: number;
    bbox?: BoundingBox;
  } {
    const changed = this.diff(before, after);
    let addedCount = 0;
    let removedCount = 0;
    let updatedCount = 0;

    for (const [key, afterBlock] of Object.entries(changed)) {
      const beforeBlock = before[key] ?? "minecraft:air";
      if (beforeBlock === "minecraft:air" && afterBlock !== "minecraft:air") {
        addedCount += 1;
      } else if (beforeBlock !== "minecraft:air" && afterBlock === "minecraft:air") {
        removedCount += 1;
      } else {
        updatedCount += 1;
      }
    }

    return {
      changedCount: Object.keys(changed).length,
      addedCount,
      removedCount,
      updatedCount,
      ...(Object.keys(changed).length > 0 ? { bbox: bboxFromCoords(Object.keys(changed).map((key) => coordFromKey(key))) } : {}),
    };
  }

  /** Place or remove one canonical block. */
  setBlock(coord: Coord, blockId: string): void {
    const normalized = blockId.split("[", 1)[0]!;
    const key = coordKey(coord[0], coord[1], coord[2]);

    if (normalized === "minecraft:air") {
      this.blocks.delete(key);
      return;
    }

    this.blocks.set(key, normalized);
  }

  /** Apply a batch of placements and push a single undo batch. */
  placeBlocks(placements: BlockPlacement[]): { placedCount: number } {
    const history: UndoEntry[] = [];

    for (const placement of placements) {
      const key = placementKey(placement);
      history.push([key, this.blockAt(placementCoord(placement))]);
      this.setBlock(placementCoord(placement), placement.blockId);
    }

    this.#commitUndo(history);
    return { placedCount: placements.length };
  }

  /** Fill an axis-aligned cuboid. */
  fillRegion(options: {
    fromCorner: { x: number; y: number; z: number };
    toCorner: { x: number; y: number; z: number };
    blockId: string;
  }): {
    placedCount: number;
    fillRegion: true;
    fromCorner: { x: number; y: number; z: number };
    toCorner: { x: number; y: number; z: number };
  } {
    const minX = Math.min(options.fromCorner.x, options.toCorner.x);
    const maxX = Math.max(options.fromCorner.x, options.toCorner.x);
    const minY = Math.min(options.fromCorner.y, options.toCorner.y);
    const maxY = Math.max(options.fromCorner.y, options.toCorner.y);
    const minZ = Math.min(options.fromCorner.z, options.toCorner.z);
    const maxZ = Math.max(options.fromCorner.z, options.toCorner.z);
    const volume = (maxX - minX + 1) * (maxY - minY + 1) * (maxZ - minZ + 1);

    if (volume > 4096) {
      throw new Error("fill_region volume must be <= 4096 blocks");
    }

    const history: UndoEntry[] = [];

    for (let x = minX; x <= maxX; x += 1) {
      for (let y = minY; y <= maxY; y += 1) {
        for (let z = minZ; z <= maxZ; z += 1) {
          const key = coordKey(x, y, z);
          history.push([key, this.blockAt([x, y, z])]);
          this.setBlock([x, y, z], options.blockId);
        }
      }
    }

    this.#commitUndo(history);

    return {
      placedCount: history.length,
      fillRegion: true,
      fromCorner: { ...options.fromCorner },
      toCorner: { ...options.toCorner },
    };
  }

  /** Undo the last primitive or batch. */
  undoLast(): { undoneCount: number } {
    const history = this.#undoBatches.pop();
    if (!history) {
      throw new Error("No placement batch to undo");
    }

    for (let index = history.length - 1; index >= 0; index -= 1) {
      const [key, previousBlock] = history[index]!;
      this.setBlock(coordFromKey(key), previousBlock);
    }

    this.#worldRevision += 1;
    return { undoneCount: history.length };
  }

  /** Inspect a radius around a point, preserving the old clamp and redundancy rules. */
  inspectArea(options: {
    center: { x: number; y: number; z: number };
    radius: number;
    detailed?: boolean;
    filterTerrain?: boolean;
  }): InspectAreaSummary {
    const detailed = options.detailed ?? false;
    const filterTerrain = options.filterTerrain ?? true;
    const maxRadius = detailed ? 6 : 12;
    const requestedRadius = options.radius;
    const clampedRadius = Math.max(0, Math.min(maxRadius, requestedRadius));

    const counts = new Map<string, number>();
    const visibleCounts = new Map<string, number>();
    const retainedCounts = new Map<string, number>();
    const nonAirBlocks: Array<{ x: number; y: number; z: number; blockId: string }> = [];

    for (let dx = -clampedRadius; dx <= clampedRadius; dx += 1) {
      for (let dy = -clampedRadius; dy <= clampedRadius; dy += 1) {
        for (let dz = -clampedRadius; dz <= clampedRadius; dz += 1) {
          const x = options.center.x + dx;
          const y = options.center.y + dy;
          const z = options.center.z + dz;
          const blockId = this.blockAt([x, y, z]);

          counts.set(blockId, (counts.get(blockId) ?? 0) + 1);

          if (!filterTerrain || (blockId !== "minecraft:air" && !isTerrainBlock(blockId, y))) {
            visibleCounts.set(blockId, (visibleCounts.get(blockId) ?? 0) + 1);
          }

          if (detailed && blockId !== "minecraft:air" && !(filterTerrain && isTerrainBlock(blockId, y))) {
            retainedCounts.set(blockId, (retainedCounts.get(blockId) ?? 0) + 1);
            nonAirBlocks.push({ x, y, z, blockId });
          }
        }
      }
    }

    const currentRequest: InspectRequest = {
      center: [options.center.x, options.center.y, options.center.z],
      effectiveRadius: clampedRadius,
      requestedRadius,
      detailed,
      filterTerrain,
      worldRevision: this.#worldRevision,
    };

    const previousRequest = this.#lastInspectRequest;
    const redundantWithPrevious = Boolean(
      previousRequest
      && previousRequest.center[0] === currentRequest.center[0]
      && previousRequest.center[1] === currentRequest.center[1]
      && previousRequest.center[2] === currentRequest.center[2]
      && previousRequest.effectiveRadius === currentRequest.effectiveRadius
      && previousRequest.detailed === currentRequest.detailed
      && previousRequest.filterTerrain === currentRequest.filterTerrain
      && previousRequest.worldRevision === currentRequest.worldRevision,
    );
    const effectiveRadiusUnchanged = Boolean(
      redundantWithPrevious
      && detailed
      && previousRequest
      && previousRequest.requestedRadius !== requestedRadius,
    );

    this.#lastInspectRequest = currentRequest;

    const base: InspectAreaSummary = {
      requestedRadius,
      radius: clampedRadius,
      sampledBlocks: (2 * clampedRadius + 1) ** 3,
      center: { ...options.center },
      detailed,
      filterTerrain,
      radiusClamped: requestedRadius !== clampedRadius,
      redundantWithPrevious,
      effectiveRadiusUnchanged,
    };

    if (detailed) {
      return {
        ...base,
        retainedBlockCount: nonAirBlocks.length,
        retainedBbox: nonAirBlocks.length > 0
          ? bboxFromCoords(nonAirBlocks.map((block) => [block.x, block.y, block.z] as Coord))
          : null,
        topBlockIds: topBlockIds(retainedCounts),
        nonAirBlocks,
      };
    }

    const source = filterTerrain ? visibleCounts : counts;
    return {
      ...base,
      blockCounts: Object.fromEntries([...source.entries()].sort(([left], [right]) => left.localeCompare(right))),
    };
  }

  /** Return the old tool-format player position payload. */
  playerPosition(): Record<string, string | number> {
    return {
      x: this.player.x,
      y: this.player.y,
      z: this.player.z,
      yaw: 0,
      pitch: 0,
      block_x: this.player.x,
      block_y: this.player.y,
      block_z: this.player.z,
      facing: this.player.facing,
      dimension: this.player.dimension,
    };
  }

  /** Return the old empty inventory payload for compatibility inside the new sim. */
  playerInventory(): Record<string, number | unknown[]> {
    return {
      selected_slot: 0,
      filled_slots: 0,
      total_item_count: 0,
      items: [],
    };
  }

  /** Render a simple ASCII slice for debugging. */
  asciiSlice(y: number): string {
    const layerCoords = [...this.blocks.keys()]
      .map((key) => coordFromKey(key))
      .filter((coord) => coord[1] === y);

    if (layerCoords.length === 0) {
      return `y=${y} (empty)`;
    }

    const minX = Math.min(...layerCoords.map((coord) => coord[0]));
    const maxX = Math.max(...layerCoords.map((coord) => coord[0]));
    const minZ = Math.min(...layerCoords.map((coord) => coord[2]));
    const maxZ = Math.max(...layerCoords.map((coord) => coord[2]));
    const rows = [`y=${y} x=${minX}..${maxX} z=${minZ}..${maxZ}`];

    for (let z = minZ; z <= maxZ; z += 1) {
      const chars: string[] = [];

      for (let x = minX; x <= maxX; x += 1) {
        const blockId = this.blockAt([x, y, z]);
        if (blockId === "minecraft:air") {
          chars.push(".");
          continue;
        }
        chars.push(blockId.split(":").at(-1)!.charAt(0).toUpperCase());
      }

      rows.push(chars.join(""));
    }

    return rows.join("\n");
  }

  /** Compute world-level connectivity and span statistics. */
  validationReport(): ValidationReport {
    if (this.blocks.size === 0) {
      return {
        blockCount: 0,
        height: { min: null, max: null },
        bbox: null,
        dimensions: { x: 0, y: 0, z: 0 },
        connected: false,
        componentCount: 0,
      };
    }

    const coords = [...this.blocks.keys()].map((key) => coordFromKey(key));
    const bbox = bboxFromCoords(coords);
    const ys = coords.map((coord) => coord[1]);
    const componentCount = connectedComponentCount(coords);

    return {
      blockCount: coords.length,
      height: { min: Math.min(...ys), max: Math.max(...ys) },
      bbox,
      dimensions: {
        x: bbox.max.x - bbox.min.x + 1,
        y: bbox.max.y - bbox.min.y + 1,
        z: bbox.max.z - bbox.min.z + 1,
      },
      connected: componentCount === 1,
      componentCount,
    };
  }

  /** Flatten terrain into a filled square with a grassy top surface. */
  flatTerrain(options: {
    radius: number;
    surfaceY?: number;
    surfaceBlock?: string;
    fillBlock?: string;
    depth?: number;
  }): void {
    const surfaceY = options.surfaceY ?? 63;
    const surfaceBlock = options.surfaceBlock ?? "minecraft:grass_block";
    const fillBlock = options.fillBlock ?? "minecraft:dirt";
    const depth = options.depth ?? 4;

    for (let x = -options.radius; x <= options.radius; x += 1) {
      for (let z = -options.radius; z <= options.radius; z += 1) {
        this.setBlock([x, surfaceY, z], surfaceBlock);
        for (let y = surfaceY - depth; y < surfaceY; y += 1) {
          this.setBlock([x, y, z], fillBlock);
        }
      }
    }
  }

  /** Fill a rectangular prism without recording undo state. */
  filledBox(origin: Coord, size: Coord, blockId: string): void {
    const [ox, oy, oz] = origin;
    const [width, height, depth] = size;

    for (let x = ox; x < ox + width; x += 1) {
      for (let y = oy; y < oy + height; y += 1) {
        for (let z = oz; z < oz + depth; z += 1) {
          this.setBlock([x, y, z], blockId);
        }
      }
    }
  }

  /** Fill only the outer walls of a rectangular prism without recording undo state. */
  boxWalls(origin: Coord, size: Coord, blockId: string): void {
    const [ox, oy, oz] = origin;
    const [width, height, depth] = size;
    const maxX = ox + width - 1;
    const maxY = oy + height - 1;
    const maxZ = oz + depth - 1;

    for (let x = ox; x <= maxX; x += 1) {
      for (let y = oy; y <= maxY; y += 1) {
        for (let z = oz; z <= maxZ; z += 1) {
          if (x === ox || x === maxX || z === oz || z === maxZ) {
            this.setBlock([x, y, z], blockId);
          }
        }
      }
    }
  }

  /** Build a floor and enclosing walls in one helper. */
  floorWithWalls(origin: Coord, size: Coord, options: { floorBlock: string; wallBlock: string }): void {
    const [ox, oy, oz] = origin;
    const [width, height, depth] = size;

    this.filledBox([ox, oy, oz], [width, 1, depth], options.floorBlock);
    this.boxWalls([ox, oy + 1, oz], [width, height - 1, depth], options.wallBlock);
  }

  /** Expose the world revision for inspection caching in higher layers. */
  get worldRevision(): number {
    return this.#worldRevision;
  }

  #commitUndo(history: UndoEntry[]): void {
    this.#undoStack.push(...history);
    this.#undoBatches.push(history);
    this.#worldRevision += 1;
  }
}

export function worldBoundingBox(blocks: Iterable<Coord>): readonly [Coord, Coord] {
  const points = [...blocks];
  if (points.length === 0) {
    throw new Error("Cannot compute bounding box for empty block set");
  }

  const xs = points.map((coord) => coord[0]);
  const ys = points.map((coord) => coord[1]);
  const zs = points.map((coord) => coord[2]);

  return [
    [Math.min(...xs), Math.min(...ys), Math.min(...zs)],
    [Math.max(...xs), Math.max(...ys), Math.max(...zs)],
  ] as const;
}

export function bboxFromCoords(blocks: Iterable<Coord>): BoundingBox {
  const [minimum, maximum] = worldBoundingBox(blocks);

  return {
    min: { x: minimum[0], y: minimum[1], z: minimum[2] },
    max: { x: maximum[0], y: maximum[1], z: maximum[2] },
  };
}

export function connectedComponentCount(blocks: Iterable<Coord>): number {
  const remaining = new Set([...blocks].map((coord) => coordKey(coord[0], coord[1], coord[2])));
  if (remaining.size === 0) {
    return 0;
  }

  let components = 0;

  while (remaining.size > 0) {
    components += 1;
    const seed = remaining.values().next().value as CoordKey;
    const queue = [seed];
    remaining.delete(seed);

    while (queue.length > 0) {
      const [x, y, z] = coordFromKey(queue.pop()!);
      for (const [dx, dy, dz] of axisOffsets) {
        const neighbor = coordKey(x + dx, y + dy, z + dz);
        if (remaining.has(neighbor)) {
          remaining.delete(neighbor);
          queue.push(neighbor);
        }
      }
    }
  }

  return components;
}

export function placementsFromDiff(diff: Record<string, string>): BlockPlacement[] {
  return Object.entries(diff)
    .map(([key, blockId]) => {
      const [x, y, z] = coordFromKey(key);
      return { x, y, z, blockId };
    })
    .sort((left, right) => compareCoords([left.x, left.y, left.z], [right.x, right.y, right.z]));
}

function isTerrainBlock(blockId: string, y: number): boolean {
  return (blockId === "minecraft:stone" && y <= 63) || terrainBlockIds.has(blockId);
}

function topBlockIds(counts: Map<string, number>, limit = 4): Array<{ blockId: string; count: number }> {
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([blockId, count]) => ({ blockId, count }));
}
