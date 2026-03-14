/** Deterministic build-task generation ported from the Python RL simulator. */

import { createHash } from "node:crypto";
import {
  buildTiers,
  defaultPlayerSpec,
  defaultStructuralChecks,
  normalizeSeed,
  type BlockPlacement,
  type BuildTaskSpec,
  type BuildTier,
  type StructuralChecks,
} from "../types.js";
import {
  blockName,
  cardinalOffsets,
  chainPositions,
  dedupeBlocks,
  enclosureShell,
  filledRect,
  horizontalFacingOffset,
  lineBlocks,
  markerBlocks,
  markerName,
  occupiedCoords,
  playerRelativeOffset,
  removeCoords,
  roomShell,
  tower,
} from "./spatial-worlds.js";
import { PythonRandom } from "./python-random.js";

const buildBlocks = [
  "minecraft:stone",
  "minecraft:oak_planks",
  "minecraft:birch_planks",
  "minecraft:cobblestone",
  "minecraft:stone_bricks",
  "minecraft:sandstone",
  "minecraft:deepslate_bricks",
] as const;

const distractorSentences = [
  "There is also an unrelated birch plank pillar nearby. Ignore it.",
  "A separate cobblestone marker sits off to the side and is irrelevant to this task.",
  "An extra stone pillar is nearby, but it does not matter for this task.",
] as const;

type Builder = (args: { seed: bigint; index: number; rng: PythonRandom }) => BuildTaskSpec;

/** Generate deterministic build tasks for the requested tiers. */
export function generateBuildTasks(options: {
  seed: number;
  perTier: number;
  tiers?: readonly BuildTier[];
}): BuildTaskSpec[] {
  if (options.perTier <= 0) {
    throw new Error("perTier must be > 0");
  }

  const selected = [...(options.tiers ?? buildTiers)];
  const tasks: BuildTaskSpec[] = [];

  for (const tier of selected) {
    for (let index = 0; index < options.perTier; index += 1) {
      tasks.push(generateBuildTask({ tier, seed: options.seed, index }));
    }
  }

  return tasks;
}

/** Sample weighted tasks using the original tier-level RNG flow. */
export function sampleWeightedBuildTasks(options: {
  seed: number;
  totalTasks: number;
  tierWeights: Record<BuildTier, number>;
  tiers?: readonly BuildTier[];
}): BuildTaskSpec[] {
  if (options.totalTasks <= 0) {
    throw new Error("totalTasks must be > 0");
  }

  const selected = [...(options.tiers ?? buildTiers)];
  const missing = selected.filter((tier) => options.tierWeights[tier] === undefined);
  if (missing.length > 0) {
    throw new Error(`missing tier weights for: ${missing.join(", ")}`);
  }

  const rng = new PythonRandom(deriveSeed({
    seed: BigInt(options.seed),
    tier: selected[0]!,
    index: options.totalTasks,
  }));
  const nextIndex = Object.fromEntries(selected.map((tier) => [tier, 0])) as Record<BuildTier, number>;
  const weights = selected.map((tier) => options.tierWeights[tier]);
  const tasks: BuildTaskSpec[] = [];

  for (let count = 0; count < options.totalTasks; count += 1) {
    const tier = rng.choices(selected, weights, 1)[0]!;
    const index = nextIndex[tier];
    nextIndex[tier] += 1;
    tasks.push(generateBuildTask({ tier, seed: options.seed, index }));
  }

  return tasks;
}

/** Generate one deterministic task. */
export function generateBuildTask(options: { tier: BuildTier; seed: number | bigint; index?: number }): BuildTaskSpec {
  const index = options.index ?? 0;
  const derivedSeed = deriveSeed({
    seed: typeof options.seed === "bigint" ? options.seed : BigInt(options.seed),
    tier: options.tier,
    index,
  });
  const rng = new PythonRandom(derivedSeed);
  return taskBuilders[options.tier]({ seed: derivedSeed, index, rng });
}

/** Reconstruct a task directly from the canonical task id. */
export function reconstructBuildTaskFromTaskId(taskId: string): BuildTaskSpec {
  const [tier, family, seedText, indexText] = taskId.split(":", 4);
  const builder = taskBuilders[tier as BuildTier];
  if (!builder) {
    throw new Error(`Unknown build tier in task id: ${taskId}`);
  }
  if (!family || !seedText || !indexText) {
    throw new Error(`Invalid build task id: ${taskId}`);
  }

  return builder({
    seed: BigInt(seedText),
    index: Number.parseInt(indexText, 10),
    rng: new ForcedFamilyRandom(BigInt(seedText), family),
  });
}

/** Count tasks per tier for analysis scripts. */
export function buildTierCounts(tasks: Iterable<BuildTaskSpec>): Record<BuildTier, number> {
  const counts = Object.fromEntries(buildTiers.map((tier) => [tier, 0])) as Record<BuildTier, number>;
  for (const task of tasks) {
    counts[task.tier] += 1;
  }
  return counts;
}

function buildTaskId(tier: BuildTier, seed: bigint, family: string, index: number): string {
  return `${tier}:${family}:${seed}:${index}`;
}

function canonicalIntent(family: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { family, ...fields };
}

function deriveSeed(options: { seed: bigint; tier: BuildTier; index: number }): bigint {
  const digest = createHash("sha256")
    .update(`${options.seed}:${options.tier}:${options.index}`)
    .digest("hex")
    .slice(0, 16);
  return BigInt(`0x${digest}`);
}

function expectedPrimitiveCount(tier: BuildTier, family: string): number {
  switch (tier) {
    case "t1_absolute":
      return 1;
    case "t2_relative_single_ref":
      return family === "relative_single_reference" ? 2 : 1;
    case "t3_primitives":
      return 1;
    case "t4_structure_relative":
      switch (family) {
        case "marker_chain_place":
        case "structure_chain_place":
          return 4;
        case "mark_structure_inside_enclosure":
          return 3;
        default:
          return 2;
      }
    case "t5_modification":
      switch (family) {
        case "replace_material_preserve_shape":
          return 3;
        case "move_window_to_opposite_wall":
          return 3;
        default:
          return 2;
      }
    case "t6_composition":
      switch (family) {
        case "connect_rooms_with_corridor":
        case "l_shaped_corridor_offset_rooms":
          return 5;
        case "bridge_between_offset_towers":
          return 3;
        default:
          return 2;
      }
  }
}

