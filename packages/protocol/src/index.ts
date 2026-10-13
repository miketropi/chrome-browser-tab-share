import { z } from 'zod';

const id = z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/);
const token = z.string().min(32).max(128).regex(/^[A-Za-z0-9_-]+$/);
const base = { v: z.literal(1) } as const;
const finite = z.number().finite();

export const MAX_CLIPBOARD_CHARACTERS = 60_000;
export const MAX_GUEST_MESSAGE_CHARACTERS = 280;

export const SessionStateSchema = z.enum(['starting', 'live', 'stopping', 'ended']);
export const GuestStateSchema = z.enum(['pending', 'approved', 'rejected']);
export type SessionState = z.infer<typeof SessionStateSchema>;
export type GuestState = z.infer<typeof GuestStateSchema>;

export const IceCandidateSchema = z.object({
  candidate: z.string().max(4096),
  sdpMid: z.string().max(256).nullable().optional(),
  sdpMLineIndex: z.number().int().min(0).max(65535).nullable().optional(),
  usernameFragment: z.string().max(256).nullable().optional()
}).strict();

const signalPayload = z.union([z.string().max(49_152), IceCandidateSchema, z.null()]);
export const SignalKindSchema = z.enum(['offer', 'answer', 'ice']);
const signalFields = {
  guestId: id,
  kind: SignalKindSchema,
  negotiationId: id,
  payload: signalPayload
} as const;

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('auth'), role: z.enum(['host', 'guest']), sessionId: id, token }).strict(),
  z.object({ ...base, type: z.literal('approve'), guestId: id }).strict(),
  z.object({ ...base, type: z.literal('reject'), guestId: id }).strict(),
  z.object({ ...base, type: z.literal('kick'), guestId: id }).strict(),
  z.object({ ...base, type: z.literal('request-control') }).strict(),
  z.object({ ...base, type: z.literal('grant-control'), guestId: id }).strict(),
  z.object({ ...base, type: z.literal('revoke-control') }).strict(),
  z.object({ ...base, type: z.literal('rotate-invite') }).strict(),
  z.object({ ...base, type: z.literal('end-session') }).strict(),
  z.object({ ...base, type: z.literal('signal'), ...signalFields }).strict(),
  z.object({ ...base, type: z.literal('turn-credentials'), guestId: id }).strict(),
  z.object({ ...base, type: z.literal('guest-message'), text: z.string().trim().min(1).max(MAX_GUEST_MESSAGE_CHARACTERS) }).strict(),
  z.object({ ...base, type: z.literal('ready') }).strict()
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export const GuestSummarySchema = z.object({
  guestId: id,
  name: z.string().trim().min(1).max(40),
  state: GuestStateSchema,
  comparisonCode: z.string().regex(/^\d{6}$/)
}).strict();

export const IceServerSchema = z.object({
  urls: z.union([z.string().url(), z.array(z.string().url()).min(1)]),
  username: z.string().optional(),
  credential: z.string().optional()
}).strict();

export const ErrorCodeSchema = z.enum([
  'UNAUTHORIZED', 'INVALID_MESSAGE', 'SESSION_ENDED', 'INVITE_EXPIRED',
  'SESSION_FULL', 'RATE_LIMITED', 'CONTROL_UNAVAILABLE', 'CONNECTION_FAILED'
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('snapshot'), sessionId: id, state: SessionStateSchema, expiresAt: z.number().int().positive(), guests: z.array(GuestSummarySchema), controllerGuestId: id.nullable(), controlEpoch: z.number().int().nonnegative() }).strict(),
  z.object({ ...base, type: z.literal('pending-guest'), guestId: id, name: z.string().min(1).max(40), comparisonCode: z.string().regex(/^\d{6}$/) }).strict(),
  z.object({ ...base, type: z.literal('approved'), guestId: id }).strict(),
  z.object({ ...base, type: z.literal('rejected') }).strict(),
  z.object({ ...base, type: z.literal('removed') }).strict(),
  z.object({ ...base, type: z.literal('request-control'), guestId: id }).strict(),
  z.object({ ...base, type: z.literal('ready'), guestId: id }).strict(),
  z.object({ ...base, type: z.literal('guest-message'), guestId: id, name: z.string().min(1).max(40), text: z.string().min(1).max(MAX_GUEST_MESSAGE_CHARACTERS), at: z.number().int().positive() }).strict(),
  z.object({ ...base, type: z.literal('control-state'), controllerGuestId: id.nullable(), controlEpoch: z.number().int().nonnegative() }).strict(),
  z.object({ ...base, type: z.literal('invite'), url: z.string().url(), expiresAt: z.number().int().positive() }).strict(),
  z.object({ ...base, type: z.literal('signal'), ...signalFields }).strict(),
  z.object({ ...base, type: z.literal('ice-servers'), guestId: id, iceServers: z.array(IceServerSchema), expiresAt: z.number().int().nonnegative(), diagnostic: z.string().max(256).optional() }).strict(),
  z.object({ ...base, type: z.literal('ended'), reason: z.string().min(1).max(256) }).strict(),
  z.object({ ...base, type: z.literal('error'), code: ErrorCodeSchema }).strict()
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

