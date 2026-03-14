/** Single-turn text-QA task generation and grading. */

import { createHash } from "node:crypto";
import {
  defaultPlayerSpec,
  normalizeSeed,
  textQaTiers,
  textQaGradeSchema,
  type TextQAGradeResult,
  type TextQATaskSpec,
  type TextQaTier,
} from "../types.js";
import {
  chainPositions,
  enclosureShell,
  horizontalFacingOffset,
  markerBlocks,
  markerName,
  playerRelativeDirection,
  roomShell,
  tower,
} from "../tasks/spatial-worlds.js";
import { PythonRandom } from "../tasks/python-random.js";

const noiseSentences = [
  "There is also an unrelated marker farther away; ignore it.",
  "One extra structure is present but does not affect the answer.",
] as const;

type Builder = (args: { seed: bigint; index: number; rng: PythonRandom }) => TextQATaskSpec;

/** Generate deterministic text-QA tasks. */
export function generateTextQaTasks(options: {
  seed: number;
  perTier: number;
  tiers?: readonly TextQaTier[];
}): TextQATaskSpec[] {
  if (options.perTier <= 0) {
    throw new Error("perTier must be > 0");
  }

  const selected = [...(options.tiers ?? textQaTiers)];
  const tasks: TextQATaskSpec[] = [];

  for (const tier of selected) {
    for (let index = 0; index < options.perTier; index += 1) {
      tasks.push(generateTextQaTask({ tier, seed: options.seed, index }));
    }
  }

  return tasks;
}

/** Generate one deterministic text-QA task. */
export function generateTextQaTask(options: { tier: TextQaTier; seed: number | bigint; index?: number }): TextQATaskSpec {
  const index = options.index ?? 0;
  const derivedSeed = deriveSeed({
    seed: typeof options.seed === "bigint" ? options.seed : BigInt(options.seed),
    tier: options.tier,
    index,
  });
  return textQaBuilders[options.tier]({ seed: derivedSeed, index, rng: new PythonRandom(derivedSeed) });
}

/** Rebuild a text-QA task from its canonical id. */
export function reconstructTextQaTaskFromTaskId(taskId: string): TextQATaskSpec {
  const [tier, family, seedText, indexText] = taskId.split(":", 4);
  const builder = textQaBuilders[tier as TextQaTier];
  if (!builder) {
    throw new Error(`Unknown text QA tier in task id: ${taskId}`);
  }
  if (!family || !seedText || !indexText) {
    throw new Error(`Invalid text QA task id: ${taskId}`);
  }

  return builder({
    seed: BigInt(seedText),
    index: Number.parseInt(indexText, 10),
    rng: new ForcedFamilyRandom(BigInt(seedText), family),
  });
}

/** Normalize model answers using the same loose matching rules as the Python pipeline. */
export function normalizeTextQaAnswer(answer: string, answerFormat: TextQATaskSpec["answerFormat"]): string {
  let stripped = answer.trim().toLowerCase().replaceAll("**", "");
  if (stripped.includes("answer:")) {
    stripped = stripped.split("answer:").at(-1)!.trim();
  }
  if (stripped.includes("\n")) {
    stripped = stripped
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1)!;
  }

  if (answerFormat === "single_token" || answerFormat === "entity_name" || answerFormat === "yes_no") {
    stripped = stripped.replaceAll("_", " ").replace(/^the /, "");
    if (stripped.endsWith(" wool")) {
      stripped = `${stripped.slice(0, -5)} marker`;
    }
    stripped = stripped.replace(/\s+/g, " ").replace(/\.$/, "");
    if (answerFormat === "yes_no") {
      const match = stripped.match(/\b(?:yes|no)\b/g);
      if (match?.length) {
        return match.at(-1)!;
      }
    }
    if (answerFormat === "entity_name") {
      const match = stripped.match(/\b(?:red|blue|green|yellow|purple|orange|cyan|black|white) marker\b/g);
      if (match?.length) {
        return match.at(-1)!;
      }
    }
    return stripped;
  }

  if (answerFormat === "coordinate") {
    const numbers = [...stripped.matchAll(/-?\d+/g)].map((match) => Number.parseInt(match[0], 10));
    if (numbers.length === 3) {
      return `${numbers[0]},${numbers[1]},${numbers[2]}`;
    }
  }

  return stripped;
}