function addOptionalDistractor(args: {
  rng: PythonRandom;
  tier: BuildTier;
  prompt: string;
  setup: BlockPlacement[];
  target: BlockPlacement[];
  preserved: BlockPlacement[];
  metadata: Record<string, unknown>;
}): { prompt: string; setup: BlockPlacement[]; metadata: Record<string, unknown> } {
  if (!["t4_structure_relative", "t5_modification", "t6_composition"].includes(args.tier)) {
    return { prompt: args.prompt, setup: args.setup, metadata: args.metadata };
  }
  if (args.rng.random() >= 0.6) {
    return { prompt: args.prompt, setup: args.setup, metadata: args.metadata };
  }

  const occupied = occupiedCoords(args.setup, args.target, args.preserved);
  const candidateBases = [
    [-18, 64, -18],
    [-18, 64, 18],
    [18, 64, -18],
    [18, 64, 18],
  ] as const;

  let distractorBase: readonly [number, number, number] | null = null;
  let distractorBlocks: BlockPlacement[] = [];

  for (const base of candidateBases) {
    const blocks = tower({ base, height: 3, blockId: "minecraft:birch_planks" });
    if ([...occupiedCoords(blocks)].every((key) => !occupied.has(key))) {
      distractorBase = base;
      distractorBlocks = blocks;
      break;
    }
  }

  if (!distractorBase) {
    return { prompt: args.prompt, setup: args.setup, metadata: args.metadata };
  }

  return {
    prompt: `${args.prompt} ${args.rng.choice(distractorSentences)}`,
    setup: [...args.setup, ...distractorBlocks],
    metadata: {
      ...args.metadata,
      distractor: {
        kind: "pillar",
        base: { x: distractorBase[0], y: distractorBase[1], z: distractorBase[2] },
        height: 3,
        blockId: "minecraft:birch_planks",
      },
    },
  };
}

function buildT1Absolute(args: { seed: bigint; index: number; rng: PythonRandom }): BuildTaskSpec {
  const blockId = args.rng.choice(buildBlocks);
  const x = args.rng.randint(-4, 4);
  const z = args.rng.randint(-4, 4);
  const y = 64;
  const family = "absolute_single_block";
  const targetBlocks = [{ x, y, z, blockId }];

  return {
    taskId: buildTaskId("t1_absolute", args.seed, family, args.index),
    tier: "t1_absolute",
    family,
    seed: normalizeSeed(args.seed),
    prompt: `Place one ${blockId} block at absolute coordinates (x=${x}, y=${y}, z=${z}).`,
    player: defaultPlayerSpec(),
    setupBlocks: [],
    targetBlocks,
    preservedBlocks: [],
    expectedPrimitiveCount: expectedPrimitiveCount("t1_absolute", family),
    structuralChecks: defaultStructuralChecks({ requireGrounded: true }),
    metadata: {
      difficulty: "easy",
      canonicalIntent: canonicalIntent(family, {
        blockId,
        coordinate: { x, y, z },
      }),
    },
  };
}

function buildT2Relative(args: { seed: bigint; index: number; rng: PythonRandom }): BuildTaskSpec {
  const family = args.rng.choice(["relative_single_reference", "egocentric_relative"] as const);

  if (family === "relative_single_reference") {
    const refX = args.rng.randint(-4, 4);
    const refZ = args.rng.randint(-4, 4);
    const refY = 64;
    const reference = { x: refX, y: refY, z: refZ, blockId: "minecraft:red_wool" };
    const blockId = args.rng.choice(buildBlocks);
    const relation = args.rng.choice(["north", "south", "east", "west", "up"] as const);
    const distance = relation === "up" ? 1 : args.rng.randint(1, 3);
    const [dx, dy, dz] = relation === "up" ? [0, 1, 0] : cardinalOffsets[relation]!;
    const targetBlocks = [{
      x: refX + dx * distance,
      y: refY + dy * distance,
      z: refZ + dz * distance,
      blockId,
    }];

    return {
      taskId: buildTaskId("t2_relative_single_ref", args.seed, family, args.index),
      tier: "t2_relative_single_ref",
      family,
      seed: normalizeSeed(args.seed),
      prompt: `A minecraft:red_wool reference block is at (${refX}, ${refY}, ${refZ}). Place one ${blockId} block ${distance} blocks ${relation} of that reference.`,
      player: defaultPlayerSpec(),
      setupBlocks: [reference],
      targetBlocks,
      preservedBlocks: [],
      expectedPrimitiveCount: expectedPrimitiveCount("t2_relative_single_ref", family),
      structuralChecks: defaultStructuralChecks({ requireGrounded: true }),
      metadata: {
        relation,
        distance,
        canonicalIntent: canonicalIntent(family, {
          blockId,
          reference: { x: refX, y: refY, z: refZ },
          relation,
          distance,
        }),
      },
    };
  }

  const facing = args.rng.choice(["north", "south", "east", "west"] as const);
  const relation = args.rng.choice(["front", "behind", "left", "right"] as const);
  const relationText = {
    front: "in front of you",
    behind: "behind you",
    left: "to your left",
    right: "to your right",
  }[relation];
  const distance = args.rng.randint(1, 3);
  const blockId = args.rng.choice(buildBlocks);
  const [dx, dz] = playerRelativeOffset(facing, relation, distance);

  return {
    taskId: buildTaskId("t2_relative_single_ref", args.seed, family, args.index),
    tier: "t2_relative_single_ref",
    family,
    seed: normalizeSeed(args.seed),
    prompt: `Place one ${blockId} block ${distance} blocks ${relationText}.`,
    player: defaultPlayerSpec({ facing }),
    setupBlocks: [],
    targetBlocks: [{ x: dx, y: 64, z: dz, blockId }],
    preservedBlocks: [],
    expectedPrimitiveCount: expectedPrimitiveCount("t2_relative_single_ref", family),
    structuralChecks: defaultStructuralChecks({ requireGrounded: true }),
    metadata: {
      frame: "player",
      relation,
      distance,
      canonicalIntent: canonicalIntent(family, {
        blockId,
        playerFacing: facing,
        relation,
        distance,
      }),
    },
  };
}