export const InputEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pointer'), phase: z.enum(['move', 'down', 'up']), u: finite.min(0).max(1), v: finite.min(0).max(1), button: z.literal('left'), clickCount: z.union([z.literal(1), z.literal(2)]) }).strict(),
  z.object({ type: z.literal('wheel'), u: finite.min(0).max(1), v: finite.min(0).max(1), deltaX: finite.min(-2000).max(2000), deltaY: finite.min(-2000).max(2000) }).strict(),
  z.object({ type: z.literal('key'), phase: z.enum(['down', 'up']), key: z.string().min(1).max(32), code: z.string().min(1).max(32), shift: z.boolean(), repeat: z.boolean() }).strict(),
  z.object({ type: z.literal('text'), text: z.string().refine((value) => new TextEncoder().encode(value).byteLength <= 4096) }).strict(),
  z.object({ type: z.literal('copy'), requestId: z.number().int().positive() }).strict(),
  z.object({ type: z.literal('select-all') }).strict(),
  z.object({ type: z.literal('context-click'), u: finite.min(0).max(1), v: finite.min(0).max(1) }).strict(),
  z.object({ type: z.literal('release') }).strict()
]);

export const InputEnvelopeSchema = z.object({
  v: z.literal(1),
  sessionId: id,
  controlEpoch: z.number().int().nonnegative(),
  seq: z.number().int().positive(),
  viewportEpoch: z.number().int().nonnegative(),
  event: InputEventSchema
}).strict();
export type InputEnvelope = z.infer<typeof InputEnvelopeSchema>;

export const ViewportMessageSchema = z.object({
  type: z.literal('viewport'), viewportEpoch: z.number().int().nonnegative(), width: finite.positive(), height: finite.positive(), controlEpoch: z.number().int().nonnegative(), paused: z.string().optional()
}).strict();
export type ViewportMessage = z.infer<typeof ViewportMessageSchema>;

export const ClipboardMessageSchema = z.object({
  type: z.literal('clipboard'), requestId: z.number().int().positive(), text: z.string().max(MAX_CLIPBOARD_CHARACTERS), truncated: z.boolean()
}).strict();
export type ClipboardMessage = z.infer<typeof ClipboardMessageSchema>;

export const MetaMessageSchema = z.object({
  type: z.literal('meta'), title: z.string().max(300), origin: z.string().max(300)
}).strict();
export type MetaMessage = z.infer<typeof MetaMessageSchema>;

export const HostChannelMessageSchema = z.discriminatedUnion('type', [ViewportMessageSchema, ClipboardMessageSchema, MetaMessageSchema]);
export type HostChannelMessage = z.infer<typeof HostChannelMessageSchema>;

export const JoinRequestSchema = z.object({ inviteToken: token, name: z.string().trim().min(1).max(40) }).strict();
export const CreateSessionResponseSchema = z.object({ sessionId: id, hostToken: token, inviteUrl: z.string().url(), expiresAt: z.number().int().positive(), inviteExpiresAt: z.number().int().positive() }).strict();
export const JoinResponseSchema = z.object({ guestId: id, guestToken: token, comparisonCode: z.string().regex(/^\d{6}$/) }).strict();

export function parseSocketMessage(data: string): ClientMessage {
  if (Buffer.byteLength(data, 'utf8') > 65_536) throw new Error('message too large');
  return ClientMessageSchema.parse(JSON.parse(data));
}