/** Grade one text-QA answer. */
export function gradeTextQaAnswer(task: TextQATaskSpec, answer: string): TextQAGradeResult {
  const normalizedAnswer = normalizeTextQaAnswer(answer, task.answerFormat);
  const normalizedExpectedAnswer = normalizeTextQaAnswer(task.expectedAnswer, task.answerFormat);
  const correct = normalizedAnswer === normalizedExpectedAnswer;

  return textQaGradeSchema.parse({
    taskId: task.taskId,
    tier: task.tier,
    taskMode: "text_qa",
    answer,
    expectedAnswer: task.expectedAnswer,
    normalizedAnswer,
    normalizedExpectedAnswer,
    answerFormat: task.answerFormat,
    correct,
    rewardRaw: correct ? 1 : 0,
    rewardNormalized: correct ? 1 : 0,
    rewardBinary: correct ? 1 : 0,
  });
}

/** Produce the canonical worked-answer response. */
export function canonicalTextQaResponse(task: TextQATaskSpec): string {
  const reasoning = task.canonicalReasoning.map((step, index) => `${index + 1}. ${step}`).join("\n");
  return `${reasoning}\nAnswer: ${task.expectedAnswer}`;
}

/** Expand a compact task into the full world-state prompt. */
export function textQaFullPrompt(task: TextQATaskSpec): string {
  const metadata = task.metadata as Record<string, any>;
  const lines: string[] = [];

  if (task.family === "generated_world_candidate") {
    const sourceTaskId = metadata.sourceTaskId;
    if (typeof sourceTaskId === "string" && sourceTaskId.startsWith("qa_")) {
      const sourceTask = reconstructTextQaTaskFromTaskId(sourceTaskId);
      const sourceLines = textQaFullPrompt(sourceTask).split("\n");
      if (sourceLines.at(-1)?.startsWith("Question:")) {
        sourceLines.pop();
      }
      return [...sourceLines, `Question: ${task.prompt}`].join("\n");
    }
    return task.prompt;
  }

  if (task.family === "furthest_cardinal_marker" || task.family === "resolve_marker_chain") {
    lines.push("World state:");
    for (const entity of metadata.entities) {
      lines.push(`- ${entity.name} is at (${entity.x}, ${entity.y}, ${entity.z}).`);
    }
  } else if (task.family === "relative_to_player_marker") {
    const blockByCoord = new Map(task.setupBlocks.map((block) => [`${block.x},${block.y},${block.z}`, block.blockId]));
    lines.push(`World state: the player is at (${task.player.x}, ${task.player.y}, ${task.player.z}) facing ${task.player.facing}.`);
    for (const [direction, offset] of Object.entries(metadata.worldOffsets as Record<string, { x: number; z: number }>)) {
      const coord = [task.player.x + offset.x, task.player.y, task.player.z + offset.z] as const;
      lines.push(`- ${markerName(blockByCoord.get(coord.join(","))!)} is ${direction} of the player at (${coord[0]}, ${coord[1]}, ${coord[2]}).`);
    }
  } else if (task.family === "inside_enclosure") {
    const origin = metadata.enclosureOrigin;
    lines.push(`World state: a stone_bricks enclosure starts at (${origin.x}, ${origin.y}, ${origin.z}) with width ${metadata.enclosureWidth} and depth ${metadata.enclosureDepth}.`);
    const grouped = new Map<string, Array<[number, number, number]>>();
    for (const block of task.setupBlocks) {
      const existing = grouped.get(block.blockId) ?? [];
      existing.push([block.x, block.y, block.z]);
      grouped.set(block.blockId, existing);
    }
    for (const blockId of metadata.candidateEntityBlockIds) {
      const coords = grouped.get(blockId)!;
      const base = [...coords].sort((left, right) => left[0] - right[0] || left[1] - right[1] || left[2] - right[2])[0]!;
      lines.push(`- ${markerName(blockId)} tower base is at (${base[0]}, ${base[1]}, ${base[2]}).`);
    }
  } else {
    const first = metadata.leftRoomOrigin;
    const second = metadata.rightRoomOrigin;
    lines.push(`World state: room A starts at (${first.x}, ${first.y}, ${first.z}) and room B starts at (${second.x}, ${second.y}, ${second.z}).`);
    lines.push(`Each room has width ${metadata.roomWidth}, depth ${metadata.roomDepth}, and height ${metadata.roomHeight}.`);
  }

  const noise = metadata.noise;
  if (noise?.kind === "tower") {
    const base = noise.base;
    lines.push(`Ignore the unrelated birch_planks tower at (${base.x}, ${base.y}, ${base.z}) with height ${noise.height}.`);
  }

  lines.push(`Question: ${task.prompt}`);
  return lines.join("\n");
}