function buildT3Primitives(args: { seed: bigint; index: number; rng: PythonRandom }): BuildTaskSpec {
  const family = args.rng.choice(["tower", "wall", "floor"] as const);
  const blockId = args.rng.choice(buildBlocks);

  let targetBlocks: BlockPlacement[];
  let prompt: string;
  let metadata: Record<string, unknown>;

  if (family === "tower") {
    const x = args.rng.randint(-4, 4);
    const z = args.rng.randint(-4, 4);
    const height = args.rng.randint(3, 5);
    targetBlocks = lineBlocks({ axis: "y", start: [x, 64, z], length: height, blockId });
    prompt = `Build a ${height}-block-tall ${blockId} tower at x=${x}, z=${z}, starting at y=64.`;
    metadata = {
      height,
      canonicalIntent: canonicalIntent(family, {
        blockId,
        base: { x, y: 64, z },
        height,
      }),
    };
  } else if (family === "wall") {
    const startX = args.rng.randint(-5, -1);
    const length = args.rng.randint(5, 8);
    const z = args.rng.randint(-3, 3);
    const height = 3;
    targetBlocks = [];
    for (let x = startX; x < startX + length; x += 1) {
      for (let y = 64; y < 64 + height; y += 1) {
        targetBlocks.push({ x, y, z, blockId });
      }
    }
    prompt = `Build a straight ${blockId} wall from x=${startX} to x=${startX + length - 1} at z=${z}. The wall should run from y=64 through y=${64 + height - 1}.`;
    metadata = {
      length,
      height,
      canonicalIntent: canonicalIntent(family, {
        blockId,
        startX,
        endX: startX + length - 1,
        z,
        height,
      }),
    };
  } else {
    const width = args.rng.randint(3, 5);
    const depth = args.rng.randint(3, 5);
    const ox = args.rng.randint(-4, 0);
    const oz = args.rng.randint(-4, 0);
    targetBlocks = filledRect({ origin: [ox, 64, oz], width, depth, blockId });
    prompt = `Build a flat ${blockId} floor covering x=${ox}..${ox + width - 1} and z=${oz}..${oz + depth - 1} at y=64.`;
    metadata = {
      width,
      depth,
      canonicalIntent: canonicalIntent(family, {
        blockId,
        origin: { x: ox, y: 64, z: oz },
        width,
        depth,
      }),
    };
  }

  return {
    taskId: buildTaskId("t3_primitives", args.seed, family, args.index),
    tier: "t3_primitives",
    family,
    seed: normalizeSeed(args.seed),
    prompt,
    player: defaultPlayerSpec(),
    setupBlocks: [],
    targetBlocks,
    preservedBlocks: [],
    expectedPrimitiveCount: expectedPrimitiveCount("t3_primitives", family),
    structuralChecks: defaultStructuralChecks({ requireConnected: true, requireGrounded: true }),
    metadata,
  };
}

