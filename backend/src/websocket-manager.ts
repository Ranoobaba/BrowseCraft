/** WebSocket connection tracking plus pending build-result futures. */

import { type WebSocket } from "ws";
import { buildResultMessageSchema, type BuildResultMessage } from "./models.js";

type PendingBuildResult = {
  clientId: string;
  resolve: (value: BuildResultMessage["payload"]) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

/** WebSocketManager owns live client sockets and build-result acknowledgements. */
export class WebSocketManager {
  readonly #connections = new Map<string, WebSocket>();
  readonly #pendingBuildResults = new Map<string, PendingBuildResult>();

  /** Attach or replace the active socket for one client id. */
  connect(clientId: string, socket: WebSocket): void {
    const previous = this.#connections.get(clientId);
    previous?.close();
    this.#connections.set(clientId, socket);
  }

  /** Drop a client connection and fail any jobs waiting on that client. */
  disconnect(clientId: string): void {
    this.#connections.delete(clientId);
    for (const [jobId, pending] of this.#pendingBuildResults) {
      if (pending.clientId !== clientId) {
        continue;
      }
      clearTimeout(pending.timeout);
      pending.reject(new Error(`WebSocket disconnected for client ${clientId}`));
      this.#pendingBuildResults.delete(jobId);
    }
  }

  /** Whether a client currently has an active WebSocket. */
  hasConnection(clientId: string): boolean {
    return this.#connections.has(clientId);
  }

  /** Send a JSON payload to one connected client. */
  send(clientId: string, payload: Record<string, unknown>): Promise<void> {
    const socket = this.#connections.get(clientId);
    if (socket === undefined) {
      return Promise.reject(new Error(`No WebSocket connection for client ${clientId}`));
    }

    return new Promise((resolve, reject) => {
      socket.send(JSON.stringify(payload), (error) => {
        if (error != null) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  /** Wait for the mod to acknowledge one build.apply job. */
  waitForBuildResult(clientId: string, jobId: string, timeoutMs: number): Promise<BuildResultMessage["payload"]> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pendingBuildResults.delete(jobId);
        reject(new Error(`Timed out waiting for build.result for job ${jobId}`));
      }, timeoutMs);

      this.#pendingBuildResults.set(jobId, {
        clientId,
        resolve,
        reject,
        timeout,
      });
    });
  }

  /** Route one incoming WebSocket message. */
  handleIncomingMessage(clientId: string, raw: unknown): boolean {
    const parsed = buildResultMessageSchema.safeParse(raw);
    if (!parsed.success) {
      return false;
    }

    const message = parsed.data;
    const pending = this.#pendingBuildResults.get(message.jobId);
    if (pending === undefined || pending.clientId !== clientId) {
      return true;
    }

    clearTimeout(pending.timeout);
    pending.resolve(message.payload);
    this.#pendingBuildResults.delete(message.jobId);
    return true;
  }
}