function deriveSeed(options: { seed: bigint; tier: TextQaTier; index: number }): bigint {
  const digest = createHash("sha256")
    .update(`${options.seed}:${options.tier}:${options.index}`)
    .digest("hex")
    .slice(0, 16);
  return BigInt(`0x${digest}`);
}

function taskId(tier: TextQaTier, seed: bigint, family: string, index: number): string {
  return `${tier}:${family}:${seed}:${index}`;
}

function withNoise(args: {
  rng: PythonRandom;
  prompt: string;
  setupBlocks: TextQATaskSpec["setupBlocks"];
  metadata: Record<string, unknown>;
}): {
  prompt: string;
  setupBlocks: TextQATaskSpec["setupBlocks"];
  metadata: Record<string, unknown>;
} {
  if (args.rng.random() >= 0.6) {
    return args;
  }

  const noiseBase = [18, 64, 18] as const;
  return {
    prompt: `${args.prompt} ${args.rng.choice(noiseSentences)}`,
    setupBlocks: [...args.setupBlocks, ...tower({ base: noiseBase, height: 2, blockId: "minecraft:birch_planks" })],
    metadata: {
      ...args.metadata,
      noise: {
        kind: "tower",
        base: { x: noiseBase[0], y: noiseBase[1], z: noiseBase[2] },
        height: 2,
      },
    },
  };
}

function buildDirectionalSingleHop(args: { seed: bigint; index: number; rng: PythonRandom }): TextQATaskSpec {
  const family = "furthest_cardinal_marker";
  const coords = [
    [-4, 64, -2],
    [0, 64, 3],
    [3, 64, -6],
  ] as Array<[number, number, number]>;
  args.rng.shuffle(coords);
  const markers = markerBlocks.slice(0, 3);
  const setupBlocks = coords.map((coord, index) => ({ x: coord[0], y: coord[1], z: coord[2], blockId: markers[index]! }));
  const answerMarker = [...coords.entries()].sort((left, right) => left[1][2] - right[1][2])[0]![0];
  const metadata = {
    entities: coords.map((coord, index) => ({
      name: markerName(markers[index]!),
      blockId: markers[index],
      x: coord[0],
      y: coord[1],
      z: coord[2],
    })),
  };
  const withExtra = withNoise({
    rng: args.rng,
    prompt: `Three colored wool markers are nearby: ${markerName(markers[0]!)}, ${markerName(markers[1]!)}, and ${markerName(markers[2]!)}. Which marker is furthest north?`,
    setupBlocks,
    metadata,
  });

  return {
    taskId: taskId("qa_directional_single_hop", args.seed, family, args.index),
    tier: "qa_directional_single_hop",
    family,
    seed: normalizeSeed(args.seed),
    prompt: withExtra.prompt,
    player: defaultPlayerSpec(),
    setupBlocks: withExtra.setupBlocks,
    expectedAnswer: markerName(markers[answerMarker]!),
    answerFormat: "entity_name",
    canonicalReasoning: [
      "North corresponds to the smallest z coordinate.",
      `The furthest north marker is ${markerName(markers[answerMarker]!)}.`,
    ],
    metadata: withExtra.metadata,
  };
}

