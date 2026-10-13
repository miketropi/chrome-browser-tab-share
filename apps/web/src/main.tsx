import { StrictMode, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MAX_GUEST_MESSAGE_CHARACTERS, ServerMessageSchema, type ClipboardMessage, type MetaMessage, type ServerMessage, type ViewportMessage } from '@tab-share/protocol';
import { containRect, normalizePoint, type Box } from './geometry';
import { GuestPeer } from './peer';
import './styles.css';

type Phase = 'invite' | 'waiting' | 'connecting' | 'live' | 'ended';
type TouchMode = 'scroll' | 'drag';

interface Gesture {
  pointerId: number | null;
  touching: boolean;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  moved: boolean;
  scrolled: boolean;
}

const EMPTY_GESTURE: Gesture = { pointerId: null, touching: false, startX: 0, startY: 0, lastX: 0, lastY: 0, moved: false, scrolled: false };
const EMPTY_BOX: Box = { left: 0, top: 0, width: 0, height: 0 };
const SCROLL_THRESHOLD = 6;
const KEY_BUTTONS = ['Tab', 'Enter', 'Backspace', 'Escape', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'ArrowRight'];

function inviteTokenFromHash(): string {
  return new URLSearchParams(location.hash.slice(1)).get('invite') ?? '';
}

function isTouchDevice(): boolean {
  return typeof window !== 'undefined' && (navigator.maxTouchPoints > 0 || window.matchMedia('(pointer: coarse)').matches);
}