function buildT4StructureRelative(args: { seed: bigint; index: number; rng: PythonRandom }): BuildTaskSpec {
  const family = args.rng.choice([
    "top_of_tower",
    "south_face_marker",
    "inside_room_through_doorway",
    "shorter_tower_marker",
    "marker_chain_place",
    "structure_chain_place",
    "mark_structure_inside_enclosure",
  ] as const);

  let setupBlocks: BlockPlacement[] = [];
  let targetBlocks: BlockPlacement[] = [];
  let structuralChecks: StructuralChecks;
  let metadata: Record<string, unknown>;
  let prompt: string;

  if (family === "top_of_tower") {
    const baseX = args.rng.randint(-4, 4);
    const baseZ = args.rng.randint(-4, 4);
    const height = 4;
    setupBlocks = tower({ base: [baseX, 64, baseZ], height, blockId: "minecraft:stone" });
    targetBlocks = [{ x: baseX, y: 64 + height, z: baseZ, blockId: "minecraft:lantern" }];
    prompt = `There is a stone tower with base at (${baseX}, 64, ${baseZ}). Place one minecraft:lantern on top of the tower.`;
    structuralChecks = defaultStructuralChecks({ requireGrounded: true });
    metadata = {
      requiresStructureInspection: true,
      canonicalIntent: canonicalIntent(family, {
        towerBase: { x: baseX, y: 64, z: baseZ },
        towerHeight: height,
        targetBlock: "minecraft:lantern",
      }),
    };
  } else if (family === "south_face_marker") {
    const roomOrigin = [args.rng.randint(-6, 2), 64, args.rng.randint(-6, 2)] as const;
    setupBlocks = roomShell({ origin: roomOrigin, width: 5, height: 3, depth: 5, wallBlock: "minecraft:oak_planks" });
    targetBlocks = [{
      x: roomOrigin[0] + 2,
      y: 65,
      z: roomOrigin[2] + 4,
      blockId: "minecraft:torch",
    }];
    prompt = "There is an oak plank room centered near you. Replace the center block of the south wall (the wall with max z) with one minecraft:torch.";
    structuralChecks = defaultStructuralChecks({ requireGrounded: true });
    metadata = {
      requiresStructureInspection: true,
      canonicalIntent: canonicalIntent(family, {
        roomOrigin: { x: roomOrigin[0], y: roomOrigin[1], z: roomOrigin[2] },
        targetWall: "south",
        targetBlock: "minecraft:torch",
      }),
    };
  } else if (family === "inside_room_through_doorway") {
    const roomOrigin = [args.rng.randint(-6, 1), 64, args.rng.randint(-6, 1)] as const;
    const doorwayWall = args.rng.choice(["north", "south", "east", "west"] as const);
    const doorwayCoords = {
      north: new Set([`${roomOrigin[0] + 2},64,${roomOrigin[2]}`, `${roomOrigin[0] + 2},65,${roomOrigin[2]}`]),
      south: new Set([`${roomOrigin[0] + 2},64,${roomOrigin[2] + 4}`, `${roomOrigin[0] + 2},65,${roomOrigin[2] + 4}`]),
      west: new Set([`${roomOrigin[0]},64,${roomOrigin[2] + 2}`, `${roomOrigin[0]},65,${roomOrigin[2] + 2}`]),
      east: new Set([`${roomOrigin[0] + 4},64,${roomOrigin[2] + 2}`, `${roomOrigin[0] + 4},65,${roomOrigin[2] + 2}`]),
    };
    const insideTargets = {
      north: [roomOrigin[0] + 2, 64, roomOrigin[2] + 1],
      south: [roomOrigin[0] + 2, 64, roomOrigin[2] + 3],
      west: [roomOrigin[0] + 1, 64, roomOrigin[2] + 2],
      east: [roomOrigin[0] + 3, 64, roomOrigin[2] + 2],
    } as const;
    setupBlocks = removeCoords(
      roomShell({ origin: roomOrigin, width: 5, height: 3, depth: 5, wallBlock: "minecraft:oak_planks" }),
      doorwayCoords[doorwayWall],
    );
    const target = insideTargets[doorwayWall];
    targetBlocks = [{ x: target[0], y: target[1], z: target[2], blockId: "minecraft:lantern" }];
    prompt = "There is an oak plank room with exactly one doorway. Place one minecraft:lantern on the floor tile immediately inside the doorway.";
    structuralChecks = defaultStructuralChecks({ requireGrounded: true });
    metadata = {
      requiresStructureInspection: true,
      canonicalIntent: canonicalIntent(family, {
        roomOrigin: { x: roomOrigin[0], y: roomOrigin[1], z: roomOrigin[2] },
        doorwayWall,
        targetBlock: "minecraft:lantern",
      }),
    };
  } else if (family === "shorter_tower_marker") {
    const leftBase = [args.rng.randint(-8, -4), 64, args.rng.randint(-3, 3)] as const;
    const rightBase = [args.rng.randint(4, 8), 64, leftBase[2] + args.rng.randint(-1, 1)] as const;
    const shortHeight = args.rng.randint(3, 4);
    const tallHeight = shortHeight + args.rng.randint(1, 2);
    const shorterSide = args.rng.choice(["left", "right"] as const);
    const leftHeight = shorterSide === "left" ? shortHeight : tallHeight;
    const rightHeight = shorterSide === "right" ? shortHeight : tallHeight;
    setupBlocks = [
      ...tower({ base: leftBase, height: leftHeight, blockId: "minecraft:stone" }),
      ...tower({ base: rightBase, height: rightHeight, blockId: "minecraft:stone" }),
    ];
    const shorterBase = shorterSide === "left" ? leftBase : rightBase;
    targetBlocks = [{ x: shorterBase[0], y: 64 + shortHeight, z: shorterBase[2], blockId: "minecraft:torch" }];
    prompt = "Two stone towers are already built nearby, and one is shorter than the other. Each tower is a single vertical stone column, and both tower bases are within 10 blocks of you on the same flat ground level. Do not build or modify either tower. Inspect them, identify the shorter existing tower, and place exactly one minecraft:torch in the air block directly above that tower's highest stone block. Do not place a torch anywhere else.";
    structuralChecks = defaultStructuralChecks({ requireGrounded: true });
    metadata = {
      requiresStructureInspection: true,
      canonicalIntent: canonicalIntent(family, {
        leftBase: { x: leftBase[0], y: leftBase[1], z: leftBase[2] },
        rightBase: { x: rightBase[0], y: rightBase[1], z: rightBase[2] },
        leftHeight,
        rightHeight,
        targetBlock: "minecraft:torch",
      }),
    };
  } else if (family === "marker_chain_place") {
    const hopCount = args.rng.randint(2, 6);
    const { positions, steps } = chainPositions({
      rng: args.rng,
      start: [args.rng.randint(-8, -2), 64, args.rng.randint(-8, -2)],
      hopCount,
      stepDistance: 3,
    });
    const markers = markerBlocks.slice(0, hopCount + 1);
    setupBlocks = positions.map((coord, index) => ({
      x: coord[0],
      y: coord[1],
      z: coord[2],
      blockId: markers[index]!,
    }));
    const finalCoord = positions.at(-1)!;
    targetBlocks = [{ x: finalCoord[0], y: finalCoord[1] + 1, z: finalCoord[2], blockId: "minecraft:gold_block" }];
    prompt = `Colored wool markers are placed nearby. Start at the ${markerName(markers[0]!)}, ${steps.map((step) => `move to the marker 3 blocks ${step} of that marker`).join(", then ")}, and then place one minecraft:gold_block one block above the final marker.`;
    structuralChecks = defaultStructuralChecks({ requireGrounded: true });
    metadata = {
      requiresStructureInspection: true,
      hopCount,
      canonicalIntent: canonicalIntent(family, {
        stepDistance: 3,
        startMarker: markers[0],
        steps,
        markers: positions.map((coord, index) => ({
          name: markerName(markers[index]!),
          blockId: markers[index],
          x: coord[0],
          y: coord[1],
          z: coord[2],
        })),
        targetBlock: "minecraft:gold_block",
      }),
    };
  } else if (family === "structure_chain_place") {
    const hopCount = args.rng.randint(2, 6);
    const { positions, steps } = chainPositions({
      rng: args.rng,
      start: [args.rng.randint(-10, -4), 64, args.rng.randint(-10, -4)],
      hopCount,
      stepDistance: 5,
    });
    const structureBlocks = buildBlocks.slice(0, hopCount + 1);
    const heights = Array.from({ length: hopCount + 1 }, (_, index) => 3 + (index % 2));
    setupBlocks = dedupeBlocks(positions.flatMap((coord, index) =>
      tower({ base: coord, height: heights[index]!, blockId: structureBlocks[index]! }),
    ));
    const finalCoord = positions.at(-1)!;
    const finalHeight = heights.at(-1)!;
    targetBlocks = [{ x: finalCoord[0], y: finalCoord[1] + finalHeight, z: finalCoord[2], blockId: "minecraft:torch" }];
    prompt = `Several material-coded towers are nearby. Start at the ${blockName(structureBlocks[0]!)} tower, ${steps.map((step) => `move to the tower 5 blocks ${step} of that tower`).join(", then ")}, and then place one minecraft:torch on top of the final tower.`;
    structuralChecks = defaultStructuralChecks({ requireGrounded: true });
    metadata = {
      requiresStructureInspection: true,
      hopCount,
      canonicalIntent: canonicalIntent(family, {
        stepDistance: 5,
        startStructure: structureBlocks[0],
        steps,
        structures: positions.map((coord, index) => ({
          name: `${blockName(structureBlocks[index]!)} tower`,
          blockId: structureBlocks[index],
          height: heights[index],
          x: coord[0],
          y: coord[1],
          z: coord[2],
        })),
        targetBlock: "minecraft:torch",
      }),
    };
  } else {
    const enclosureOrigin = [args.rng.randint(-7, -2), 64, args.rng.randint(-7, -2)] as const;
    const insideBase = [enclosureOrigin[0] + 3, 64, enclosureOrigin[2] + 3] as const;
    const outsideA = [enclosureOrigin[0] - 4, 64, enclosureOrigin[2] + 1] as const;
    const outsideB = [enclosureOrigin[0] + 9, 64, enclosureOrigin[2] + 5] as const;
    setupBlocks = [
      ...enclosureShell({ origin: enclosureOrigin, width: 7, depth: 7, height: 2, wallBlock: "minecraft:stone_bricks" }),
      ...tower({ base: insideBase, height: 3, blockId: "minecraft:stone" }),
      ...tower({ base: outsideA, height: 3, blockId: "minecraft:stone" }),
      ...tower({ base: outsideB, height: 3, blockId: "minecraft:stone" }),
    ];
    targetBlocks = [{ x: insideBase[0], y: 67, z: insideBase[2], blockId: "minecraft:lantern" }];
    prompt = "Three nearby stone towers are visible and one of them is inside a stone_bricks enclosure. Place one minecraft:lantern on top of the tower that is inside the enclosure.";
    structuralChecks = defaultStructuralChecks({ requireGrounded: true });
    metadata = {
      requiresStructureInspection: true,
      canonicalIntent: canonicalIntent(family, {
        enclosureOrigin: { x: enclosureOrigin[0], y: enclosureOrigin[1], z: enclosureOrigin[2] },
        insideTower: { x: insideBase[0], y: insideBase[1], z: insideBase[2] },
        enclosureBlockId: "minecraft:stone_bricks",
        targetBlock: "minecraft:lantern",
      }),
    };
  }

  const withDistractor = addOptionalDistractor({
    rng: args.rng,
    tier: "t4_structure_relative",
    prompt,
    setup: setupBlocks,
    target: targetBlocks,
    preserved: [],
    metadata,
  });

  return {
    taskId: buildTaskId("t4_structure_relative", args.seed, family, args.index),
    tier: "t4_structure_relative",
    family,
    seed: normalizeSeed(args.seed),
    prompt: withDistractor.prompt,
    player: defaultPlayerSpec(),
    setupBlocks: withDistractor.setup,
    targetBlocks,
    preservedBlocks: [],
    expectedPrimitiveCount: expectedPrimitiveCount("t4_structure_relative", family),
    structuralChecks,
    metadata: withDistractor.metadata,
  };
}

