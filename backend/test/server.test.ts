/** Integration coverage for the build-only HTTP and WebSocket backend. */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import type { AppServer } from "../src/server.js";
import { createAppServer } from "../src/server.js";

describe("backend server", () => {
  let app: AppServer;
  let baseUrl = "";
  let wsUrl = "";

  beforeEach(async () => {
    app = createAppServer({
      config: {
        port: 0,
        anthropicApiKey: null,
        anthropicChatModel: "test-model",
        convexUrl: null,
        convexAccessKey: null,
        buildApplyTimeoutMs: 5_000,
      },
      modelCall: async () => 'block(1, 64, 1, "minecraft:stone")',
    });

    await new Promise<void>((resolve) => {
      app.server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = app.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected TCP server address");
    }

    baseUrl = `http://127.0.0.1:${address.port}`;
    wsUrl = `ws://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await app.close();
  });

  test("rejects invalid chat requests without worldContext", async () => {
    const response = await fetch(`${baseUrl}/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId: "client-a",
        message: "build a wall",
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("worldContext");
  });

  test("emits build.apply and waits for build.result before chat.response", async () => {
    const events: Array<{ type: string; payload?: unknown }> = [];
    const socket = new WebSocket(`${wsUrl}/v1/ws/client-a`);

    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });

    socket.on("message", (buffer) => {
      const event = JSON.parse(String(buffer)) as { type: string; payload?: unknown };
      events.push(event);

      if (event.type === "build.apply") {
        const payload = event.payload as {
          jobId: string;
          placements: Array<{ x: number; y: number; z: number; blockId: string }>;
        };
        socket.send(JSON.stringify({
          type: "build.result",
          jobId: payload.jobId,
          payload: {
            success: true,
            appliedCount: payload.placements.length,
            fillCount: 0,
            setblockCount: payload.placements.length,
          },
        }));
      }
    });

    const response = await fetch(`${baseUrl}/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientId: "client-a",
        message: "place one block",
        worldId: "world-a",
        worldContext: {
          player: {
            x: 0,
            y: 64,
            z: 0,
            facing: "north",
            dimension: "minecraft:overworld",
          },
          blocks: {},
        },
      }),
    });

    expect(response.status).toBe(202);

    await waitFor(() => events.some((event) => event.type === "chat.response"));

    expect(events.some((event) => event.type === "build.apply")).toBe(true);
    expect(events.some((event) => event.type === "tool.request")).toBe(false);

    const buildApply = events.find((event) => event.type === "build.apply");
    expect(buildApply?.payload).toMatchObject({
      placements: [{ x: 1, y: 64, z: 1, blockId: "minecraft:stone" }],
    });

    const chatResponse = events.find((event) => event.type === "chat.response");
    expect(chatResponse?.payload).toMatchObject({
      message: expect.stringContaining("Applied 1 block changes."),
    });

    socket.close();
  });

  test("search and imagine routes are gone", async () => {
    const search = await fetch(`${baseUrl}/v1/search`, { method: "POST" });
    const imagine = await fetch(`${baseUrl}/v1/imagine`, { method: "POST" });

    expect(search.status).toBe(404);
    expect(imagine.status).toBe(404);
  });

  test("session create list and switch work", async () => {
    const createdOne = await postJson(`${baseUrl}/v1/session/new`, {
      clientId: "client-s",
      worldId: "world-s",
    });
    const createdTwo = await postJson(`${baseUrl}/v1/session/new`, {
      clientId: "client-s",
      worldId: "world-s",
    });

    await postJson(`${baseUrl}/v1/session/switch`, {
      clientId: "client-s",
      worldId: "world-s",
      sessionId: createdOne.sessionId,
    });

    const listed = await fetchJson(`${baseUrl}/v1/session/list?clientId=client-s&worldId=world-s`);
    expect(listed.activeSessionId).toBe(createdOne.sessionId);
    expect(listed.sessions).toHaveLength(2);
    expect(listed.sessions.map((session: { sessionId: string }) => session.sessionId)).toContain(createdTwo.sessionId);
  });
});

async function postJson(url: string, payload: unknown): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  return response.json();
}

async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url);
  return response.json();
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
