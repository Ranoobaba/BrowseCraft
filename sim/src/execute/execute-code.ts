/** just-bash execution harness for MineBench-style voxel.exec programs. */

import { Bash } from "just-bash";
import { buildExecutionResultSchema, type BuildExecutionResult } from "../types.js";
import { HeadlessVoxelWorld, placementsFromDiff } from "../world/headless-world.js";
import { linePlacements, spherePlacements, cylinderPlacements } from "./primitives.js";

const RESULT_PREFIX = "__BROWSECRAFT_RESULT__";
const PROGRAM_PATH = "program.js";
const MAX_JS_TIMEOUT_MS = 10_000;

/** Execute one JS program against a world snapshot and return the resulting diff. */
export async function executeCode(world: HeadlessVoxelWorld, code: string): Promise<BuildExecutionResult> {
  const before = world.snapshot();
  const startedAt = performance.now();

  try {
    const env = new Bash({
      javascript: { bootstrap: buildBootstrap(world.serialize()) },
      executionLimits: { maxJsTimeoutMs: MAX_JS_TIMEOUT_MS },
    });

    await env.writeFile(PROGRAM_PATH, buildProgram(code));

    const execution = await env.exec(`js-exec ${PROGRAM_PATH}`);
    const executionTimeMs = performance.now() - startedAt;
    if (execution.exitCode !== 0) {
      return failureResult(world, normalizeJsExecError(execution.stderr), executionTimeMs);
    }

    const payload = parseExecutionPayload(execution.stdout);
    const finalWorld = HeadlessVoxelWorld.fromSnapshot(payload.finalSnapshot);
    const diff = finalWorld.diff(before, payload.finalSnapshot.blocks);

    return buildExecutionResultSchema.parse({
      success: payload.success,
      error: payload.error,
      primitiveCount: payload.primitiveCount,
      executionTimeMs,
      finalSnapshot: payload.finalSnapshot,
      worldDiff: placementsFromDiff(diff),
    });
  } catch (error) {
    return failureResult(world, String(error), performance.now() - startedAt);
  }
}

type BootstrapPayload = {
  success: boolean;
  error: string | null;
  primitiveCount: number;
  finalSnapshot: {
    player: { x: number; y: number; z: number; facing: string; dimension: string };
    blocks: Record<string, string>;
  };
};

/** Wrap user code so execution always emits one machine-readable payload line. */
function buildProgram(code: string): string {
  return `
"use strict";
((require, process, Function, console) => {
try {
${code}
  globalThis.__emitResult({
    success: true,
    error: null,
    primitiveCount: globalThis.__voxelState.primitiveCount,
    finalSnapshot: {
      player: globalThis.__voxelState.player,
      blocks: globalThis.__voxelState.blocks,
    },
  });
} catch (error) {
  globalThis.__emitResult({
    success: false,
    error: [
      error && typeof error === "object" && "message" in error ? String(error.message) : String(error),
      error && typeof error === "object" && "stack" in error ? String(error.stack) : "",
    ].filter(Boolean).join("\\n"),
    primitiveCount: globalThis.__voxelState.primitiveCount,
    finalSnapshot: {
      player: globalThis.__voxelState.player,
      blocks: globalThis.__voxelState.blocks,
    },
  });
}
})(
  () => { throw new Error("require is not available in this sandbox"); },
  undefined,
  undefined,
  globalThis.console,
);
`;
}