function buildMultiHopChain(args: { seed: bigint; index: number; rng: PythonRandom }): TextQATaskSpec {
  const family = "resolve_marker_chain";
  const hopCount = args.rng.randint(2, 8);
  const { positions, steps } = chainPositions({
    rng: args.rng,
    start: [args.rng.randint(-9, -3), 64, args.rng.randint(-9, -3)],
    hopCount,
    stepDistance: 3,
  });
  const markers = markerBlocks.slice(0, hopCount + 1);
  const setupBlocks = positions.map((coord, index) => ({
    x: coord[0],
    y: coord[1],
    z: coord[2],
    blockId: markers[index]!,
  }));
  const finalMarker = markerName(markers.at(-1)!);
  const reasoning = [
    `Start at ${markerName(markers[0]!)}.`,
    ...steps.map((step, index) => `Step ${index + 1}: move 3 blocks ${step} to ${markerName(markers[index + 1]!)}.`),
    `The final marker is ${finalMarker}.`,
  ];
  const metadata = {
    stepDistance: 3,
    steps,
    entities: positions.map((coord, index) => ({
      name: markerName(markers[index]!),
      blockId: markers[index],
      x: coord[0],
      y: coord[1],
      z: coord[2],
    })),
  };
  const withExtra = withNoise({
    rng: args.rng,
    prompt: `Colored wool markers are placed nearby. Start at the ${markerName(markers[0]!)}, ${steps.map((step) => `move to the marker 3 blocks ${step} of that marker`).join(", then ")}. Which marker do you end on?`,
    setupBlocks,
    metadata,
  });

  return {
    taskId: taskId("qa_multi_hop_chain", args.seed, family, args.index),
    tier: "qa_multi_hop_chain",
    family,
    seed: normalizeSeed(args.seed),
    prompt: withExtra.prompt,
    player: defaultPlayerSpec(),
    setupBlocks: withExtra.setupBlocks,
    expectedAnswer: finalMarker,
    answerFormat: "entity_name",
    canonicalReasoning: reasoning,
    metadata: withExtra.metadata,
  };
}

function buildViewpointTransform(args: { seed: bigint; index: number; rng: PythonRandom }): TextQATaskSpec {
  const family = "relative_to_player_marker";
  const facing = args.rng.choice(["north", "south", "east", "west"] as const);
  const [forwardDx, forwardDz] = horizontalFacingOffset(facing);
  const [leftDx, leftDz] = [forwardDz, -forwardDx];
  const [rightDx, rightDz] = [-forwardDz, forwardDx];
  const worldOffsets = {
    front: [forwardDx, forwardDz],
    behind: [-forwardDx, -forwardDz],
    left: [leftDx, leftDz],
    right: [rightDx, rightDz],
  } as const;
  const markers = markerBlocks.slice(0, 4);
  const directions = ["front", "behind", "left", "right"] as const;
  const setupBlocks = directions.map((direction, index) => ({
    x: worldOffsets[direction][0],
    y: 64,
    z: worldOffsets[direction][1],
    blockId: markers[index]!,
  }));
  const askedDirection = args.rng.choice([...directions]);
  const answerMarker = markerName(markers[directions.indexOf(askedDirection)]!);

  return {
    taskId: taskId("qa_viewpoint_transform", args.seed, family, args.index),
    tier: "qa_viewpoint_transform",
    family,
    seed: normalizeSeed(args.seed),
    prompt: `You are facing ${facing}. Four colored markers surround you. Which marker is ${askedDirection} of you?`,
    player: defaultPlayerSpec({ facing }),
    setupBlocks,
    expectedAnswer: answerMarker,
    answerFormat: "entity_name",
    canonicalReasoning: [
      `When you face ${facing}, ${askedDirection} maps to offset (${worldOffsets[askedDirection][0]}, ${worldOffsets[askedDirection][1]}).`,
      `The marker at that relative position is ${answerMarker}.`,
    ],
    metadata: {
      facing,
      worldOffsets: Object.fromEntries(Object.entries(worldOffsets).map(([direction, offset]) => [direction, { x: offset[0], z: offset[1] }])),
    },
  };
}

