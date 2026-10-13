import { ServerMessageSchema, type InputEnvelope, type ServerMessage } from '@tab-share/protocol';
import { captureTabStream } from './capture';
import { HostPeers } from './peers';

let stream: MediaStream | undefined;
let peers: HostPeers | undefined;
let socket: WebSocket | undefined;
let guestIdForIce: string | undefined;
let lastHeartbeat = Date.now();

function send(value: object): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

function stop(): void {
  peers?.close();
  peers = undefined;
  for (const track of stream?.getTracks() ?? []) track.stop();
  stream = undefined;
  socket?.close();
  socket = undefined;
  guestIdForIce = undefined;
}

function toRtcIceServers(servers: { urls: string | string[]; username?: string | undefined; credential?: string | undefined }[]): RTCIceServer[] {
  return servers.map((server) => (server.username === undefined ? { urls: server.urls } : { urls: server.urls, username: server.username, credential: server.credential ?? '' }));
}

function toIceCandidate(payload: { candidate: string; sdpMid?: string | null | undefined; sdpMLineIndex?: number | null | undefined; usernameFragment?: string | null | undefined } | null): RTCIceCandidateInit | null {
  if (payload === null) return null;
  return {
    candidate: payload.candidate,
    ...(payload.sdpMid !== undefined ? { sdpMid: payload.sdpMid } : {}),
    ...(payload.sdpMLineIndex !== undefined ? { sdpMLineIndex: payload.sdpMLineIndex } : {}),
    ...(payload.usernameFragment !== undefined ? { usernameFragment: payload.usernameFragment } : {})
  };
}

async function handle(message: ServerMessage): Promise<void> {
  if (message.type === 'ready') {
    // The guest is approved and its socket is reachable. Build the peer here rather than on
    // approval, because an offer sent before the guest connected is dropped and never retried.
    peers?.remove(message.guestId);
    guestIdForIce = message.guestId;
    send({ v: 1, type: 'turn-credentials', guestId: message.guestId });
  } else if (message.type === 'ice-servers') {
    if (message.guestId !== guestIdForIce) return;
    if (peers?.has(message.guestId)) return;
    await peers?.create(message.guestId, toRtcIceServers(message.iceServers));
  } else if (message.type === 'signal') {
    if (message.kind === 'answer' && typeof message.payload === 'string') {
      await peers?.answer(message.guestId, message.negotiationId, message.payload);
    } else if (message.kind === 'ice' && typeof message.payload !== 'string') {
      await peers?.ice(message.guestId, message.negotiationId, toIceCandidate(message.payload));
    }
  } else if (message.type === 'ended') {
    stop();
  }
}

async function startCapture(message: { streamId: string; wsUrl: string; sessionId: string; hostToken: string }): Promise<void> {
  stream = await captureTabStream(message.streamId);
  peers = new HostPeers(stream, {
    signal(guestId, kind, negotiationId, payload) {
      send({ v: 1, type: 'signal', guestId, kind, negotiationId, payload });
    },
    input(guestId, value: InputEnvelope) {
      void chrome.runtime.sendMessage({ type: 'peer-input', guestId, value });
    },
    opened(guestId) {
      void chrome.runtime.sendMessage({ type: 'peer-opened', guestId });
    },
    failed(guestId) {
      peers?.remove(guestId);
      void chrome.runtime.sendMessage({ type: 'peer-failed', guestId });
    }
  });
  stream.getVideoTracks()[0]?.addEventListener('ended', () => void chrome.runtime.sendMessage({ type: 'capture-ended' }));

  socket = new WebSocket(message.wsUrl);
  socket.onopen = () => send({ v: 1, type: 'auth', role: 'host', sessionId: message.sessionId, token: message.hostToken });
  socket.onmessage = (event) => {
    const parsed = ServerMessageSchema.safeParse(JSON.parse(String(event.data)));
    if (!parsed.success) return;
    void handle(parsed.data);
    void chrome.runtime.sendMessage({ type: 'server-message', value: parsed.data });
  };
  socket.onclose = () => void chrome.runtime.sendMessage({ type: 'signaling-lost' });
}

chrome.runtime.onMessage.addListener((raw, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  const message = raw as { type?: string; streamId?: string; wsUrl?: string; sessionId?: string; hostToken?: string; guestId?: string; value?: object };

  if (message.type === 'heartbeat') {
    lastHeartbeat = Date.now();
    respond(true);
    return false;
  }
  if (message.type === 'socket-command' && message.value) {
    send(message.value);
    respond(true);
    return false;
  }
  if (message.type === 'peer-message' && message.guestId && message.value) {
    respond(peers?.send(message.guestId, message.value) ?? false);
    return false;
  }
  if (message.type === 'peer-remove' && message.guestId) {
    peers?.remove(message.guestId);
    respond(true);
    return false;
  }
  if (message.type === 'stop-capture') {
    stop();
    respond(true);
    return false;
  }
  if (message.type === 'start-capture' && message.streamId && message.wsUrl && message.sessionId && message.hostToken) {
    void startCapture({ streamId: message.streamId, wsUrl: message.wsUrl, sessionId: message.sessionId, hostToken: message.hostToken })
      .then(() => respond(true))
      .catch((error: unknown) => respond({ error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  return false;
});

setInterval(() => {
  if (Date.now() - lastHeartbeat > 15_000) {
    stop();
    void chrome.runtime.sendMessage({ type: 'offscreen-timeout' });
  }
}, 5_000);
