import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

declare const __SERVICE_ORIGIN__: string;

interface ShareState {
  tabTitle: string;
  tabOrigin: string;
}

function Popup() {
  const [tabId, setTabId] = useState<number>();
  const [tabTitle, setTabTitle] = useState('');
  const [serviceOrigin, setServiceOrigin] = useState(__SERVICE_ORIGIN__);
  const [accessKey, setAccessKey] = useState('');
  const [state, setState] = useState<ShareState | null>(null);
  const [status, setStatus] = useState('IDLE');
  const [error, setError] = useState('');

  useEffect(() => {
    void Promise.all([
      chrome.tabs.query({ active: true, currentWindow: true }),
      chrome.storage.local.get(['serviceOrigin', 'accessKey']),
      chrome.runtime.sendMessage({ type: 'get-state' })
    ]).then(([tabs, settings, current]) => {
      setTabId(tabs[0]?.id);
      setTabTitle(tabs[0]?.title ?? 'CURRENT TAB');
      setServiceOrigin(String(settings.serviceOrigin ?? __SERVICE_ORIGIN__));
      setAccessKey(String(settings.accessKey ?? ''));
      setState(current as ShareState | null);
    });
  }, []);

  async function save(): Promise<void> {
    if (serviceOrigin !== __SERVICE_ORIGIN__) {
      setError('SERVICE ORIGIN IS FIXED AT BUILD TIME.');
      return;
    }
    await chrome.storage.local.set({ serviceOrigin, accessKey: accessKey.trim() });
    setStatus('SAVED');
    setError('');
  }

  async function start(): Promise<void> {
    if (tabId === undefined) return;
    if (serviceOrigin !== __SERVICE_ORIGIN__) {
      setError('SERVICE ORIGIN IS FIXED AT BUILD TIME.');
      return;
    }
    if (!accessKey.trim()) {
      setError('ENTER THE OPERATOR ACCESS KEY.');
      return;
    }
    setStatus('ARMING CAPTURE + DEBUGGER');
    setError('');
    await chrome.storage.local.set({ serviceOrigin, accessKey: accessKey.trim() });
    const result = (await chrome.runtime.sendMessage({ type: 'start', tabId })) as { error?: string };
    if (result.error) {
      setStatus('FAILED');
      setError(result.error);
    } else {
      window.close();
    }
  }

  return (
    <main className="crt panel">
      <h1 className="label">[ TAB SHARE ]</h1>

      {state ? (
        <>
          <dl className="meta">
            <dt>STATE</dt>
            <dd className="signal">LIVE</dd>
            <dt>VECTOR</dt>
            <dd>{state.tabOrigin}</dd>
            <dt>TITLE</dt>
            <dd>{state.tabTitle}</dd>
          </dl>
          <div className="grid">
            <button onClick={() => void chrome.windows.create({ url: 'host.html', type: 'popup', width: 560, height: 780 })}>OPEN CONSOLE</button>
            <button className="danger" onClick={() => void chrome.runtime.sendMessage({ type: 'stop' })}>STOP SHARING</button>
          </div>
        </>
      ) : (
        <>
          <dl className="meta">
            <dt>TARGET</dt>
            <dd>{tabTitle || 'CURRENT TAB'}</dd>
            <dt>STATUS</dt>
            <dd>{status}</dd>
          </dl>

          <p className="note danger">
            WARNING /// APPROVED CONTROLLERS ACT WITH YOUR SIGNED-IN ACCOUNT. THEY CAN SUBMIT FORMS, NAVIGATE, START DOWNLOADS, OPEN LOCAL-ONLY BROWSER OR OS SURFACES,
            AND COPY TEXT THEY SELECT IN THE SHARED TAB INTO THEIR OWN CLIPBOARD. NEW TABS ARE NEVER SHARED.
          </p>

          <label className="field">
            <span className="label">SERVICE ORIGIN</span>
            <input value={serviceOrigin} onChange={(event) => setServiceOrigin(event.target.value)} />
          </label>
          <label className="field">
            <span className="label">OPERATOR ACCESS KEY</span>
            <input type="password" value={accessKey} onChange={(event) => setAccessKey(event.target.value)} />
          </label>

          <div className="grid">
            <button onClick={save}>SAVE</button>
            <button className="primary" disabled={tabId === undefined || !accessKey.trim()} onClick={start}>
              SHARE THIS TAB &gt;&gt;&gt;
            </button>
          </div>
        </>
      )}

      {error && <output className="error">{error}</output>}
      <p className="note">BUILD {__SERVICE_ORIGIN__}</p>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Popup />
  </StrictMode>
);