function buildT5Modification(args: { seed: bigint; index: number; rng: PythonRandom }): BuildTaskSpec {
  const family = args.rng.choice([
    "replace_material_preserve_shape",
    "widen_or_reposition_opening",
    "add_window_to_wall",
    "move_window_to_opposite_wall",
    "add_shared_wall_doorway",
  ] as const);

  let setupBlocks: BlockPlacement[] = [];
  let targetBlocks: BlockPlacement[] = [];
  let preservedBlocks: BlockPlacement[] = [];
  let structuralChecks: StructuralChecks;
  let metadata: Record<string, unknown>;
  let prompt: string;

  if (family === "replace_material_preserve_shape") {
    const origin = [args.rng.randint(-5, 1), 64, args.rng.randint(-5, 1)] as const;
    const walls = roomShell({ origin, width: 5, height: 3, depth: 5, wallBlock: "minecraft:oak_planks" });
    const floor = filledRect({ origin: [origin[0], 63, origin[2]], width: 5, depth: 5, blockId: "minecraft:stone" });
    setupBlocks = [...walls, ...floor];
    targetBlocks = walls.map((block) => ({ ...block, blockId: "minecraft:birch_planks" }));
    preservedBlocks = [
      ...floor,
      ...Array.from({ length: 3 }, (_, xi) => xi + origin[0] + 1).flatMap((x) =>
        Array.from({ length: 3 }, (_, yi) => yi + 64).flatMap((y) =>
          Array.from({ length: 3 }, (_, zi) => zi + origin[2] + 1).map((z) => ({ x, y, z, blockId: "minecraft:air" })),
        ),
      ),
    ];
    prompt = "Replace every minecraft:oak_planks wall block in the room with minecraft:birch_planks, preserving the same wall coordinates and keeping the interior hollow.";
    structuralChecks = defaultStructuralChecks({ requireConnected: true, requireGrounded: true });
    metadata = {
      requiresModification: true,
      canonicalIntent: canonicalIntent(family, {
        roomOrigin: { x: origin[0], y: origin[1], z: origin[2] },
        fromBlock: "minecraft:oak_planks",
        toBlock: "minecraft:birch_planks",
      }),
    };
  } else if (family === "widen_or_reposition_opening") {
    const wallZ = args.rng.randint(-4, 4);
    const centerX = args.rng.randint(-1, 1);
    const existingDoorway = new Set([`${centerX},64,${wallZ}`, `${centerX},65,${wallZ}`]);
    setupBlocks = [];
    for (let x = centerX - 3; x <= centerX + 3; x += 1) {
      for (let y = 64; y <= 66; y += 1) {
        if (!existingDoorway.has(`${x},${y},${wallZ}`)) {
          setupBlocks.push({ x, y, z: wallZ, blockId: "minecraft:stone_bricks" });
        }
      }
    }
    targetBlocks = [centerX - 1, centerX + 1].flatMap((x) => [64, 65].map((y) => ({ x, y, z: wallZ, blockId: "minecraft:air" })));
    preservedBlocks = [];
    for (let x = centerX - 3; x <= centerX + 3; x += 1) {
      for (let y = 64; y <= 66; y += 1) {
        if (!(x >= centerX - 1 && x <= centerX + 1 && y >= 64 && y <= 65)) {
          preservedBlocks.push({ x, y, z: wallZ, blockId: "minecraft:stone_bricks" });
        }
      }
    }
    prompt = "A stone_bricks wall has a 1-block-wide doorway near the center. Widen the doorway to 3 blocks wide while preserving all other wall blocks.";
    structuralChecks = defaultStructuralChecks();
    metadata = {
      requiresModification: true,
      canonicalIntent: canonicalIntent(family, {
        wallZ,
        centerX,
      }),
    };
  } else if (family === "add_window_to_wall") {
    const origin = [args.rng.randint(-5, 1), 64, args.rng.randint(-5, 1)] as const;
    const shell = roomShell({ origin, width: 5, height: 3, depth: 5, wallBlock: "minecraft:stone_bricks" });
    const floor = filledRect({ origin: [origin[0], 63, origin[2]], width: 5, depth: 5, blockId: "minecraft:cobblestone" });
    targetBlocks = [64, 65].flatMap((y) => [origin[2] + 1, origin[2] + 2].map((z) => ({ x: origin[0] + 4, y, z, blockId: "minecraft:air" })));
    preservedBlocks = [...floor, ...removeCoords(shell, new Set(targetBlocks.map((block) => `${block.x},${block.y},${block.z}`)))];
    setupBlocks = [...shell, ...floor];
    prompt = "Add a 2-by-2 window to the east wall of the stone_bricks room and keep the rest unchanged.";
    structuralChecks = defaultStructuralChecks();
    metadata = {
      requiresModification: true,
      canonicalIntent: canonicalIntent(family, {
        roomOrigin: { x: origin[0], y: origin[1], z: origin[2] },
        targetWall: "east",
      }),
    };
  } else if (family === "move_window_to_opposite_wall") {
    const origin = [args.rng.randint(-5, 1), 64, args.rng.randint(-5, 1)] as const;
    const westWindow = new Set([
      `${origin[0]},64,${origin[2] + 1}`,
      `${origin[0]},64,${origin[2] + 2}`,
      `${origin[0]},65,${origin[2] + 1}`,
      `${origin[0]},65,${origin[2] + 2}`,
    ]);
    const eastWindowCoords = [
      [origin[0] + 4, 64, origin[2] + 1],
      [origin[0] + 4, 64, origin[2] + 2],
      [origin[0] + 4, 65, origin[2] + 1],
      [origin[0] + 4, 65, origin[2] + 2],
    ] as const;
    const shell = removeCoords(roomShell({ origin, width: 5, height: 3, depth: 5, wallBlock: "minecraft:stone_bricks" }), westWindow);
    const floor = filledRect({ origin: [origin[0], 63, origin[2]], width: 5, depth: 5, blockId: "minecraft:cobblestone" });
    targetBlocks = [
      ...[...westWindow].map((entry) => {
        const [x, y, z] = entry.split(",").map(Number) as [number, number, number];
        return { x, y, z, blockId: "minecraft:stone_bricks" };
      }),
      ...eastWindowCoords.map(([x, y, z]) => ({ x, y, z, blockId: "minecraft:air" })),
    ];
    preservedBlocks = [...floor, ...removeCoords(shell, new Set(eastWindowCoords.map((coord) => coord.join(","))))];
    setupBlocks = [...shell, ...floor];
    prompt = "Move the existing 2-by-2 window from the west wall to the east wall of the room. Seal the old opening with stone_bricks.";
    structuralChecks = defaultStructuralChecks({ requireGrounded: true });
    metadata = {
      requiresModification: true,
      canonicalIntent: canonicalIntent(family, {
        roomOrigin: { x: origin[0], y: origin[1], z: origin[2] },
        fromWall: "west",
        toWall: "east",
      }),
    };
  } else {
    const firstOrigin = [args.rng.randint(-8, -4), 64, args.rng.randint(-4, 0)] as const;
    const secondOrigin = [firstOrigin[0] + 4, 64, firstOrigin[2]] as const;
    const roomA = roomShell({ origin: firstOrigin, width: 5, height: 3, depth: 5, wallBlock: "minecraft:stone_bricks" });
    const roomB = roomShell({ origin: secondOrigin, width: 5, height: 3, depth: 5, wallBlock: "minecraft:stone_bricks" });
    setupBlocks = dedupeBlocks([...roomA, ...roomB]);
    const doorwayCoords = [
      [firstOrigin[0] + 4, 64, firstOrigin[2] + 2],
      [firstOrigin[0] + 4, 65, firstOrigin[2] + 2],
    ] as const;
    targetBlocks = doorwayCoords.map(([x, y, z]) => ({ x, y, z, blockId: "minecraft:air" }));
    preservedBlocks = removeCoords(setupBlocks, new Set(doorwayCoords.map((coord) => coord.join(","))));
    prompt = "Two adjacent stone_bricks rooms share a wall. Cut a 1-block-wide doorway through the shared wall at the center where they touch.";
    structuralChecks = defaultStructuralChecks();
    metadata = {
      requiresModification: true,
      canonicalIntent: canonicalIntent(family, {
        firstRoomOrigin: { x: firstOrigin[0], y: firstOrigin[1], z: firstOrigin[2] },
        secondRoomOrigin: { x: secondOrigin[0], y: secondOrigin[1], z: secondOrigin[2] },
        roomWidth: 5,
        roomDepth: 5,
        roomHeight: 3,
      }),
    };
  }

  const withDistractor = addOptionalDistractor({
    rng: args.rng,
    tier: "t5_modification",
    prompt,
    setup: setupBlocks,
    target: targetBlocks,
    preserved: preservedBlocks,
    metadata,
  });

  return {
    taskId: buildTaskId("t5_modification", args.seed, family, args.index),
    tier: "t5_modification",
    family,
    seed: normalizeSeed(args.seed),
    prompt: withDistractor.prompt,
    player: defaultPlayerSpec(),
    setupBlocks: withDistractor.setup,
    targetBlocks,
    preservedBlocks,
    expectedPrimitiveCount: expectedPrimitiveCount("t5_modification", family),
    structuralChecks,
    metadata: withDistractor.metadata,
  };
}

