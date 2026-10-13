import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import QRCode from 'qrcode';
import './styles.css';

interface Guest {
  guestId: string;
  name: string;
  state: string;
  comparisonCode: string;
}

interface Message {
  guestId: string;
  name: string;
  text: string;
  at: number;
}

interface HostState {
  tabTitle: string;
  tabOrigin: string;
  inviteUrl: string;
  inviteExpiresAt: number;
  guests: Guest[];
  controllerGuestId: string | null;
  messages: Message[];
}

function Host() {
  const [state, setState] = useState<HostState | null | undefined>(undefined);
  const [qr, setQr] = useState('');
  const [copyState, setCopyState] = useState('');

  useEffect(() => {
    void chrome.runtime.sendMessage({ type: 'get-state' }).then((value) => setState((value as HostState | null) ?? null));
    const listener = (message: unknown) => {
      if (message && typeof message === 'object' && 'type' in message && message.type === 'state-changed' && 'state' in message) {
        setState(message.state as HostState);
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  useEffect(() => {
    if (state?.inviteUrl) void QRCode.toDataURL(state.inviteUrl, { width: 320, margin: 4, errorCorrectionLevel: 'M' }).then(setQr);
  }, [state?.inviteUrl]);

  function action(name: string, guestId?: string): void {
    void chrome.runtime.sendMessage({ type: 'host-command', action: name, guestId });
  }

  if (state === undefined) {
    return (
      <main className="crt center">
        <section className="slab">
          <h1 className="label">[ CONSOLE ]</h1>
          <p className="note">READING CAPTURE + LINK STATE…</p>
        </section>
      </main>
    );
  }

  if (state === null) {
    return (
      <main className="crt center">
        <section className="slab">
          <h1 className="label">[ SESSION ENDED ]</h1>
          <p className="note">CAPTURE, CONTROL CHANNEL, AND GUEST MEDIA ARE CLOSED. RETURN TO THE TARGET TAB AND USE THE TOOLBAR ACTION TO START AGAIN.</p>
        </section>
      </main>
    );
  }

  const pending = state.guests.filter((guest) => guest.state === 'pending');
  const approved = state.guests.filter((guest) => guest.state !== 'pending');

  return (
    <main className="crt panel">
      <header className="head">
        <span className="tag">[ LIVE ]</span>
        <span className="url">{state.tabOrigin}</span>
        <span className="badge">{state.tabTitle}</span>
        <button className="danger" onClick={() => action('stop')}>
          STOP SHARING
        </button>
      </header>

      <section className="slab">
        <h2 className="label">[ INVITATION ]</h2>
        {qr && <img className="qr" src={qr} alt="Invitation QR code" />}
        <label className="field">
          <span className="label">CHANNEL URL</span>
          <textarea readOnly value={state.inviteUrl} />
        </label>
        <dl className="meta">
          <dt>EXPIRES</dt>
          <dd>
            <samp>{new Date(state.inviteExpiresAt).toLocaleTimeString()}</samp>
          </dd>
          <dt>TRANSFER</dt>
          <dd>
            <samp>{copyState || 'IDLE'}</samp>
          </dd>
        </dl>
        <div className="grid">
          <button
            onClick={() =>
              void navigator.clipboard
                .writeText(state.inviteUrl)
                .then(() => setCopyState('COPIED'))
                .catch(() => setCopyState('DENIED · SELECT MANUALLY'))
            }
          >
            COPY CHANNEL URL
          </button>
          <button onClick={() => action('rotate')}>ROTATE INVITATION</button>
        </div>
      </section>

      <section className="slab">
        <h2 className="label">[ GUEST MESSAGES {state.messages.length} ]</h2>
        {state.messages.length === 0 && <p className="note">NO MESSAGES. APPROVED GUESTS CAN REPORT PROBLEMS FROM THEIR GUIDE PANEL.</p>}
        {[...state.messages].reverse().map((entry, index) => (
          <div className="row" key={`${entry.at}-${index}`}>
            <span className="tag">{new Date(entry.at).toLocaleTimeString()}</span>
            <span className="url">{entry.name.toUpperCase()}</span>
            <span className="badge">{entry.text}</span>
          </div>
        ))}
      </section>

      <section className="slab">
        <h2 className="label">[ PENDING REQUESTS {pending.length} ]</h2>
        {pending.length === 0 && <p className="note">NO INBOUND REQUESTS.</p>}
        {pending.map((guest) => (
          <div className="row" key={guest.guestId}>
            <span className="url">{guest.name.toUpperCase()}</span>
            <output className="code">
              CODE <data>{guest.comparisonCode}</data>
            </output>
            <button className="primary" onClick={() => action('approve', guest.guestId)}>
              APPROVE
            </button>
            <button className="danger" onClick={() => action('reject', guest.guestId)}>
              REJECT
            </button>
          </div>
        ))}
      </section>

      <section className="slab">
        <h2 className="label">[ APPROVED VIEWERS {approved.length} ]</h2>
        {approved.length === 0 && <p className="note">NO APPROVED VIEWERS.</p>}
        {approved.map((guest) => {
          const controlling = state.controllerGuestId === guest.guestId;
          return (
            <div className="row" key={guest.guestId}>
              <span className="url">{guest.name.toUpperCase()}</span>
              <output className={`readout${controlling ? ' signal' : ''}`}>
                <data>{controlling ? 'CONTROL' : 'VIEW'}</data>
              </output>
              {controlling ? (
                <button onClick={() => action('revoke')}>REVOKE</button>
              ) : (
                <button onClick={() => action('grant', guest.guestId)}>GRANT CONTROL</button>
              )}
              <button className="danger" onClick={() => action('kick', guest.guestId)}>
                REMOVE
              </button>
            </div>
          );
        })}
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Host />
  </StrictMode>
);
