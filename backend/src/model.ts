/** Model adapter for single-turn JavaScript code generation. */

import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText } from "ai";

export type ModelCall = (systemPrompt: string, userPrompt: string) => Promise<string>;

/** Create a Vercel AI SDK Anthropic adapter for build code generation. */
export function createAnthropicModelCall(modelName: string, apiKey?: string | null): ModelCall {
  const provider = createAnthropic(apiKey ? { apiKey } : undefined);
  return async (systemPrompt, userPrompt) => {
    const response = await generateText({
      model: provider(modelName),
      system: systemPrompt,
      prompt: userPrompt,
    });
    return response.text;
  };
}
