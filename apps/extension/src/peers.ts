import { InputEnvelopeSchema, type InputEnvelope } from '@tab-share/protocol';

export interface PeerCallbacks {
  signal(guestId: string, kind: 'offer' | 'ice', negotiationId: string, payload: string | RTCIceCandidateInit | null): void;
  input(guestId: string, value: InputEnvelope): void;
  opened(guestId: string): void;
  failed(guestId: string): void;
}

interface Pair {
  pc: RTCPeerConnection;
  channel: RTCDataChannel;
  negotiationId: string;
  candidates: RTCIceCandidateInit[];
}

const OUTBOUND_LIMIT_BYTES = 262_144;

const randomId = (): string => Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) => value.toString(16).padStart(2, '0')).join('');

export class HostPeers {
  private readonly pairs = new Map<string, Pair>();

  constructor(private readonly stream: MediaStream, private readonly callbacks: PeerCallbacks) {}

  async create(guestId: string, iceServers: RTCIceServer[]): Promise<void> {
    this.remove(guestId);
    const pc = new RTCPeerConnection({ iceServers });
    const channel = pc.createDataChannel('input-v1', { ordered: true });
    const negotiationId = randomId();
    const pair: Pair = { pc, channel, negotiationId, candidates: [] };
    this.pairs.set(guestId, pair);
    for (const track of this.stream.getVideoTracks()) {
      const sender = pc.addTrack(track, this.stream);
      const settings = track.getSettings();
      const nativeWidth = Number(settings.width ?? 0);
      // An integer divisor is aspect-preserving, unlike capture-side fitting.
      const scaleResolutionDownBy = nativeWidth > 1920 ? Math.ceil(nativeWidth / 1920) : 1;
      const parameters = sender.getParameters();
      parameters.encodings = [{ ...parameters.encodings?.[0], maxBitrate: 2_500_000, scaleResolutionDownBy }];
      // Shared tab content is text, so the encoder must shed frames rather than pixels.
      parameters.degradationPreference = 'maintain-resolution';
      await sender.setParameters(parameters);
    }
    channel.onopen = () => this.callbacks.opened(guestId);
    channel.onmessage = (event) => {
      if (typeof event.data !== 'string' || new TextEncoder().encode(event.data).byteLength > 8192) return;
      const parsed = InputEnvelopeSchema.safeParse(JSON.parse(event.data));
      if (parsed.success) this.callbacks.input(guestId, parsed.data);
    };
    channel.onclose = () => this.callbacks.failed(guestId);
    pc.onicecandidate = (event) => this.callbacks.signal(guestId, 'ice', negotiationId, event.candidate?.toJSON() ?? null);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') this.callbacks.failed(guestId);
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.callbacks.signal(guestId, 'offer', negotiationId, offer.sdp ?? '');
    setTimeout(() => {
      if (pc.connectionState !== 'connected') this.callbacks.failed(guestId);
    }, 20_000);
  }

  async answer(guestId: string, negotiationId: string, sdp: string): Promise<void> {
    const pair = this.pairs.get(guestId);
    if (!pair || pair.negotiationId !== negotiationId) return;
    await pair.pc.setRemoteDescription({ type: 'answer', sdp });
    for (const candidate of pair.candidates.splice(0)) await pair.pc.addIceCandidate(candidate);
  }

  async ice(guestId: string, negotiationId: string, candidate: RTCIceCandidateInit | null): Promise<void> {
    const pair = this.pairs.get(guestId);
    if (!pair || pair.negotiationId !== negotiationId || !candidate) return;
    if (!pair.pc.remoteDescription) pair.candidates.push(candidate);
    else await pair.pc.addIceCandidate(candidate);
  }

  has(guestId: string): boolean {
    return this.pairs.has(guestId);
  }

  send(guestId: string, value: object): boolean {
    const channel = this.pairs.get(guestId)?.channel;
    if (!channel || channel.readyState !== 'open' || channel.bufferedAmount > OUTBOUND_LIMIT_BYTES) return false;
    channel.send(JSON.stringify(value));
    return true;
  }

  remove(guestId: string): void {
    const pair = this.pairs.get(guestId);
    pair?.channel.close();
    pair?.pc.close();
    this.pairs.delete(guestId);
  }

  close(): void {
    for (const guestId of [...this.pairs.keys()]) this.remove(guestId);
  }
}
