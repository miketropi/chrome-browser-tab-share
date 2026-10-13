import type { ClipboardMessage, MetaMessage, ServerMessage, ViewportMessage } from '@tab-share/protocol';
import { TabController } from './control';

declare const __SERVICE_ORIGIN__: string;

interface GuestSummary {
  guestId: string;
  name: string;
  state: string;
  comparisonCode: string;
}

interface GuestMessage {
  guestId: string;
  name: string;
  text: string;
  at: number;
}

interface SessionState {
  tabId: number;
  tabTitle: string;
  tabOrigin: string;
  sessionId: string;
  hostToken: string;
  inviteUrl: string;
  expiresAt: number;
  inviteExpiresAt: number;
  controllerGuestId: string | null;
  controlEpoch: number;
  guests: GuestSummary[];
  messages: GuestMessage[];
}

let state: SessionState | undefined;
let controller: TabController | undefined;
let starting = false;
let hostWindowId: number | undefined;
let heartbeat: number | undefined;
let approvedGuests = new Set<string>();

const allowedPages = new Set([chrome.runtime.getURL('popup.html'), chrome.runtime.getURL('host.html'), chrome.runtime.getURL('offscreen.html')]);
const offscreenUrl = chrome.runtime.getURL('offscreen.html');

chrome.runtime.onInstalled.addListener(() => void teardown('Extension updated'));
chrome.runtime.onStartup.addListener(() => void teardown('Worker restarted'));
chrome.tabs.onRemoved.addListener((tabId) => {
  if (state?.tabId === tabId) void teardown('Shared tab closed');
});
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId === state?.tabId) void teardown('Debugger detached');
});
chrome.windows.onRemoved.addListener((id) => {
  if (id === hostWindowId) void teardown('Host window closed');
});

chrome.runtime.onMessage.addListener((raw, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !sender.url || !allowedPages.has(sender.url)) return false;
  const message = raw as { type?: string; tabId?: number; guestId?: string; value?: unknown };
  const fromOffscreen = sender.url === offscreenUrl;

  if (message.type === 'get-state') {
    respond(state ?? null);
    return false;
  }
  if (message.type === 'start' && sender.url === chrome.runtime.getURL('popup.html') && typeof message.tabId === 'number') {
    void start(message.tabId).then(respond).catch((error: unknown) => respond({ error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message.type === 'stop' && (sender.url.endsWith('/popup.html') || sender.url.endsWith('/host.html'))) {
    void teardown('Host stopped sharing');
    respond(true);
    return false;
  }
  if (message.type === 'host-command' && sender.url.endsWith('/host.html')) {
    void command(raw as { action: string; guestId?: string });
    respond(true);
    return false;
  }
  if (fromOffscreen && message.type === 'peer-input' && message.guestId) {
    void forwardInput(message.guestId, message.value);
  }
  if (fromOffscreen && message.type === 'peer-opened' && message.guestId) sendPeerMeta(message.guestId);
  if (fromOffscreen && message.type === 'peer-failed' && message.guestId) controller?.release();
  if (fromOffscreen && ['capture-ended', 'signaling-lost', 'offscreen-timeout'].includes(message.type ?? '')) {
    void teardown(message.type ?? 'Stopped');
  }
  if (fromOffscreen && message.type === 'server-message') handleServer((raw as { value: ServerMessage }).value);
  return false;
});

function toPeer(guestId: string, value: ViewportMessage | ClipboardMessage | MetaMessage): void {
  void chrome.runtime.sendMessage({ type: 'peer-message', guestId, value }).catch(() => undefined);
}

async function forwardInput(guestId: string, value: unknown): Promise<void> {
  const outcome = await controller?.dispatch(guestId, value);
  if (!outcome?.clipboard) return;
  toPeer(guestId, { type: 'clipboard', ...outcome.clipboard });
}

function sendPeerMeta(guestId: string): void {
  if (!state) return;
  toPeer(guestId, { type: 'meta', title: state.tabTitle, origin: state.tabOrigin });
}

async function start(tabId: number): Promise<{ ok: true }> {
  if (starting || state) throw new Error('A tab is already being shared.');
  starting = true;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || !/^https?:/.test(tab.url) || tab.incognito || tab.url.startsWith(__SERVICE_ORIGIN__)) {
      throw new Error('Select a normal http(s) tab. Incognito, service, and protected pages are not supported.');
    }
    const settings = await chrome.storage.local.get(['serviceOrigin', 'accessKey']);
    const serviceOrigin = String(settings.serviceOrigin ?? __SERVICE_ORIGIN__);
    if (serviceOrigin !== __SERVICE_ORIGIN__) throw new Error('Service origin differs from this extension build.');
    const accessKey = String(settings.accessKey ?? '');
    if (!accessKey) throw new Error('Configure the operator access key first.');

    const statusResponse = await fetch(`${serviceOrigin}/api/extension-status?id=${encodeURIComponent(chrome.runtime.id)}`);
    const status = (await statusResponse.json()) as { allowed?: boolean };
    if (!statusResponse.ok || !status.allowed) {
      throw new Error(`This extension is not authorized by the dev server. Restart it with ALLOWED_EXTENSION_IDS=${chrome.runtime.id}`);
    }

    const response = await fetch(`${serviceOrigin}/api/sessions`, { method: 'POST', headers: { Authorization: `Bearer ${accessKey}` } });
    const created = (await response.json()) as { sessionId: string; hostToken: string; inviteUrl: string; expiresAt: number; inviteExpiresAt: number; error?: string };
    if (!response.ok) throw new Error(created.error ?? 'Session creation failed');

    await ensureOffscreen();
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    controller = new TabController(tabId, (guestId, value) => toPeer(guestId, value));
    await controller.attach();

    state = {
      tabId,
      tabTitle: tab.title ?? 'Untitled tab',
      tabOrigin: new URL(tab.url).origin,
      sessionId: created.sessionId,
      hostToken: created.hostToken,
      inviteUrl: created.inviteUrl,
      expiresAt: created.expiresAt,
      inviteExpiresAt: created.inviteExpiresAt,
      controllerGuestId: null,
      controlEpoch: 0,
      guests: [],
      messages: []
    };

    const wsUrl = serviceOrigin.replace(/^http/, 'ws') + '/ws';
    const result = (await chrome.runtime.sendMessage({ type: 'start-capture', streamId, wsUrl, sessionId: created.sessionId, hostToken: created.hostToken })) as { error?: string } | undefined;
    if (result?.error) throw new Error(result.error);

    const hostWindow = await chrome.windows.create({ url: 'host.html', type: 'popup', width: 520, height: 760 });
    hostWindowId = hostWindow?.id;
    await chrome.action.setBadgeText({ text: 'LIVE' });
    await chrome.action.setBadgeBackgroundColor({ color: '#047857' });
    heartbeat = setInterval(() => void chrome.runtime.sendMessage({ type: 'heartbeat' }).catch(() => undefined), 5_000) as unknown as number;
    return { ok: true };
  } catch (error) {
    await teardown('Start failed');
    throw error;
  } finally {
    starting = false;
  }
}

