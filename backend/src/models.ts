/** HTTP and WebSocket schemas for the single-turn voxel.exec backend. */

import { z } from "zod";
import { worldContextSchema, type BlockPlacement } from "@browsecraft/sim";

export const chatRequestSchema = z.object({
  clientId: z.string().min(1),
  message: z.string().min(1),
  worldId: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  worldContext: worldContextSchema,
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;

export const chatAcceptedResponseSchema = z.object({
  jobId: z.string().min(1),
  sessionId: z.string().min(1),
  status: z.literal("accepted"),
});

export type ChatAcceptedResponse = z.infer<typeof chatAcceptedResponseSchema>;

export const sessionNewRequestSchema = z.object({
  clientId: z.string().min(1),
  worldId: z.string().min(1),
});

export type SessionNewRequest = z.infer<typeof sessionNewRequestSchema>;

export const sessionSwitchRequestSchema = z.object({
  clientId: z.string().min(1),
  worldId: z.string().min(1),
  sessionId: z.string().min(1),
});

export type SessionSwitchRequest = z.infer<typeof sessionSwitchRequestSchema>;

export const sessionSummarySchema = z.object({
  sessionId: z.string().min(1),
  messageCount: z.number().int().min(0),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export type SessionSummary = z.infer<typeof sessionSummarySchema>;

export const sessionListResponseSchema = z.object({
  worldId: z.string().min(1),
  activeSessionId: z.string().min(1).nullable(),
  sessions: z.array(sessionSummarySchema),
});

export type SessionListResponse = z.infer<typeof sessionListResponseSchema>;

export const sessionStatusResponseSchema = z.object({
  worldId: z.string().min(1),
  sessionId: z.string().min(1),
  status: z.enum(["created", "active"]),
});

export type SessionStatusResponse = z.infer<typeof sessionStatusResponseSchema>;

export const buildApplyPayloadSchema = z.object({
  jobId: z.string().min(1),
  worldId: z.string().min(1),
  sessionId: z.string().min(1),
  primitiveCount: z.number().int().min(0),
  executionTimeMs: z.number().min(0),
  placements: z.array(z.object({
    x: z.number().int(),
    y: z.number().int(),
    z: z.number().int(),
    blockId: z.string().min(1),
  })),
});

export type BuildApplyPayload = z.infer<typeof buildApplyPayloadSchema>;

export const buildApplyEnvelopeSchema = z.object({
  type: z.literal("build.apply"),
  payload: buildApplyPayloadSchema,
});

export type BuildApplyEnvelope = z.infer<typeof buildApplyEnvelopeSchema>;

export const chatDeltaEnvelopeSchema = z.object({
  type: z.literal("chat.delta"),
  payload: z.object({
    jobId: z.string().min(1),
    delta: z.string(),
  }),
});

export type ChatDeltaEnvelope = z.infer<typeof chatDeltaEnvelopeSchema>;

export const chatResponseEnvelopeSchema = z.object({
  type: z.literal("chat.response"),
  payload: z.object({
    jobId: z.string().min(1),
    sessionId: z.string().min(1),
    message: z.string(),
  }),
});

export type ChatResponseEnvelope = z.infer<typeof chatResponseEnvelopeSchema>;

export const errorEnvelopeSchema = z.object({
  type: z.literal("error"),
  payload: z.object({
    jobId: z.string().min(1).optional(),
    code: z.string().min(1),
    message: z.string().min(1),
  }),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

export const buildResultMessageSchema = z.object({
  type: z.literal("build.result"),
  jobId: z.string().min(1),
  payload: z.object({
    success: z.boolean(),
    error: z.string().nullable().optional(),
    appliedCount: z.number().int().min(0),
    fillCount: z.number().int().min(0).optional(),
    setblockCount: z.number().int().min(0).optional(),
  }),
});

export type BuildResultMessage = z.infer<typeof buildResultMessageSchema>;

export type SessionMessage = {
  role: "user" | "assistant";
  content: string;
};

export type BuildDelta = BlockPlacement;
