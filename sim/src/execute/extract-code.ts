/** Extract JavaScript from raw model output. */

/** Prefer fenced JS/TS blocks and fall back to the raw output. */
export function extractCode(modelOutput: string): string {
  const fenceMatch = modelOutput.match(/```(?:javascript|js|typescript|ts)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) {
    return fenceMatch[1].trim();
  }
  return modelOutput.trim();
}
