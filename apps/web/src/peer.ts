import { HostChannelMessageSchema, InputEnvelopeSchema, type ClipboardMessage, type InputEnvelope, type MetaMessage, type ViewportMessage } from '@tab-share/protocol';

export interface GuestPeerState {
  connection: string;
  ice: string;
  channel: boolean;
}

export interface GuestPeerCallbacks {
  onStream(stream: MediaStream): void;
  onSignal(kind: 'answer' | 'ice', negotiationId: string, payload: string | RTCIceCandidateInit | null): void;
  onViewport(value: ViewportMessage): void;
  onClipboard(value: ClipboardMessage): void;
  onMeta(value: MetaMessage): void;
  onState(value: GuestPeerState): void;
  onFailure(message: string): void;
}

export class GuestPeer {
  private connection: RTCPeerConnection | undefined;
  private channel: RTCDataChannel | undefined;
  private negotiationId = '';
  private candidates: RTCIceCandidateInit[] = [];
  private seq = 0;
  private sessionId = '';
  private controlEpoch = 0;
  private viewportEpoch = 0;
  private setupTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly callbacks: GuestPeerCallbacks) {}

  private reportState(): void {
    this.callbacks.onState({
      connection: this.connection?.connectionState ?? 'closed',
      ice: this.connection?.iceConnectionState ?? 'closed',
      channel: this.channel?.readyState === 'open'
    });
  }

  async acceptOffer(sessionId: string, negotiationId: string, sdp: string, iceServers: RTCIceServer[]): Promise<void> {
    this.close();
    this.sessionId = sessionId;
    this.negotiationId = negotiationId;
    const pc = new RTCPeerConnection({ iceServers });
    this.connection = pc;
    pc.ontrack = (event) => this.callbacks.onStream(event.streams[0] ?? new MediaStream([event.track]));
    pc.ondatachannel = (event) => {
      if (event.channel.label !== 'input-v1') {
        event.channel.close();
        return;
      }
      this.channel = event.channel;
      event.channel.onopen = () => this.reportState();
      event.channel.onclose = () => this.reportState();
      event.channel.onmessage = (message) => this.handleChannelMessage(String(message.data));
    };
    pc.onicecandidate = (event) => this.callbacks.onSignal('ice', negotiationId, event.candidate?.toJSON() ?? null);
    pc.onconnectionstatechange = () => {
      this.reportState();
      if (pc.connectionState === 'failed') this.callbacks.onFailure('Connection failed. Rejoin with a fresh invitation.');
    };
    pc.oniceconnectionstatechange = () => this.reportState();

    await pc.setRemoteDescription({ type: 'offer', sdp });
    for (const candidate of this.candidates.splice(0)) await pc.addIceCandidate(candidate);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.callbacks.onSignal('answer', negotiationId, answer.sdp ?? '');

    clearTimeout(this.setupTimer);
    this.setupTimer = setTimeout(() => {
      if (pc.connectionState !== 'connected') this.callbacks.onFailure('Media setup timed out. Rejoin with a fresh invitation.');
    }, 20_000);
  }

  private handleChannelMessage(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      this.callbacks.onFailure('The host sent an unreadable message.');
      return;
    }
    const message = HostChannelMessageSchema.safeParse(parsed);
    if (!message.success) {
      this.callbacks.onFailure('The host sent invalid session metadata.');
      return;
    }
    const value = message.data;
    if (value.type === 'viewport') {
      this.controlEpoch = value.controlEpoch;
      this.viewportEpoch = value.viewportEpoch;
      this.callbacks.onViewport(value);
    } else if (value.type === 'clipboard') {
      this.callbacks.onClipboard(value);
    } else {
      this.callbacks.onMeta(value);
    }
  }

  async addIce(negotiationId: string, candidate: RTCIceCandidateInit | null): Promise<void> {
    if (negotiationId !== this.negotiationId || !candidate) return;
    if (!this.connection?.remoteDescription) this.candidates.push(candidate);
    else await this.connection.addIceCandidate(candidate);
  }

  canSend(): boolean {
    return this.channel?.readyState === 'open' && this.channel.bufferedAmount <= 65_536;
  }

  send(event: InputEnvelope['event']): boolean {
    if (!this.canSend() || !this.channel) return false;
    const envelope = InputEnvelopeSchema.parse({ v: 1, sessionId: this.sessionId, controlEpoch: this.controlEpoch, seq: ++this.seq, viewportEpoch: this.viewportEpoch, event });
    const text = JSON.stringify(envelope);
    if (new TextEncoder().encode(text).byteLength > 8192) return false;
    this.channel.send(text);
    return true;
  }

  close(): void {
    clearTimeout(this.setupTimer);
    this.channel?.close();
    this.connection?.close();
    this.channel = undefined;
    this.connection = undefined;
    this.candidates = [];
    this.seq = 0;
  }
}
