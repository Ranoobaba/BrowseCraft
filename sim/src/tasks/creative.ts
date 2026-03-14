/** Creative-build task generation. */

import { createHash } from "node:crypto";
import prompts from "./creative-prompts.json" with { type: "json" };
import { creativeBuildTaskSchema, defaultPlayerSpec, normalizeSeed, type CreativeBuildTaskSpec, type CreativeCategory } from "../types.js";
import { PythonRandom } from "./python-random.js";

type CreativePromptRecord = {
  category: CreativeCategory;
  prompt: string;
};

const creativePromptLibrary = prompts as CreativePromptRecord[];

/** Return the checked-in prompt library used for creative mode. */
export function creativePromptLibraryEntries(): readonly CreativePromptRecord[] {
  return creativePromptLibrary;
}

/** Generate deterministic creative tasks. */
export function generateCreativeTasks(options: {
  seed: number;
  count: number;
}): CreativeBuildTaskSpec[] {
  const rng = new PythonRandom(options.seed);
  const tasks: CreativeBuildTaskSpec[] = [];

  for (let index = 0; index < options.count; index += 1) {
    const promptRecord = rng.choice(creativePromptLibrary);
    const derivedSeed = deriveSeed(options.seed, index, promptRecord.prompt);
    tasks.push(creativeBuildTaskSchema.parse({
      taskId: `creative_build:${promptRecord.category}:${derivedSeed}:${index}`,
      mode: "creative_build",
      family: "creative_prompt",
      category: promptRecord.category,
      seed: normalizeSeed(derivedSeed),
      prompt: promptRecord.prompt,
      player: defaultPlayerSpec(),
      metadata: {
        source: "minebench-inspired-prompt-library",
      },
    }));
  }

  return tasks;
}

function deriveSeed(seed: number, index: number, prompt: string): bigint {
  const digest = createHash("sha256")
    .update(`${seed}:${index}:${prompt}`)
    .digest("hex")
    .slice(0, 16);
  return BigInt(`0x${digest}`);
}
