/** Orchestrates one-shot build chat jobs from prompt to build.apply acknowledgement. */

import { randomUUID } from "node:crypto";
import {
  HeadlessVoxelWorld,
  buildDslSystemPrompt,
  executeCode,
  extractCode,
} from "@browsecraft/sim";
import {
  chatAcceptedResponseSchema,
  type ChatAcceptedResponse,
  type ChatRequest,
} from "./models.js";
import type { BackendConfig } from "./config.js";
import type { ModelCall } from "./model.js";
import { SessionStore } from "./session-store.js";
import { WebSocketManager } from "./websocket-manager.js";

/** ChatService owns job lifetimes for the live build-only backend. */
export class ChatService {
  readonly #config: BackendConfig;
  readonly #sessions: SessionStore;
  readonly #ws: WebSocketManager;
  readonly #modelCall: ModelCall;

  constructor(options: {
    config: BackendConfig;
    sessions: SessionStore;
    ws: WebSocketManager;
    modelCall: ModelCall;
  }) {
    this.#config = options.config;
    this.#sessions = options.sessions;
    this.#ws = options.ws;
    this.#modelCall = options.modelCall;
  }

  /** Accept a chat request and start the build job in the background. */
  async submitChat(request: ChatRequest): Promise<ChatAcceptedResponse> {
    const worldId = request.worldId ?? "default";
    if (!this.#ws.hasConnection(request.clientId)) {
      throw new Error(`Client ${request.clientId} is not connected to /v1/ws`);
    }

    const sessionId = await this.#sessions.resolveSessionForChat(
      request.clientId,
      worldId,
      request.sessionId,
    );
    const jobId = randomUUID();

    void this.#runJob({
      jobId,
      sessionId,
      worldId,
      request,
    });

    return chatAcceptedResponseSchema.parse({
      jobId,
      sessionId,
      status: "accepted",
    });
  }

  async #runJob(options: {
    jobId: string;
    sessionId: string;
    worldId: string;
    request: ChatRequest;
  }): Promise<void> {
    const { jobId, sessionId, worldId, request } = options;

    try {
      await this.#sendDelta(request.clientId, jobId, "Generating JavaScript build program.");
      const systemPrompt = buildDslSystemPrompt({
        mode: "build",
        existingStructures: hasNonTerrainStructure(request.worldContext.blocks),
      });
      const modelOutput = await this.#modelCall(systemPrompt, request.message);
      const extractedCode = extractCode(modelOutput);

      await this.#sendDelta(request.clientId, jobId, "Executing build program in the voxel sandbox.");
      const world = HeadlessVoxelWorld.fromSnapshot(request.worldContext);
      const execution = await executeCode(world, extractedCode);
      if (!execution.success) {
        const failureMessage = `Build code failed in the sandbox: ${execution.error ?? "unknown error"}`;
        await this.#sendError(request.clientId, jobId, "EXECUTION_ERROR", failureMessage);
        await this.#finishChat(request.clientId, worldId, sessionId, jobId, request.message, failureMessage);
        return;
      }

      if (execution.worldDiff.length === 0) {
        const noChangeMessage = "The generated program ran, but it did not produce any block changes.";
        await this.#finishChat(request.clientId, worldId, sessionId, jobId, request.message, noChangeMessage);
        return;
      }

      await this.#sendDelta(
        request.clientId,
        jobId,
        `Applying ${execution.worldDiff.length} block changes to the client world.`,
      );
      const buildResultPromise = this.#ws.waitForBuildResult(
        request.clientId,
        jobId,
        this.#config.buildApplyTimeoutMs,
      );
      await this.#ws.send(request.clientId, {
        type: "build.apply",
        payload: {
          jobId,
          worldId,
          sessionId,
          primitiveCount: execution.primitiveCount,
          executionTimeMs: execution.executionTimeMs,
          placements: execution.worldDiff,
        },
      });

      const buildResult = await buildResultPromise;
      if (!buildResult.success) {
        const failureMessage = `The client could not apply the build: ${buildResult.error ?? "unknown error"}`;
        await this.#sendError(request.clientId, jobId, "APPLY_ERROR", failureMessage);
        await this.#finishChat(request.clientId, worldId, sessionId, jobId, request.message, failureMessage);
        return;
      }

      const message = renderCompletionMessage({
        primitiveCount: execution.primitiveCount,
        blockChanges: execution.worldDiff.length,
        appliedCount: buildResult.appliedCount,
      });
      await this.#finishChat(request.clientId, worldId, sessionId, jobId, request.message, message);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#sendError(request.clientId, jobId, "INTERNAL_ERROR", message);
      await this.#finishChat(
        request.clientId,
        worldId,
        sessionId,
        jobId,
        request.message,
        `The backend failed before the build finished: ${message}`,
      );
    }
  }

  async #sendDelta(clientId: string, jobId: string, delta: string): Promise<void> {
    await this.#ws.send(clientId, {
      type: "chat.delta",
      payload: {
        jobId,
        delta,
      },
    });
  }

  async #sendError(clientId: string, jobId: string, code: string, message: string): Promise<void> {
    await this.#ws.send(clientId, {
      type: "error",
      payload: {
        jobId,
        code,
        message,
      },
    });
  }

  async #finishChat(
    clientId: string,
    worldId: string,
    sessionId: string,
    jobId: string,
    userMessage: string,
    assistantMessage: string,
  ): Promise<void> {
    await this.#sessions.appendExchange(worldId, sessionId, userMessage, assistantMessage);
    await this.#ws.send(clientId, {
      type: "chat.response",
      payload: {
        jobId,
        sessionId,
        message: assistantMessage,
      },
    });
  }
}

function hasNonTerrainStructure(blocks: Record<string, string>): boolean {
  for (const blockId of Object.values(blocks)) {
    if (!terrainBlockIds.has(blockId)) {
      return true;
    }
  }
  return false;
}

function renderCompletionMessage(options: {
  primitiveCount: number;
  blockChanges: number;
  appliedCount: number;
}): string {
  return [
    `Applied ${options.appliedCount} block changes.`,
    `The build program used ${options.primitiveCount} primitives`,
    `and produced ${options.blockChanges} changed voxels.`,
  ].join(" ");
}

const terrainBlockIds = new Set([
  "minecraft:air",
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
  "minecraft:stone",
  "minecraft:deepslate",
  "minecraft:tuff",
]);
