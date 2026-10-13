import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { GuestState } from '@tab-share/protocol';

export interface Guest {
  id: string;
  tokenDigest: Buffer;
  name: string;
  comparisonCode: string;
  state: GuestState;
  createdAt: number;
}
export interface Session {
  id: string;
  hostTokenDigest: Buffer;
  inviteTokenDigest: Buffer;
  inviteExpiresAt: number;
  expiresAt: number;
  state: 'starting' | 'live' | 'stopping' | 'ended';
  guests: Map<string, Guest>;
  controllerGuestId: string | null;
  controlEpoch: number;
}
export interface Limits { maxGuests: number; maxSessions: number; sessionTtlMs: number; inviteTtlMs: number }
export const opaque = (bytes = 16): string => randomBytes(bytes).toString('base64url');
const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
const equals = (stored: Buffer, value: string): boolean => {
  const candidate = digest(value);
  return stored.length === candidate.length && timingSafeEqual(stored, candidate);
};

export class SessionStore {
  readonly sessions = new Map<string, Session>();
  constructor(private readonly limits: Limits, private readonly publicOrigin: string) {}

  create(now = Date.now()) {
    this.expire(now);
    if (this.sessions.size >= this.limits.maxSessions) throw new SessionError('SESSION_FULL');
    const sessionId = opaque();
    const hostToken = opaque(32);
    const inviteToken = opaque(32);
    const session: Session = { id: sessionId, hostTokenDigest: digest(hostToken), inviteTokenDigest: digest(inviteToken), inviteExpiresAt: now + this.limits.inviteTtlMs, expiresAt: now + this.limits.sessionTtlMs, state: 'starting', guests: new Map(), controllerGuestId: null, controlEpoch: 0 };
    this.sessions.set(sessionId, session);
    return { session, hostToken, inviteUrl: this.inviteUrl(sessionId, inviteToken), inviteToken };
  }

  join(sessionId: string, inviteToken: string, name: string, now = Date.now()) {
    const session = this.requireLiveSession(sessionId, now);
    this.expirePending(session, now);
    if (now > session.inviteExpiresAt || !equals(session.inviteTokenDigest, inviteToken)) throw new SessionError('INVITE_EXPIRED');
    if ([...session.guests.values()].filter((guest) => guest.state === 'pending').length >= 8) throw new SessionError('RATE_LIMITED');
    const guestId = opaque();
    const guestToken = opaque(32);
    const guest: Guest = { id: guestId, tokenDigest: digest(guestToken), name: name.trim(), comparisonCode: randomBytes(4).readUInt32BE(0).toString().slice(-6).padStart(6, '0'), state: 'pending', createdAt: now };
    session.guests.set(guestId, guest);
    return { session, guest, guestToken };
  }

  authenticateHost(sessionId: string, token: string, now = Date.now()): Session | null {
    const session = this.sessions.get(sessionId);
    return session && session.state !== 'ended' && session.expiresAt > now && equals(session.hostTokenDigest, token) ? session : null;
  }
  authenticateGuest(sessionId: string, token: string, now = Date.now()): { session: Session; guest: Guest } | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.state === 'ended' || session.expiresAt <= now) return null;
    const guest = [...session.guests.values()].find((value) => equals(value.tokenDigest, token));
    return guest ? { session, guest } : null;
  }
  approve(session: Session, guestId: string): Guest {
    const guest = session.guests.get(guestId);
    if (!guest || guest.state !== 'pending') throw new SessionError('UNAUTHORIZED');
    if ([...session.guests.values()].filter((value) => value.state === 'approved').length >= this.limits.maxGuests) throw new SessionError('SESSION_FULL');
    guest.state = 'approved'; session.state = 'live'; return guest;
  }
  remove(session: Session, guestId: string, state: 'rejected' | 'approved' = 'rejected'): Guest | undefined {
    const guest = session.guests.get(guestId);
    if (!guest) return undefined;
    guest.state = state;
    session.guests.delete(guestId);
    if (session.controllerGuestId === guestId) this.revoke(session);
    return guest;
  }
  grant(session: Session, guestId: string): void {
    const guest = session.guests.get(guestId);
    if (!guest || guest.state !== 'approved') throw new SessionError('CONTROL_UNAVAILABLE');
    session.controllerGuestId = guestId; session.controlEpoch += 1;
  }
  revoke(session: Session): void { session.controllerGuestId = null; session.controlEpoch += 1; }
  rotate(session: Session, now = Date.now()) {
    for (const guest of [...session.guests.values()]) if (guest.state === 'pending') session.guests.delete(guest.id);
    const inviteToken = opaque(32); session.inviteTokenDigest = digest(inviteToken); session.inviteExpiresAt = now + this.limits.inviteTtlMs;
    return { inviteToken, inviteUrl: this.inviteUrl(session.id, inviteToken) };
  }
  end(session: Session): void { session.state = 'ended'; session.controllerGuestId = null; session.controlEpoch += 1; this.sessions.delete(session.id); }
  expire(now = Date.now()): void { for (const session of this.sessions.values()) if (session.expiresAt <= now) this.end(session); }
  expirePending(session: Session, now = Date.now()): void { for (const guest of session.guests.values()) if (guest.state === 'pending' && now - guest.createdAt > 120_000) session.guests.delete(guest.id); }
  private requireLiveSession(id: string, now: number): Session { const session = this.sessions.get(id); if (!session || session.state === 'ended') throw new SessionError('SESSION_ENDED'); if (session.expiresAt <= now) { this.end(session); throw new SessionError('SESSION_ENDED'); } return session; }
  private inviteUrl(id: string, token: string): string { return `${this.publicOrigin}/join/${id}#invite=${token}`; }
}
export class SessionError extends Error { constructor(readonly code: 'UNAUTHORIZED'|'INVALID_MESSAGE'|'SESSION_ENDED'|'INVITE_EXPIRED'|'SESSION_FULL'|'RATE_LIMITED'|'CONTROL_UNAVAILABLE'|'CONNECTION_FAILED') { super(code); } }