/** Install the voxel DSL into just-bash's QuickJS runtime before user code runs. */
function buildBootstrap(snapshot: { player: object; blocks: Record<string, string> }): string {
  return `
const __terrain = new Set([
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
const __linePlacements = ${linePlacements.toString()};
const __spherePlacements = ${spherePlacements.toString()};
const __cylinderPlacements = ${cylinderPlacements.toString()};
const __snapshot = ${JSON.stringify(snapshot)};
const __originalConsole = console;
const __silentConsole = {
  log() {},
  error() {},
  warn() {},
  info() {},
  debug() {},
};

globalThis.process = undefined;
globalThis.require = undefined;
globalThis.Function = undefined;
globalThis.eval = undefined;
globalThis.console = __silentConsole;
globalThis.__emitResult = (payload) => {
  __originalConsole.log(${JSON.stringify(RESULT_PREFIX)} + JSON.stringify(payload));
};

globalThis.__voxelState = {
  player: __snapshot.player,
  blocks: { ...__snapshot.blocks },
  primitiveCount: 0,
  undoStack: [],
  worldRevision: 0,
  lastInspectRequest: null,
};

function __key(x, y, z) {
  return \`\${x},\${y},\${z}\`;
}

function __canonical(blockId) {
  return String(blockId).split("[", 1)[0];
}

function __blockAt(x, y, z) {
  return globalThis.__voxelState.blocks[__key(x, y, z)] ?? "minecraft:air";
}

function __setBlock(x, y, z, blockId) {
  const normalized = __canonical(blockId);
  const key = __key(x, y, z);
  if (normalized === "minecraft:air") {
    delete globalThis.__voxelState.blocks[key];
    return;
  }
  globalThis.__voxelState.blocks[key] = normalized;
}

function __commit(placements) {
  const history = [];
  for (const placement of placements) {
    const key = __key(placement.x, placement.y, placement.z);
    history.push([key, __blockAt(placement.x, placement.y, placement.z)]);
    __setBlock(placement.x, placement.y, placement.z, placement.blockId);
  }
  globalThis.__voxelState.undoStack.push(history);
  globalThis.__voxelState.worldRevision += 1;
}

function __isTerrainBlock(blockId, y) {
  return (blockId === "minecraft:stone" && y <= 63) || __terrain.has(blockId);
}

function __topBlockIds(counts, limit = 4) {
  return Object.entries(counts)
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([blockId, count]) => ({ blockId, count }));
}

function block(x, y, z, blockId) {
  globalThis.__voxelState.primitiveCount += 1;
  __commit([{ x, y, z, blockId: String(blockId) }]);
}

function box(x1, y1, z1, x2, y2, z2, blockId) {
  globalThis.__voxelState.primitiveCount += 1;
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);
  const minZ = Math.min(z1, z2);
  const maxZ = Math.max(z1, z2);
  const volume = (maxX - minX + 1) * (maxY - minY + 1) * (maxZ - minZ + 1);
  if (volume > 4096) {
    throw new Error("box volume must be <= 4096 blocks");
  }
  const placements = [];
  for (let x = minX; x <= maxX; x += 1) {
    for (let y = minY; y <= maxY; y += 1) {
      for (let z = minZ; z <= maxZ; z += 1) {
        placements.push({ x, y, z, blockId: String(blockId) });
      }
    }
  }
  __commit(placements);
}

function line(x1, y1, z1, x2, y2, z2, blockId) {
  globalThis.__voxelState.primitiveCount += 1;
  __commit(__linePlacements(x1, y1, z1, x2, y2, z2, String(blockId)));
}

function sphere(cx, cy, cz, radius, blockId, hollow = false) {
  globalThis.__voxelState.primitiveCount += 1;
  __commit(__spherePlacements(cx, cy, cz, radius, String(blockId), hollow));
}

function cylinder(cx, cy, cz, radius, height, blockId, axis = "y") {
  globalThis.__voxelState.primitiveCount += 1;
  __commit(__cylinderPlacements(cx, cy, cz, radius, height, String(blockId), axis));
}

function inspect(cx, cy, cz, radius, detailed = false, filterTerrain = true) {
  globalThis.__voxelState.primitiveCount += 1;
  const maxRadius = detailed ? 6 : 12;
  const requestedRadius = radius;
  const clampedRadius = Math.max(0, Math.min(maxRadius, requestedRadius));
  const counts = {};
  const visibleCounts = {};
  const retainedCounts = {};
  const nonAirBlocks = [];

  for (let dx = -clampedRadius; dx <= clampedRadius; dx += 1) {
    for (let dy = -clampedRadius; dy <= clampedRadius; dy += 1) {
      for (let dz = -clampedRadius; dz <= clampedRadius; dz += 1) {
        const x = cx + dx;
        const y = cy + dy;
        const z = cz + dz;
        const blockId = __blockAt(x, y, z);
        counts[blockId] = (counts[blockId] ?? 0) + 1;
        if (!filterTerrain || (blockId !== "minecraft:air" && !__isTerrainBlock(blockId, y))) {
          visibleCounts[blockId] = (visibleCounts[blockId] ?? 0) + 1;
        }
        if (detailed && blockId !== "minecraft:air" && !(filterTerrain && __isTerrainBlock(blockId, y))) {
          retainedCounts[blockId] = (retainedCounts[blockId] ?? 0) + 1;
          nonAirBlocks.push({ x, y, z, blockId });
        }
      }
    }
  }

  const currentRequest = {
    center: [cx, cy, cz],
    effectiveRadius: clampedRadius,
    requestedRadius,
    detailed,
    filterTerrain,
    worldRevision: globalThis.__voxelState.worldRevision,
  };
  const previous = globalThis.__voxelState.lastInspectRequest;
  const redundantWithPrevious = Boolean(
    previous
    && previous.center[0] === currentRequest.center[0]
    && previous.center[1] === currentRequest.center[1]
    && previous.center[2] === currentRequest.center[2]
    && previous.effectiveRadius === currentRequest.effectiveRadius
    && previous.detailed === currentRequest.detailed
    && previous.filterTerrain === currentRequest.filterTerrain
    && previous.worldRevision === currentRequest.worldRevision
  );
  const effectiveRadiusUnchanged = Boolean(
    redundantWithPrevious
    && detailed
    && previous
    && previous.requestedRadius !== requestedRadius
  );
  globalThis.__voxelState.lastInspectRequest = currentRequest;

  const result = {
    requestedRadius,
    radius: clampedRadius,
    sampledBlocks: (2 * clampedRadius + 1) ** 3,
    center: { x: cx, y: cy, z: cz },
    detailed,
    filterTerrain,
    radiusClamped: requestedRadius !== clampedRadius,
    redundantWithPrevious,
    effectiveRadiusUnchanged,
  };

  if (detailed) {
    const coords = nonAirBlocks.map((block) => [block.x, block.y, block.z]);
    const xs = coords.map((coord) => coord[0]);
    const ys = coords.map((coord) => coord[1]);
    const zs = coords.map((coord) => coord[2]);
    return {
      ...result,
      retainedBlockCount: nonAirBlocks.length,
      retainedBbox: nonAirBlocks.length === 0 ? null : {
        min: { x: Math.min(...xs), y: Math.min(...ys), z: Math.min(...zs) },
        max: { x: Math.max(...xs), y: Math.max(...ys), z: Math.max(...zs) },
      },
      topBlockIds: __topBlockIds(retainedCounts),
      nonAirBlocks,
    };
  }

  const source = filterTerrain ? visibleCounts : counts;
  return {
    ...result,
    blockCounts: Object.fromEntries(Object.entries(source).sort(([left], [right]) => left.localeCompare(right))),
  };
}

function playerPos() {
  globalThis.__voxelState.primitiveCount += 1;
  return {
    x: globalThis.__voxelState.player.x,
    y: globalThis.__voxelState.player.y,
    z: globalThis.__voxelState.player.z,
  };
}

function undo() {
  globalThis.__voxelState.primitiveCount += 1;
  const history = globalThis.__voxelState.undoStack.pop();
  if (!history) {
    throw new Error("No placement batch to undo");
  }
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const [key, previousBlock] = history[index];
    const [x, y, z] = key.split(",").map(Number);
    __setBlock(x, y, z, previousBlock);
  }
  globalThis.__voxelState.worldRevision += 1;
  return { undoneCount: history.length };
}

globalThis.block = block;
globalThis.box = box;
globalThis.line = line;
globalThis.sphere = sphere;
globalThis.cylinder = cylinder;
globalThis.inspect = inspect;
globalThis.playerPos = playerPos;
globalThis.undo = undo;
`;
}

/** Extract the result payload from the js-exec stdout stream. */
function parseExecutionPayload(stdout: string): BootstrapPayload {
  const lines = stdout.trim().split("\n").reverse();
  const line = lines.find((candidate) => candidate.startsWith(RESULT_PREFIX));
  if (!line) {
    throw new Error("js-exec completed without a BrowseCraft result payload");
  }

  return JSON.parse(line.slice(RESULT_PREFIX.length)) as BootstrapPayload;
}

/** Keep parse failures easy to classify for grading and tests. */
function normalizeJsExecError(stderr: string): string {
  const message = stderr.trim() || "js-exec failed";
  if (/\bexpecting\b/i.test(message) && !/\bparse\b|\bsyntax\b/i.test(message)) {
    return `Parse error: ${message}`;
  }

  return message;
}

function failureResult(world: HeadlessVoxelWorld, error: string, executionTimeMs: number): BuildExecutionResult {
  return buildExecutionResultSchema.parse({
    success: false,
    error,
    primitiveCount: 0,
    executionTimeMs,
    finalSnapshot: world.serialize(),
    worldDiff: [],
  });
}