function App() {
  const sessionId = location.pathname.split('/').filter(Boolean).at(-1) ?? '';
  const [invite] = useState(inviteTokenFromHash);
  const [name, setName] = useState('');
  const [phase, setPhase] = useState<Phase>('invite');
  const [message, setMessage] = useState('Enter a display name to request access.');
  const [code, setCode] = useState('');
  const [guestId, setGuestId] = useState('');
  const [controller, setController] = useState<string | null>(null);
  const [meta, setMeta] = useState<MetaMessage | null>(null);
  const [viewport, setViewport] = useState<ViewportMessage | null>(null);
  const [connection, setConnection] = useState('idle');
  const [toast, setToast] = useState('');
  const [fallbackText, setFallbackText] = useState('');
  const [mode, setMode] = useState<TouchMode>('scroll');
  const [menuOpen, setMenuOpen] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [stageBox, setStageBox] = useState<Box>(EMPTY_BOX);
  const [videoAspect, setVideoAspect] = useState<number | null>(null);
  const touchDevice = useMemo(isTouchDevice, []);

  const socket = useRef<WebSocket | undefined>(undefined);
  const video = useRef<HTMLVideoElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const guestIdRef = useRef('');
  const copyRequestId = useRef(0);
  const iceServers = useRef<RTCIceServer[]>([]);
  const finished = useRef(false);
  const approvedOnce = useRef(false);
  const gesture = useRef<Gesture>({ ...EMPTY_GESTURE });
  const lastPoint = useRef<{ u: number; v: number } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const peer = useRef(
    new GuestPeer({
      onStream(stream) {
        if (!video.current) return;
        video.current.srcObject = stream;
        void video.current
          .play()
          .then(() => setPhase('live'))
          .catch(() => setMessage('Video playback is blocked. Select the picture to start it.'));
      },
      onSignal(kind, negotiationId, payload) {
        send({ v: 1, type: 'signal', guestId: guestIdRef.current, kind, negotiationId, payload });
      },
      onViewport: setViewport,
      onClipboard: receiveClipboard,
      onMeta: setMeta,
      onState(state) {
        setConnection(state.connection);
      },
      onFailure: end
    })
  );

  // The stage draws the video with `object-fit: contain`, so the visible frame occupies exactly
  // this rectangle. The video's own aspect is used, never the host viewport aspect: the encoder
  // may deliver any resolution or rounding, and forcing the frame into the host ratio stretches it.
  const sourceAspect = videoAspect ?? (viewport ? viewport.width / viewport.height : null);
  const displayRect = useMemo(
    () => (sourceAspect && stageBox.width > 0 ? containRect(stageBox, sourceAspect) : null),
    [sourceAspect, stageBox]
  );

  // If the frame and the reported viewport disagree, the picture no longer corresponds to the
  // input space and clicks drift. Surface it instead of failing silently.
  const frameMismatch = Boolean(
    videoAspect && viewport && Math.abs(videoAspect - viewport.width / viewport.height) / (viewport.width / viewport.height) > 0.01
  );

  useEffect(() => {
    const element = video.current;
    if (!element) return;
    const measure = () => {
      if (element.videoWidth > 0 && element.videoHeight > 0) setVideoAspect(element.videoWidth / element.videoHeight);
    };
    measure();
    element.addEventListener('loadedmetadata', measure);
    element.addEventListener('resize', measure);
    return () => {
      element.removeEventListener('loadedmetadata', measure);
      element.removeEventListener('resize', measure);
    };
  }, [phase]);

  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setStageBox({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [phase]);

  function notify(text: string): void {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 6_000);
  }

  function receiveClipboard(value: ClipboardMessage): void {
    if (value.requestId !== copyRequestId.current) return;
    if (!value.text) {
      notify('Nothing selected in the shared tab. Drag over text there first.');
      return;
    }
    void navigator.clipboard
      .writeText(value.text)
      .then(() => notify(value.truncated ? `Copied first ${value.text.length.toLocaleString()} characters.` : `Copied ${value.text.length.toLocaleString()} characters.`))
      .catch(() => {
        setFallbackText(value.text);
        setMenuOpen(true);
        notify('Automatic copy blocked. Use the copy panel.');
      });
  }

  function send(value: object): void {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(value));
  }

  function end(reason: string): void {
    finished.current = true;
    peer.current.close();
    if (video.current) video.current.srcObject = null;
    setPhase('ended');
    setMessage(reason);
  }

  async function join(): Promise<void> {
    if (!name.trim()) {
      setMessage('Enter a display name before requesting access.');
      return;
    }
    if (!invite) {
      setMessage('No invitation token in this link. Open the complete host link including #invite=…, or rescan the QR code.');
      return;
    }
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inviteToken: invite, name })
      });
      const data = (await response.json()) as { guestId?: string; guestToken?: string; comparisonCode?: string; error?: string };
      if (!response.ok || !data.guestId || !data.guestToken) {
        throw new Error(data.error === 'INVITE_EXPIRED' ? 'Invitation expired or replaced. Ask the host for a new one.' : (data.error ?? 'Request failed'));
      }
      guestIdRef.current = data.guestId;
      setGuestId(data.guestId);
      setCode(data.comparisonCode ?? '');
      setPhase('waiting');
      setMessage('Awaiting host approval.');

      const connectionSocket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      socket.current = connectionSocket;
      connectionSocket.onopen = () => connectionSocket.send(JSON.stringify({ v: 1, type: 'auth', role: 'guest', sessionId, token: data.guestToken }));
      connectionSocket.onmessage = (event) => {
        const parsed = ServerMessageSchema.safeParse(JSON.parse(String(event.data)));
        if (parsed.success) handle(parsed.data);
      };
      connectionSocket.onclose = () => {
        if (!finished.current) end('Link lost. Open the invitation again to rejoin.');
      };
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Request failed');
    }
  }

  function approveOnce(id: string): void {
    if (approvedOnce.current || finished.current) return;
    approvedOnce.current = true;
    setPhase('connecting');
    setMessage('Approved. Negotiating media…');
    send({ v: 1, type: 'turn-credentials', guestId: id });
    // Tells the host this socket is reachable, so it offers now rather than earlier.
    send({ v: 1, type: 'ready' });
  }

  function handle(value: ServerMessage): void {
    if (value.type === 'snapshot') {
      const own = value.guests.find((guest) => guest.guestId === guestIdRef.current);
      if (own?.state === 'approved') approveOnce(own.guestId);
      setController(value.controllerGuestId);
      if (value.state === 'ended') end('Host ended the session.');
      return;
    }
    if (value.type === 'approved') {
      approveOnce(value.guestId);
    } else if (value.type === 'ice-servers') {
      iceServers.current = value.iceServers.map((server) =>
        server.username === undefined ? { urls: server.urls } : { urls: server.urls, username: server.username, credential: server.credential ?? '' }
      );
    } else if (value.type === 'signal' && value.guestId === guestIdRef.current) {
      if (value.kind === 'offer' && typeof value.payload === 'string') {
        void peer.current.acceptOffer(sessionId, value.negotiationId, value.payload, iceServers.current);
      } else if (value.kind === 'ice' && typeof value.payload !== 'string') {
        const candidate =
          value.payload === null
            ? null
            : {
                candidate: value.payload.candidate,
                ...(value.payload.sdpMid !== undefined ? { sdpMid: value.payload.sdpMid } : {}),
                ...(value.payload.sdpMLineIndex !== undefined ? { sdpMLineIndex: value.payload.sdpMLineIndex } : {}),
                ...(value.payload.usernameFragment !== undefined ? { usernameFragment: value.payload.usernameFragment } : {})
              };
        void peer.current.addIce(value.negotiationId, candidate);
      }
    } else if (value.type === 'control-state') {
      setController(value.controllerGuestId);
    } else if (value.type === 'rejected') {
      end('Host rejected the request. Obtain a new invitation to retry.');
    } else if (value.type === 'removed') {
      end('Host removed you from the session.');
    } else if (value.type === 'ended') {
      end(value.reason);
    } else if (value.type === 'error') {
      notify(value.code === 'RATE_LIMITED' ? 'RATE LIMITED. WAIT A MOMENT.' : value.code);
    }
  }

  function leave(): void {
    peer.current.send({ type: 'release' });
    peer.current.close();
    socket.current?.close();
    if (video.current) video.current.srcObject = null;
  }

  useEffect(() => {
    if (invite) history.replaceState(null, '', location.pathname + location.search);
    return () => {
      clearTimeout(toastTimer.current);
      leave();
    };
  }, []);

  const isController = guestId !== '' && controller === guestId;
  const live = phase === 'live';
  // The server accepts guest messages from approved guests, so the composer appears as soon as
  // approval lands rather than waiting for media — a failed negotiation is a reportable problem.
  const canMessage = phase === 'connecting' || phase === 'live';

  function pointerAt(clientX: number, clientY: number, pointerPhase: 'move' | 'down' | 'up'): void {
    if (!isController) {
      notify('View only. Request control to interact.');
      return;
    }
    if (!displayRect) return;
    const point = normalizePoint(displayRect, clientX, clientY);
    if (!point) return;
    lastPoint.current = point;
    peer.current.send({ type: 'pointer', phase: pointerPhase, u: point.u, v: point.v, button: 'left', clickCount: 1 });
  }

  function wheelAt(clientX: number, clientY: number, deltaX: number, deltaY: number): void {
    if (!displayRect) return;
    const point = normalizePoint(displayRect, clientX, clientY);
    if (!point) return;
    peer.current.send({
      type: 'wheel',
      u: point.u,
      v: point.v,
      deltaX: Math.max(-2000, Math.min(2000, deltaX)),
      deltaY: Math.max(-2000, Math.min(2000, deltaY))
    });
  }

  function requestControl(): void {
    send({ v: 1, type: 'request-control' });
    notify('Control requested. Waiting for the host.');
  }

  function openContextMenu(point?: { u: number; v: number } | null): void {
    const target = point ?? lastPoint.current;
    if (!isController) {
      notify('View only. Request control to interact.');
      return;
    }
    if (!target) {
      notify('Point at the shared tab first, then open the context menu.');
      return;
    }
    peer.current.send({ type: 'context-click', u: target.u, v: target.v });
    notify("Context menu opened on the host's screen.");
  }

  function requestCopy(): void {
    if (!isController) {
      notify('Request control before copying.');
      return;
    }
    copyRequestId.current += 1;
    if (!peer.current.send({ type: 'copy', requestId: copyRequestId.current })) notify('Copy unavailable while the link is busy.');
  }

  function sendMessage(): void {
    const text = draft.trim();
    if (!text) return;
    send({ v: 1, type: 'guest-message', text });
    setDraft('');
    notify('Message sent to the host.');
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>): void {
    event.currentTarget.setPointerCapture(event.pointerId);
    const touching = event.pointerType === 'touch';
    gesture.current = { pointerId: event.pointerId, touching, startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY, moved: false, scrolled: false };
    if (touching && mode === 'scroll') return;
    event.preventDefault();
    pointerAt(event.clientX, event.clientY, 'down');
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>): void {
    const current = gesture.current;
    if (current.pointerId !== event.pointerId) return;
    if (current.touching && mode === 'scroll') {
      if (!current.scrolled) {
        if (Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < SCROLL_THRESHOLD) return;
        current.scrolled = true;
        current.moved = true;
      }
      const deltaX = event.clientX - current.lastX;
      const deltaY = event.clientY - current.lastY;
      current.lastX = event.clientX;
      current.lastY = event.clientY;
      if (isController) wheelAt(event.clientX, event.clientY, -deltaX, -deltaY);
      return;
    }
    if (event.buttons !== 1) return;
    if (current.touching && mode !== 'drag') return;
    current.moved = true;
    pointerAt(event.clientX, event.clientY, 'move');
  }

  function onPointerUp(event: React.PointerEvent<HTMLDivElement>): void {
    const current = gesture.current;
    if (current.pointerId !== event.pointerId) return;
    gesture.current = { ...EMPTY_GESTURE };
    if (current.touching && mode === 'scroll') {
      if (!current.moved) {
        pointerAt(event.clientX, event.clientY, 'down');
        pointerAt(event.clientX, event.clientY, 'up');
      }
      return;
    }
    if (isController && displayRect) lastPoint.current = normalizePoint(displayRect, event.clientX, event.clientY);
    pointerAt(event.clientX, event.clientY, 'up');
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === 'c') {
      event.preventDefault();
      requestCopy();
    } else if (key === 'a') {
      event.preventDefault();
      if (!isController) {
        notify('Request control before selecting all.');
        return;
      }
      peer.current.send({ type: 'select-all' });
    }
  }

  function toggleFullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void (document.querySelector('main')?.requestFullscreen() ?? Promise.reject(new Error('unavailable'))).catch(() => notify('Full screen refused by this browser.'));
  }

  if (phase === 'invite') {
    return (
      <main className="crt center">
        <section className="slab">
          <h1 className="label">[ REQUEST ACCESS ]</h1>
          <p className="note">{message}</p>
          {!invite && (
            <p className="note danger">
              INVITATION TOKEN MISSING. OPEN THE COMPLETE HOST LINK INCLUDING <b>#invite=…</b>, OR RESCAN THE QR CODE.
            </p>
          )}
          <label className="field">
            <span className="label">DISPLAY NAME</span>
            <input maxLength={40} value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" />
          </label>
          <button className="primary" disabled={!name.trim()} onClick={join}>
            REQUEST ACCESS &gt;&gt;&gt;
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="crt" onKeyDown={onKeyDown} tabIndex={-1}>
      <section
        className="stage"
        ref={stage}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onContextMenu={(event) => {
          event.preventDefault();
          openContextMenu(displayRect ? normalizePoint(displayRect, event.clientX, event.clientY) : null);
        }}
        onWheel={(event) => {
          if (isController) wheelAt(event.clientX, event.clientY, event.deltaX, event.deltaY);
        }}
      >
        <video ref={video} autoPlay muted playsInline className="frame" onClick={() => void video.current?.play().catch(() => undefined)} />

        <div className="hud">
          <span className="tag">[ TAB SHARE ]</span>
          <output className="readout">
            LINK <data>{connection.toUpperCase()}</data>
          </output>
          <output className={`readout${frameMismatch ? ' alert' : ''}`}>
            SCALE{' '}
            <data>
              {viewport ? `${Math.round(viewport.width)}x${Math.round(viewport.height)}` : '----'}
              {videoAspect ? ` / ${video.current?.videoWidth ?? 0}x${video.current?.videoHeight ?? 0}` : ''}
            </data>
          </output>
          <output className={`readout${isController ? ' signal' : ''}`}>
            CONTROL <data>{isController ? 'GRANTED' : 'NONE'}</data>
          </output>
        </div>

        {!live && (
          <div className="banner">
            <h1 className="label">
              {phase === 'waiting' ? '[ AWAITING APPROVAL ]' : phase === 'connecting' ? '[ NEGOTIATING ]' : '[ SESSION ENDED ]'}
            </h1>
            <p className="note">{message}</p>
            {phase === 'waiting' && code && (
              <>
                <span className="label">COMPARISON CODE</span>
                <output className="code">{code}</output>
              </>
            )}
            {phase === 'ended' && <p className="note">CLOSE THIS WINDOW AND OPEN A FRESH INVITATION TO SHARE AGAIN.</p>}
          </div>
        )}

        {viewport?.paused && live && <p className="pause">{viewport.paused.toUpperCase()}</p>}
        {frameMismatch && live && <p className="pause">HOST SCALE MISMATCH · CLICKS MAY DRIFT. REPORT THE SCALE READOUT TO THE HOST.</p>}
      </section>

      {menuOpen && (
        <nav className="overlay sheet">
          <header className="bar">
            <span className="tag">[ SHARED TAB ]</span>
            <span className="url">{(meta?.origin ?? location.host).toUpperCase()}</span>
            <span className="badge">{(meta?.title ?? 'SHARED TAB').toUpperCase()}</span>
            <button onClick={() => setMenuOpen(false)} aria-expanded={true}>
              CLOSE
            </button>
          </header>

          <section className="stack">
            <span className="label">[ INSTRUCTIONS ]</span>
            <dl className="guide">
              <dt>CLICK / TAP</dt>
              <dd>Activate whatever sits under the pointer.</dd>
              <dt>DRAG</dt>
              <dd>Select text in the shared tab. <kbd>^C</kbd> copies the selection to your clipboard.</dd>
              <dt>RIGHT CLICK</dt>
              <dd>
                Right-click, <kbd>^</kbd>-click, or {touchDevice ? 'long-press' : 'the button below'}. The menu opens on the host&rsquo;s screen, not yours.
              </dd>
              <dt>SCROLL</dt>
              <dd>Wheel, or one finger while GESTURE is SCROLL.</dd>
              <dt>SELECT ALL</dt>
              <dd><kbd>^A</kbd> selects the focused frame&rsquo;s contents on the host.</dd>
            </dl>
          </section>

          {!isController && (
            <section className="stack">
              <span className="label">[ REQUEST ]</span>
              <p className="note">Watching is read-only until the host grants control.</p>
              <button className="primary" onClick={requestControl} disabled={!live}>
                REQUEST CONTROL
              </button>
            </section>
          )}

          {isController && touchDevice && (
            <section className="stack">
              <span className="label">[ TOUCH ACTIONS ]</span>
              <div className="grid tight">
                <button onClick={() => openContextMenu()}>RIGHT CLICK</button>
                <button onClick={requestCopy}>COPY SELECTION</button>
                <button onClick={() => peer.current.send({ type: 'select-all' })}>SELECT ALL</button>
                <button onClick={toggleFullscreen}>FULL SCREEN</button>
              </div>
            </section>
          )}

          {canMessage && (
            <section className="stack">
              <span className="label">[ MESSAGE HOST ]</span>
              <p className="note">Available once approved, so a stuck connection can still be reported. The host receives it as a browser notification.</p>
              <textarea
                aria-label="Message for the host"
                maxLength={MAX_GUEST_MESSAGE_CHARACTERS}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="REPORT A PROBLEM OR ASK FOR CONTROL"
              />
              <div className="grid tight">
                <button onClick={sendMessage} disabled={!draft.trim()}>
                  TRANSMIT
                </button>
                <button onClick={requestControl} disabled={isController}>
                  REQUEST CONTROL
                </button>
              </div>
            </section>
          )}

          {live && touchDevice && (
            <section className="stack">
              <span className="label">[ GESTURE ]</span>
              <div className="grid tight">
                <button onClick={() => setMode('scroll')} aria-pressed={mode === 'scroll'}>
                  {mode === 'scroll' ? '>>> SCROLL' : 'SCROLL'}
                </button>
                <button onClick={() => setMode('drag')} aria-pressed={mode === 'drag'}>
                  {mode === 'drag' ? '>>> DRAG' : 'DRAG'}
                </button>
                <button onClick={() => setKeyboardOpen((open) => !open)} aria-expanded={keyboardOpen}>
                  {keyboardOpen ? 'HIDE KEYS' : 'KEYBOARD'}
                </button>
                <button onClick={toggleFullscreen}>FULL SCREEN</button>
              </div>
              {keyboardOpen && (
                <>
                  <textarea aria-label="Remote keyboard" id="remote-text" placeholder="TYPE TEXT, THEN TRANSMIT" />
                  <div className="grid tight">
                    <button
                      onClick={() => {
                        const element = document.querySelector<HTMLTextAreaElement>('#remote-text');
                        if (!element?.value) return;
                        peer.current.send({ type: 'text', text: element.value });
                        element.value = '';
                      }}
                    >
                      SEND TEXT
                    </button>
                    {KEY_BUTTONS.map((key) => (
                      <button
                        key={key}
                        onClick={() => {
                          peer.current.send({ type: 'key', phase: 'down', key, code: key, shift: false, repeat: false });
                          peer.current.send({ type: 'key', phase: 'up', key, code: key, shift: false, repeat: false });
                        }}
                      >
                        {key.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </section>
          )}

          {fallbackText && (
            <section className="stack">
              <span className="label">[ COPY BLOCKED · MANUAL TRANSFER ]</span>
              <textarea aria-label="Copied host selection" readOnly value={fallbackText} />
              <div className="grid tight">
                <button onClick={() => void navigator.clipboard.writeText(fallbackText).then(() => notify('Copied.')).catch(() => notify('Copy blocked by browser.'))}>COPY</button>
                <button onClick={() => setFallbackText('')}>DISMISS</button>
              </div>
            </section>
          )}

          <section className="stack">
            <button
              className="danger"
              onClick={() => {
                leave();
                end('You left the session.');
              }}
            >
              LEAVE SESSION
            </button>
          </section>
        </nav>
      )}

      {!menuOpen && (
        <button className="toggle" onClick={() => setMenuOpen(true)} aria-expanded={false}>
          [ GUIDE ]
        </button>
      )}

      {toast && <output className="toast">{toast}</output>}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