function corridorSegmentX(options: {
  xStart: number;
  xEnd: number;
  z: number;
  y: number;
  blockId: string;
}): BlockPlacement[] {
  const blocks: BlockPlacement[] = [];
  for (let x = Math.min(options.xStart, options.xEnd); x <= Math.max(options.xStart, options.xEnd); x += 1) {
    blocks.push({ x, y: options.y - 1, z: options.z, blockId: options.blockId });
    blocks.push({ x, y: options.y + 2, z: options.z, blockId: options.blockId });
    blocks.push({ x, y: options.y + 2, z: options.z - 1, blockId: options.blockId });
    blocks.push({ x, y: options.y + 2, z: options.z + 1, blockId: options.blockId });
    blocks.push({ x, y: options.y, z: options.z - 1, blockId: options.blockId });
    blocks.push({ x, y: options.y + 1, z: options.z - 1, blockId: options.blockId });
    blocks.push({ x, y: options.y, z: options.z + 1, blockId: options.blockId });
    blocks.push({ x, y: options.y + 1, z: options.z + 1, blockId: options.blockId });
  }
  return blocks;
}

function corridorSegmentZ(options: {
  x: number;
  zStart: number;
  zEnd: number;
  y: number;
  blockId: string;
}): BlockPlacement[] {
  const blocks: BlockPlacement[] = [];
  for (let z = Math.min(options.zStart, options.zEnd); z <= Math.max(options.zStart, options.zEnd); z += 1) {
    blocks.push({ x: options.x, y: options.y - 1, z, blockId: options.blockId });
    blocks.push({ x: options.x, y: options.y + 2, z, blockId: options.blockId });
    blocks.push({ x: options.x - 1, y: options.y + 2, z, blockId: options.blockId });
    blocks.push({ x: options.x + 1, y: options.y + 2, z, blockId: options.blockId });
    blocks.push({ x: options.x - 1, y: options.y, z, blockId: options.blockId });
    blocks.push({ x: options.x - 1, y: options.y + 1, z, blockId: options.blockId });
    blocks.push({ x: options.x + 1, y: options.y, z, blockId: options.blockId });
    blocks.push({ x: options.x + 1, y: options.y + 1, z, blockId: options.blockId });
  }
  return blocks;
}