function buildTopology(args: { seed: bigint; index: number; rng: PythonRandom }): TextQATaskSpec {
  const family = args.rng.choice(["inside_enclosure", "shared_wall_yes_no"] as const);

  if (family === "inside_enclosure") {
    const enclosureWidth = args.rng.choice([7, 9]);
    const enclosureDepth = args.rng.choice([7, 9]);
    const enclosureOrigin = [args.rng.randint(-10, -2), 64, args.rng.randint(-10, -2)] as const;
    const insideBase = [
      enclosureOrigin[0] + args.rng.randint(1, enclosureWidth - 2),
      64,
      enclosureOrigin[2] + args.rng.randint(1, enclosureDepth - 2),
    ] as const;
    const outsideBase = [
      enclosureOrigin[0] + enclosureWidth + args.rng.randint(2, 4),
      64,
      enclosureOrigin[2] + args.rng.randint(1, enclosureDepth - 2),
    ] as const;
    const farBase = [
      enclosureOrigin[0] - args.rng.randint(4, 6),
      64,
      enclosureOrigin[2] + args.rng.randint(1, enclosureDepth - 2),
    ] as const;
    const markers = [...markerBlocks.slice(0, 3)];
    args.rng.shuffle(markers);
    const [insideMarker, outsideMarker, farMarker] = markers;
    const setupBlocks = [
      ...enclosureShell({ origin: enclosureOrigin, width: enclosureWidth, depth: enclosureDepth, height: 2, wallBlock: "minecraft:stone_bricks" }),
      ...tower({ base: insideBase, height: 3, blockId: insideMarker! }),
      ...tower({ base: outsideBase, height: 3, blockId: outsideMarker! }),
      ...tower({ base: farBase, height: 3, blockId: farMarker! }),
    ];
    const expectedAnswer = markerName(insideMarker!);

    return {
      taskId: taskId("qa_topology", args.seed, family, args.index),
      tier: "qa_topology",
      family,
      seed: normalizeSeed(args.seed),
      prompt: "Three material-coded towers are nearby and one of them is inside a stone_bricks enclosure. Which tower is inside the enclosure?",
      player: defaultPlayerSpec(),
      setupBlocks,
      expectedAnswer,
      answerFormat: "entity_name",
      canonicalReasoning: [
        "The enclosure bounds the interior region between its walls.",
        `The ${markerName(insideMarker!)} sits inside those bounds while the other towers do not.`,
        `The tower inside the enclosure is ${expectedAnswer}.`,
      ],
      metadata: {
        insideTower: expectedAnswer,
        insideEntityBlockId: insideMarker,
        candidateEntityBlockIds: [insideMarker, outsideMarker, farMarker],
        enclosureBlockId: "minecraft:stone_bricks",
        enclosureWidth,
        enclosureDepth,
        enclosureOrigin: { x: enclosureOrigin[0], y: enclosureOrigin[1], z: enclosureOrigin[2] },
      },
    };
  }

  const roomWidth = 5;
  const roomDepth = 5;
  const roomHeight = 3;
  const axis = args.rng.choice(["x", "z"] as const);
  const shareWall = args.rng.choice([true, false] as const);
  const firstOrigin = [args.rng.randint(-8, -2), 64, args.rng.randint(-8, -2)] as const;
  const gap = shareWall ? roomWidth - 1 : roomWidth + args.rng.choice([1, 2, 3]);
  const secondOrigin = axis === "x"
    ? [firstOrigin[0] + gap, 64, firstOrigin[2]] as const
    : [firstOrigin[0], 64, firstOrigin[2] + gap] as const;

  return {
    taskId: taskId("qa_topology", args.seed, family, args.index),
    tier: "qa_topology",
    family,
    seed: normalizeSeed(args.seed),
    prompt: "Two stone_bricks rooms are nearby. Do they share a wall?",
    player: defaultPlayerSpec(),
    setupBlocks: [
      ...roomShell({ origin: firstOrigin, width: roomWidth, depth: roomDepth, height: roomHeight, wallBlock: "minecraft:stone_bricks" }),
      ...roomShell({ origin: secondOrigin, width: roomWidth, depth: roomDepth, height: roomHeight, wallBlock: "minecraft:stone_bricks" }),
    ],
    expectedAnswer: shareWall ? "yes" : "no",
    answerFormat: "yes_no",
    canonicalReasoning: [
      "Rooms share a wall only when their wall coordinates overlap on one face.",
      shareWall
        ? "These two rooms touch along one face, so they share a wall."
        : "There is a gap between the rooms, so their wall coordinates do not overlap.",
      `The correct answer is ${shareWall ? "yes" : "no"}.`,
    ],
    metadata: {
      leftRoomOrigin: { x: firstOrigin[0], y: firstOrigin[1], z: firstOrigin[2] },
      rightRoomOrigin: { x: secondOrigin[0], y: secondOrigin[1], z: secondOrigin[2] },
      roomWidth,
      roomDepth,
      roomHeight,
      wallBlockId: "minecraft:stone_bricks",
      shareWall,
      axis,
    },
  };
}

const textQaBuilders: Record<TextQaTier, Builder> = {
  qa_directional_single_hop: buildDirectionalSingleHop,
  qa_multi_hop_chain: buildMultiHopChain,
  qa_viewpoint_transform: buildViewpointTransform,
  qa_topology: buildTopology,
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
