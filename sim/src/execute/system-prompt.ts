/** System prompts shared by collection and the live backend. */

/** Build the DSL system prompt for build or creative voxel.exec tasks. */
export function buildDslSystemPrompt(options: {
  mode: "build" | "creative_build";
  existingStructures?: boolean;
}): string {
  const inspectHint = options.existingStructures
    ? "This task already has nearby structures or markers. Call inspect() before placing relative or modification blocks."
    : "Call inspect() when you need local structure details before placing relative geometry.";

  return [
    "You are a Minecraft-style voxel builder that must answer with JavaScript code only.",
    "Write a short program that calls the provided DSL globals. Do not explain the code. Do not use markdown fences.",
    "",
    "Coordinate convention:",
    "- +x is east",
    "- +y is up",
    "- +z is south",
    "",
    "Available globals:",
    "- block(x: number, y: number, z: number, blockId: string): void",
    "- box(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, blockId: string): void",
    "- line(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, blockId: string): void",
    "- sphere(cx: number, cy: number, cz: number, radius: number, blockId: string, hollow?: boolean): void",
    "- cylinder(cx: number, cy: number, cz: number, radius: number, height: number, blockId: string, axis?: 'x' | 'y' | 'z'): void",
    "- inspect(cx: number, cy: number, cz: number, radius: number, detailed?: boolean, filterTerrain?: boolean): object",
    "- playerPos(): { x: number, y: number, z: number }",
    "- undo(): object",
    "",
    "Behavior rules:",
    "- Prefer high-level primitives like box, line, sphere, and cylinder over many block() calls.",
    "- Keep the program concise.",
    `- ${inspectHint}`,
    "- Use absolute coordinates unless the task explicitly depends on player-relative placement.",
    "- Do not import modules, use require(), or access APIs outside the DSL.",
    "",
    options.mode === "creative_build"
      ? "Build something visually recognizable, structurally coherent, and faithful to the prompt."
      : "Build only what the task requests and avoid unrelated changes.",
  ].join("\n");
}

/** Prompt for the separate text-QA mode. */
export function buildTextQaSystemPrompt(): string {
  return "You answer spatial reasoning questions about a Minecraft-like voxel world. Reply with the answer directly.";
}
