/** Session storage backed by memory with optional Convex persistence. */

import { randomUUID } from "node:crypto";
import {
  sessionListResponseSchema,
  sessionStatusResponseSchema,
  type SessionListResponse,
  type SessionMessage,
  type SessionStatusResponse,
  type SessionSummary,
} from "./models.js";
import { ConvexHttpClient } from "./convex.js";

type SessionRecord = {
  sessionId: string;
  createdAt: Date;
  updatedAt: Date;
  messages: SessionMessage[];
};

type SessionDocument = {
  world_id: string;
  session_id: string;
  created_at: number;
  updated_at: number;
  messages: SessionMessage[];
};

type SessionKey = `${string}:${string}`;

/** SessionStore owns session lifetimes and the active session pointer per client/world. */
export class SessionStore {
  readonly #sessions = new Map<string, Map<string, SessionRecord>>();
  readonly #activeSessions = new Map<SessionKey, string>();
  readonly #convex: ConvexHttpClient | null;

  constructor(options: { convex?: ConvexHttpClient | null } = {}) {
    this.#convex = options.convex ?? null;
  }

  /** Create a new session for one client/world pair and mark it active. */
  async createSession(clientId: string, worldId: string): Promise<SessionStatusResponse> {
    const session = this.#newSession();
    await this.#persistSession(worldId, session);
    this.#activeSessions.set(this.#activeKey(clientId, worldId), session.sessionId);
    return sessionStatusResponseSchema.parse({
      worldId,
      sessionId: session.sessionId,
      status: "created",
    });
  }

  /** List sessions for a world, newest first. */
  async listSessions(clientId: string, worldId: string): Promise<SessionListResponse> {
    const sessions = await this.#listSessionsForWorld(worldId);
    const summaries: SessionSummary[] = sessions.map((session) => ({
      sessionId: session.sessionId,
      messageCount: session.messages.length,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
    }));

    const activeSessionId = this.#activeSessions.get(this.#activeKey(clientId, worldId)) ?? null;
    return sessionListResponseSchema.parse({
      worldId,
      activeSessionId,
      sessions: summaries,
    });
  }

  /** Mark an existing session active for future chat requests. */
  async switchSession(clientId: string, worldId: string, sessionId: string): Promise<SessionStatusResponse> {
    const session = await this.#loadSession(worldId, sessionId);
    if (session === null) {
      throw new LookupError(`Session ${sessionId} not found for world ${worldId}`);
    }

    this.#activeSessions.set(this.#activeKey(clientId, worldId), session.sessionId);
    return sessionStatusResponseSchema.parse({
      worldId,
      sessionId: session.sessionId,
      status: "active",
    });
  }

  /** Resolve the session that should receive the next chat exchange. */
  async resolveSessionForChat(clientId: string, worldId: string, requestedSessionId?: string): Promise<string> {
    if (requestedSessionId !== undefined) {
      const requested = await this.#loadSession(worldId, requestedSessionId);
      if (requested === null) {
        throw new LookupError(`Session ${requestedSessionId} not found for world ${worldId}`);
      }
      this.#activeSessions.set(this.#activeKey(clientId, worldId), requested.sessionId);
      return requested.sessionId;
    }

    const activeSessionId = this.#activeSessions.get(this.#activeKey(clientId, worldId));
    if (activeSessionId !== undefined) {
      return activeSessionId;
    }

    const created = await this.createSession(clientId, worldId);
    return created.sessionId;
  }

  /** Append one user/assistant exchange to the resolved session. */
  async appendExchange(worldId: string, sessionId: string, userMessage: string, assistantMessage: string): Promise<void> {
    const session = await this.#loadSession(worldId, sessionId);
    if (session === null) {
      throw new LookupError(`Session ${sessionId} not found for world ${worldId}`);
    }

    session.messages.push({ role: "user", content: userMessage });
    session.messages.push({ role: "assistant", content: assistantMessage });
    session.updatedAt = new Date();
    await this.#persistSession(worldId, session);
  }

  async #loadSession(worldId: string, sessionId: string): Promise<SessionRecord | null> {
    const cached = this.#sessions.get(worldId)?.get(sessionId) ?? null;
    if (cached !== null) {
      return cached;
    }

    if (this.#convex === null) {
      return null;
    }

    const raw = await this.#convex.query("sessions:get", {
      world_id: worldId,
      session_id: sessionId,
    });
    if (raw === null) {
      return null;
    }

    const session = this.#fromDocument(raw as SessionDocument);
    this.#worldSessions(worldId).set(session.sessionId, session);
    return session;
  }

  async #listSessionsForWorld(worldId: string): Promise<SessionRecord[]> {
    if (this.#convex !== null) {
      const raw = await this.#convex.query("sessions:listByWorld", { world_id: worldId });
      if (!Array.isArray(raw)) {
        throw new Error("Convex sessions:listByWorld must return an array");
      }

      const hydrated = this.#worldSessions(worldId);
      hydrated.clear();
      for (const document of raw as SessionDocument[]) {
        const session = this.#fromDocument(document);
        hydrated.set(session.sessionId, session);
      }
    }

    return [...this.#worldSessions(worldId).values()].sort(
      (left, right) => right.updatedAt.getTime() - left.updatedAt.getTime(),
    );
  }

  async #persistSession(worldId: string, session: SessionRecord): Promise<void> {
    this.#worldSessions(worldId).set(session.sessionId, session);
    if (this.#convex === null) {
      return;
    }

    await this.#convex.mutation("sessions:upsert", {
      world_id: worldId,
      session_id: session.sessionId,
      messages: session.messages,
      created_at: session.createdAt.getTime(),
      updated_at: session.updatedAt.getTime(),
    });
  }

  #newSession(): SessionRecord {
    const now = new Date();
    return {
      sessionId: randomUUID(),
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
  }

  #fromDocument(document: SessionDocument): SessionRecord {
    return {
      sessionId: document.session_id,
      createdAt: new Date(document.created_at),
      updatedAt: new Date(document.updated_at),
      messages: document.messages.map((message) => ({ ...message })),
    };
  }

  #worldSessions(worldId: string): Map<string, SessionRecord> {
    let sessions = this.#sessions.get(worldId);
    if (sessions === undefined) {
      sessions = new Map<string, SessionRecord>();
      this.#sessions.set(worldId, sessions);
    }
    return sessions;
  }

  #activeKey(clientId: string, worldId: string): SessionKey {
    return `${clientId}:${worldId}`;
  }
}

class LookupError extends Error {
  override name = "LookupError";
}
