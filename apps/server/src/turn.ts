import { createHmac, randomBytes } from 'node:crypto';
import type { ServerMessage } from '@tab-share/protocol';

export interface TurnConfig { host?: string; secret?: string; tlsPort: number; development: boolean }
export function createIceServers(config: TurnConfig, peerId: string, now = Date.now()): Extract<ServerMessage, {type:'ice-servers'}> {
  if (!config.host || !config.secret) {
    if (!config.development) throw new Error('TURN configuration is required');
    return { v: 1, type: 'ice-servers', guestId: peerId, iceServers: [], expiresAt: 0, diagnostic: 'Local-only development: TURN is not configured.' };
  }
  const expiresAt = now + 600_000;
  const username = `${Math.floor(expiresAt / 1000)}:${randomBytes(12).toString('base64url')}`;
  const credential = createHmac('sha1', config.secret).update(username).digest('base64');
  const urls = [
    `stun:${config.host}:3478`,
    `turn:${config.host}:3478?transport=udp`,
    `turn:${config.host}:3478?transport=tcp`,
    `turns:${config.host}:${config.tlsPort}?transport=tcp`
  ];
  return { v: 1, type: 'ice-servers', guestId: peerId, iceServers: [{ urls, username, credential }], expiresAt };
}