async function ensureOffscreen(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [offscreenUrl] });
  if (!contexts.length) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA', 'WEB_RTC'],
      justification: 'Capture the selected tab and connect approved WebRTC viewers'
    });
  }
}

async function command(value: { action: string; guestId?: string }): Promise<void> {
  if (!state) return;
  if (value.action === 'stop') {
    await teardown('Host stopped sharing');
    return;
  }
  if (value.action === 'grant' && value.guestId) {
    controller?.grant(value.guestId, state.controlEpoch + 1);
    state.controllerGuestId = value.guestId;
  }
  if (value.action === 'revoke' || value.action === 'kick') {
    controller?.revoke();
    if (value.action === 'revoke') state.controllerGuestId = null;
  }
  const socketType = value.action === 'rotate' ? 'rotate-invite' : value.action === 'grant' ? 'grant-control' : value.action === 'revoke' ? 'revoke-control' : value.action;
  await chrome.runtime.sendMessage({ type: 'socket-command', value: { v: 1, type: socketType, guestId: value.guestId } });
}

function handleServer(value: ServerMessage): void {
  if (!state) return;
  if (value.type === 'snapshot') {
    state.guests = value.guests;
    state.controllerGuestId = value.controllerGuestId;
    state.controlEpoch = value.controlEpoch;
    const approvedNow = new Set(value.guests.filter((guest) => guest.state === 'approved').map((guest) => guest.guestId));
    for (const previous of approvedGuests) {
      if (!approvedNow.has(previous)) void chrome.runtime.sendMessage({ type: 'peer-remove', guestId: previous }).catch(() => undefined);
    }
    approvedGuests = approvedNow;
  } else if (value.type === 'pending-guest') {
    state.guests.push({ guestId: value.guestId, name: value.name, state: 'pending', comparisonCode: value.comparisonCode });
  } else if (value.type === 'control-state') {
    state.controllerGuestId = value.controllerGuestId;
    state.controlEpoch = value.controlEpoch;
    if (value.controllerGuestId) controller?.grant(value.controllerGuestId, value.controlEpoch);
    else controller?.revoke();
  } else if (value.type === 'invite') {
    state.inviteUrl = value.url;
    state.inviteExpiresAt = value.expiresAt;
  } else if (value.type === 'guest-message') {
    state.messages = [...state.messages, { guestId: value.guestId, name: value.name, text: value.text, at: value.at }].slice(-50);
    void notifyGuestMessage(value.name, value.text);
  }
  void chrome.runtime.sendMessage({ type: 'state-changed', state }).catch(() => undefined);
}

/** Browser notification so the host sees a guest report without watching the console. */
async function notifyGuestMessage(name: string, text: string): Promise<void> {
  try {
    await chrome.notifications.create(`guest-message-${opaqueId()}`, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icon-128.png'),
      title: `Guest message — ${name}`,
      message: text,
      priority: 2
    });
  } catch {
    // Notifications can be unavailable (permission denied, kiosk mode); the console log still holds it.
  }
}

function opaqueId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), (value) => value.toString(16).padStart(2, '0')).join('');
}

async function teardown(_reason: string): Promise<void> {
  controller?.revoke();
  clearInterval(heartbeat);
  heartbeat = undefined;
  approvedGuests = new Set();
  await chrome.runtime.sendMessage({ type: 'stop-capture' }).catch(() => undefined);
  await controller?.detach();
  controller = undefined;
  state = undefined;
  await chrome.action.setBadgeText({ text: '' });
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }).catch(() => []);
  if (contexts.length) await chrome.offscreen.closeDocument().catch(() => undefined);
}
