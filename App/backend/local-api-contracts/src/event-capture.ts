import { z } from "zod";

export const EventCaptureSessionSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().uuid(), pluginId: z.string(), conversationId: z.string().min(1),
  goal: z.string().min(1), state: z.enum(["starting", "recording", "finalizing", "ready", "cancelled", "failed"]),
  startedAt: z.string().datetime(), endedAt: z.string().datetime().nullable(), eventCount: z.number().int().nonnegative(),
  eventTypes: z.record(z.string(), z.number().int().nonnegative()), applications: z.array(z.string()),
  eventsSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  availability: z.enum(["pending", "available", "empty", "partial", "unavailable"]),
  limitations: z.array(z.string()), error: z.string().nullable(),
  ranges: z.array(z.object({ stream: z.string(), startByte: z.number().int().nonnegative(), endByte: z.number().int().nonnegative() }))
});
export type EventCaptureSession = z.infer<typeof EventCaptureSessionSchema>;

/** Declares a conversation-owned state/control capability; it never opens a surface. */
export const PluginConversationSchema = z.object({
  recordingCapabilityId: z.string().min(1), skillCapabilityId: z.string().min(1).optional(),
  recordingSkillId: z.string().min(1), creatorSkillId: z.string().min(1).optional()
});

/** Plugin-authored copy/actions displayed by the generic conversation status view. */
export const PluginConversationPresentationSchema = z.object({
  message: z.string().max(2_000),
  actions: z.array(z.object({ id: z.string().min(1).max(100), label: z.string().min(1).max(120),
    prompt: z.string().min(1).max(4_000) })).max(8).default([])
});
export type PluginConversationPresentation = z.infer<typeof PluginConversationPresentationSchema>;