function buildT6Composition(args: { seed: bigint; index: number; rng: PythonRandom }): BuildTaskSpec {
  const family = args.rng.choice([
    "bridge_between_structures",
    "connect_rooms_with_corridor",
    "bridge_between_offset_towers",
    "l_shaped_corridor_offset_rooms",
  ] as const);

  let setupBlocks: BlockPlacement[] = [];
  let targetBlocks: BlockPlacement[] = [];
  let preservedBlocks: BlockPlacement[] = [];
  let prompt: string;
  let structuralChecks: StructuralChecks;
  let metadata: Record<string, unknown>;

  if (family === "bridge_between_structures") {
    const leftBase = [args.rng.randint(-8, -5), 64, args.rng.randint(-2, 2)] as const;
    const rightBase = [leftBase[0] + args.rng.randint(6, 8), 64, leftBase[2]] as const;
    const leftTower = tower({ base: leftBase, height: 4, blockId: "minecraft:stone" });
    const rightTower = tower({ base: rightBase, height: 4, blockId: "minecraft:stone" });
    setupBlocks = [...leftTower, ...rightTower];
    targetBlocks = Array.from({ length: rightBase[0] - leftBase[0] + 1 }, (_, offset) => ({
      x: leftBase[0] + offset,
      y: 68,
      z: leftBase[2],
      blockId: "minecraft:cobblestone",
    }));
    preservedBlocks = [...leftTower, ...rightTower];
    prompt = "Build a minecraft:cobblestone bridge connecting the tops of the two towers.";
    structuralChecks = defaultStructuralChecks({
      requireConnected: true,
      minSpan: rightBase[0] - leftBase[0] + 1,
      spanAxis: "x",
    });
    metadata = {
      compositional: true,
      canonicalIntent: canonicalIntent(family, {
        leftBase: { x: leftBase[0], y: leftBase[1], z: leftBase[2] },
        rightBase: { x: rightBase[0], y: rightBase[1], z: rightBase[2] },
        blockId: "minecraft:cobblestone",
      }),
    };
  } else if (family === "connect_rooms_with_corridor") {
    const originX = args.rng.randint(-4, 0);
    const topRoomOrigin = [originX, 64, args.rng.randint(-10, -7)] as const;
    const bottomRoomOrigin = [originX, 64, topRoomOrigin[2] + args.rng.randint(11, 13)] as const;
    const topDoorway = new Set([`${topRoomOrigin[0] + 2},64,${topRoomOrigin[2] + 4}`, `${topRoomOrigin[0] + 2},65,${topRoomOrigin[2] + 4}`]);
    const bottomDoorway = new Set([`${bottomRoomOrigin[0] + 2},64,${bottomRoomOrigin[2]}`, `${bottomRoomOrigin[0] + 2},65,${bottomRoomOrigin[2]}`]);
    const roomA = removeCoords(roomShell({ origin: topRoomOrigin, width: 5, height: 3, depth: 5, wallBlock: "minecraft:stone_bricks" }), topDoorway);
    const roomB = removeCoords(roomShell({ origin: bottomRoomOrigin, width: 5, height: 3, depth: 5, wallBlock: "minecraft:stone_bricks" }), bottomDoorway);
    setupBlocks = [...roomA, ...roomB];
    targetBlocks = corridorSegmentZ({
      x: topRoomOrigin[0] + 2,
      zStart: topRoomOrigin[2] + 5,
      zEnd: bottomRoomOrigin[2] - 1,
      y: 64,
      blockId: "minecraft:stone_bricks",
    });
    preservedBlocks = [...roomA, ...roomB];
    prompt = "Connect the two rooms with a one-block-wide hollow stone_bricks corridor shell between the facing doorways. Build the corridor floor, side walls, and roof, and leave the interior passage empty.";
    structuralChecks = defaultStructuralChecks();
    metadata = {
      compositional: true,
      canonicalIntent: canonicalIntent(family, {
        topRoomOrigin: { x: topRoomOrigin[0], y: topRoomOrigin[1], z: topRoomOrigin[2] },
        bottomRoomOrigin: { x: bottomRoomOrigin[0], y: bottomRoomOrigin[1], z: bottomRoomOrigin[2] },
        blockId: "minecraft:stone_bricks",
      }),
    };
  } else if (family === "bridge_between_offset_towers") {
    const leftBase = [args.rng.randint(-8, -5), 64, args.rng.randint(-5, -2)] as const;
    const rightBase = [args.rng.randint(4, 8), 64, args.rng.randint(2, 5)] as const;
    const leftTower = tower({ base: leftBase, height: 4, blockId: "minecraft:stone" });
    const rightTower = tower({ base: rightBase, height: 4, blockId: "minecraft:stone" });
    setupBlocks = [...leftTower, ...rightTower];
    const xPath = Array.from({ length: rightBase[0] - leftBase[0] + 1 }, (_, offset) => ({
      x: leftBase[0] + offset,
      y: 68,
      z: leftBase[2],
      blockId: "minecraft:cobblestone",
    }));
    const zPath = Array.from({ length: Math.abs(rightBase[2] - leftBase[2]) + 1 }, (_, offset) => ({
      x: rightBase[0],
      y: 68,
      z: Math.min(leftBase[2], rightBase[2]) + offset,
      blockId: "minecraft:cobblestone",
    }));
    targetBlocks = dedupeBlocks([...xPath, ...zPath]);
    preservedBlocks = [...leftTower, ...rightTower];
    prompt = "Two stone towers are already built nearby. Do not build new towers or change the existing towers. Build only the missing one-block-wide L-shaped minecraft:cobblestone bridge in the air one block above the tower tops. Start directly above the west tower top, run straight east until you are aligned with the east tower, then turn once and continue along z until the bridge ends directly above the east tower top. Do not place any cobblestone on or inside the towers themselves.";
    structuralChecks = defaultStructuralChecks({ requireConnected: true });
    metadata = {
      compositional: true,
      canonicalIntent: canonicalIntent(family, {
        leftBase: { x: leftBase[0], y: leftBase[1], z: leftBase[2] },
        rightBase: { x: rightBase[0], y: rightBase[1], z: rightBase[2] },
        blockId: "minecraft:cobblestone",
      }),
    };
  } else {
    const roomAOrigin = [args.rng.randint(-10, -7), 64, args.rng.randint(-9, -6)] as const;
    const roomBOrigin = [roomAOrigin[0] + args.rng.randint(8, 10), 64, roomAOrigin[2] + args.rng.randint(8, 10)] as const;
    const roomADoorway = new Set([`${roomAOrigin[0] + 4},64,${roomAOrigin[2] + 2}`, `${roomAOrigin[0] + 4},65,${roomAOrigin[2] + 2}`]);
    const roomBDoorway = new Set([`${roomBOrigin[0] + 2},64,${roomBOrigin[2]}`, `${roomBOrigin[0] + 2},65,${roomBOrigin[2]}`]);
    const roomA = removeCoords(roomShell({ origin: roomAOrigin, width: 5, height: 3, depth: 5, wallBlock: "minecraft:stone_bricks" }), roomADoorway);
    const roomB = removeCoords(roomShell({ origin: roomBOrigin, width: 5, height: 3, depth: 5, wallBlock: "minecraft:stone_bricks" }), roomBDoorway);
    setupBlocks = [...roomA, ...roomB];
    const turnX = roomBOrigin[0] + 2;
    targetBlocks = dedupeBlocks([
      ...corridorSegmentX({
        xStart: roomAOrigin[0] + 5,
        xEnd: turnX,
        z: roomAOrigin[2] + 2,
        y: 64,
        blockId: "minecraft:stone_bricks",
      }),
      ...corridorSegmentZ({
        x: turnX,
        zStart: roomAOrigin[2] + 2,
        zEnd: roomBOrigin[2] - 1,
        y: 64,
        blockId: "minecraft:stone_bricks",
      }),
    ]);
    preservedBlocks = [...roomA, ...roomB];
    prompt = "Two stone_bricks rooms with existing doorways are already built nearby. Do not rebuild or modify the rooms. Build only the missing one-block-wide L-shaped stone_bricks corridor shell between the two doorways, including the corridor floor, side walls, and roof. Leave the interior passage empty.";
    structuralChecks = defaultStructuralChecks();
    metadata = {
      compositional: true,
      canonicalIntent: canonicalIntent(family, {
        firstRoomOrigin: { x: roomAOrigin[0], y: roomAOrigin[1], z: roomAOrigin[2] },
        secondRoomOrigin: { x: roomBOrigin[0], y: roomBOrigin[1], z: roomBOrigin[2] },
        blockId: "minecraft:stone_bricks",
      }),
    };
  }

  const withDistractor = addOptionalDistractor({
    rng: args.rng,
    tier: "t6_composition",
    prompt,
    setup: setupBlocks,
    target: targetBlocks,
    preserved: preservedBlocks,
    metadata,
  });

  return {
    taskId: buildTaskId("t6_composition", args.seed, family, args.index),
    tier: "t6_composition",
    family,
    seed: normalizeSeed(args.seed),
    prompt: withDistractor.prompt,
    player: defaultPlayerSpec(),
    setupBlocks: withDistractor.setup,
    targetBlocks,
    preservedBlocks,
    expectedPrimitiveCount: expectedPrimitiveCount("t6_composition", family),
    structuralChecks,
    metadata: withDistractor.metadata,
  };
}

const taskBuilders: Record<BuildTier, Builder> = {
  t1_absolute: buildT1Absolute,
  t2_relative_single_ref: buildT2Relative,
  t3_primitives: buildT3Primitives,
  t4_structure_relative: buildT4StructureRelative,
  t5_modification: buildT5Modification,
  t6_composition: buildT6Composition,
};

class ForcedFamilyRandom extends PythonRandom {
  #family: string;
  #forced = false;

  constructor(seed: bigint, family: string) {
    super(seed);
    this.#family = family;
  }

  override choice<T>(sequence: readonly T[]): T {
    const choice = super.choice(sequence);
    if (!this.#forced && sequence.includes(this.#family as T)) {
      this.#forced = true;
      return this.#family as T;
    }
    return choice;
  }
}
