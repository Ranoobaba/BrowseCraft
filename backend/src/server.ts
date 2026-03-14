/** HTTP and WebSocket entrypoint for the BrowseCraft voxel.exec backend. */

import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { ZodError } from "zod";
import { WebSocketServer } from "ws";
import {
  chatRequestSchema,
  sessionNewRequestSchema,
  sessionSwitchRequestSchema,
} from "./models.js";
import { loadConfig, type BackendConfig } from "./config.js";
import { createAnthropicModelCall, type ModelCall } from "./model.js";
import { ChatService } from "./chat-service.js";
import { SessionStore } from "./session-store.js";
import { WebSocketManager } from "./websocket-manager.js";
import { ConvexHttpClient } from "./convex.js";

export type AppServer = {
  server: HttpServer;
  config: BackendConfig;
  close: () => Promise<void>;
};

/** Create the backend server with injectable dependencies for tests. */
export function createAppServer(options: {
  config?: BackendConfig;
  modelCall?: ModelCall;
  sessions?: SessionStore;
  ws?: WebSocketManager;
} = {}): AppServer {
  const config = options.config ?? loadConfig();
  const convex = config.convexUrl === null ? null : new ConvexHttpClient({
    baseUrl: config.convexUrl,
    accessKey: config.convexAccessKey,
  });
  const sessions = options.sessions ?? new SessionStore({ convex });
  const ws = options.ws ?? new WebSocketManager();
  const modelCall = options.modelCall ?? createAnthropicModelCall(
    config.anthropicChatModel,
    config.anthropicApiKey,
  );
  const chat = new ChatService({ config, sessions, ws, modelCall });

  const server = createHttpServer(async (request, response) => {
    try {
      await routeRequest({
        request,
        response,
        chat,
        sessions,
      });
    } catch (error) {
      if (error instanceof ZodError) {
        json(response, 400, {
          error: "Invalid request",
          issues: error.issues,
        });
        return;
      }
      if (isLookupError(error)) {
        json(response, 404, { error: error.message });
        return;
      }
      if (error instanceof Error && error.message.includes("is not connected to /v1/ws")) {
        json(response, 409, { error: error.message });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      json(response, 500, { error: message });
    }
  });

  const webSocketServer = new WebSocketServer({ noServer: true });
  const attachSocket = (clientId: string, socket: import("ws").WebSocket): void => {
    ws.connect(clientId, socket);
    socket.on("message", (buffer) => {
      try {
        const parsed = JSON.parse(String(buffer));
        ws.handleIncomingMessage(clientId, parsed);
      } catch {
        // Invalid client messages are ignored loudly by omission. The mod owns this protocol.
      }
    });
    socket.on("close", () => ws.disconnect(clientId));
    socket.on("error", () => ws.disconnect(clientId));
  };

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    const match = /^\/v1\/ws\/([^/]+)$/.exec(url.pathname);
    if (match === null) {
      socket.destroy();
      return;
    }

    const clientId = decodeURIComponent(match[1]!);
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      attachSocket(clientId, webSocket);
    });
  });

  return {
    server,
    config,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        webSocketServer.clients.forEach((client) => client.close());
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

async function routeRequest(options: {
  request: IncomingMessage;
  response: ServerResponse;
  chat: ChatService;
  sessions: SessionStore;
}): Promise<void> {
  const { request, response, chat, sessions } = options;
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

  if (method === "GET" && url.pathname === "/health") {
    json(response, 200, { status: "ok" });
    return;
  }

  if (method === "POST" && url.pathname === "/v1/chat") {
    const payload = chatRequestSchema.parse(await readJson(request));
    const accepted = await chat.submitChat(payload);
    json(response, 202, accepted);
    return;
  }

  if (method === "POST" && url.pathname === "/v1/session/new") {
    const payload = sessionNewRequestSchema.parse(await readJson(request));
    json(response, 200, await sessions.createSession(payload.clientId, payload.worldId));
    return;
  }

  if (method === "GET" && url.pathname === "/v1/session/list") {
    const clientId = requiredQuery(url, "clientId");
    const worldId = requiredQuery(url, "worldId");
    json(response, 200, await sessions.listSessions(clientId, worldId));
    return;
  }

  if (method === "POST" && url.pathname === "/v1/session/switch") {
    const payload = sessionSwitchRequestSchema.parse(await readJson(request));
    json(response, 200, await sessions.switchSession(payload.clientId, payload.worldId, payload.sessionId));
    return;
  }

  json(response, 404, { error: "Not found" });
}

/** Start the production server on the configured port. */
export async function startServer(): Promise<AppServer> {
  const app = createAppServer();
  await new Promise<void>((resolve, reject) => {
    app.server.listen(app.config.port, () => resolve());
    app.server.on("error", reject);
  });
  return app;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function requiredQuery(url: URL, key: string): string {
  const value = url.searchParams.get(key);
  if (value === null || value === "") {
    throw new Error(`Missing query parameter: ${key}`);
  }
  return value;
}

function json(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(payload));
}

function isLookupError(error: unknown): error is Error {
  return error instanceof Error && error.name === "LookupError";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void startServer()
    .then((app) => {
      process.stdout.write(`BrowseCraft backend listening on http://127.0.0.1:${app.config.port}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
