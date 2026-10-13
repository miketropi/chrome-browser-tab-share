import { InputEnvelopeSchema, MAX_CLIPBOARD_CHARACTERS, type ClipboardMessage, type InputEnvelope, type ViewportMessage } from '@tab-share/protocol';

const ALLOWED_KEYS = new Set(['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

// Fixed expressions. No guest-supplied value is interpolated into evaluated script.
const READ_VIEWPORT = `(() => {
  const visual = window.visualViewport;
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    offsetX: visual ? visual.offsetX : 0,
    offsetY: visual ? visual.offsetY : 0,
    scale: visual ? visual.scale : 1
  };
})()`;

const READ_SELECTION = `(() => {
  const active = document.activeElement;
  if (active && typeof active.value === 'string' && typeof active.selectionStart === 'number') {
    return active.value.substring(active.selectionStart, active.selectionEnd ?? active.selectionStart);
  }
  const selection = window.getSelection();
  return selection ? selection.toString() : '';
})()`;

const SELECT_ALL = `(() => {
  if (!document.hasFocus()) return false;
  const active = document.activeElement;
  if (active && typeof active.select === 'function' && typeof active.value === 'string') {
    active.select();
    return true;
  }
  const selection = window.getSelection();
  if (!selection || !document.body) return false;
  const range = document.createRange();
  range.selectNodeContents(document.body);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
})()`;

export interface DispatchOutcome {
  clipboard?: Pick<ClipboardMessage, 'requestId' | 'text' | 'truncated'>;
}

interface EvaluateResult { result?: { value?: unknown } }
interface AttachedToTarget { sessionId?: string }
interface DetachedFromTarget { sessionId?: string }

export class TabController {
  private viewportEpoch = 0;
  private width = 0;
  private height = 0;
  private controlEpoch = 0;
  private controller: string | null = null;
  private sequence = 0;
  private attached = false;
  private held = false;
  private pinched = false;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private readonly childSessions = new Set<string>();

  private readonly onDebuggerEvent = (source: chrome.debugger.DebuggerSession, method: string, params?: object): void => {
    if (source.tabId !== this.tabId) return;
    if (method === 'Target.attachedToTarget') {
      const attached = params as AttachedToTarget | undefined;
      if (attached?.sessionId) this.childSessions.add(attached.sessionId);
    } else if (method === 'Target.detachedFromTarget') {
      const detached = params as DetachedFromTarget | undefined;
      if (detached?.sessionId) this.childSessions.delete(detached.sessionId);
    }
  };

  constructor(private readonly tabId: number, private readonly publish: (guestId: string, value: ViewportMessage) => void) {}

  private async request<T extends object>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T> {
    const target: chrome.debugger.DebuggerSession = sessionId ? { tabId: this.tabId, sessionId } : { tabId: this.tabId };
    const result = await chrome.debugger.sendCommand(target, method, params);
    // The debugger API types the response as a generic object; each caller narrows a known CDP schema.
    return (result ?? {}) as unknown as T;
  }

  async attach(): Promise<void> {
    await chrome.debugger.attach({ tabId: this.tabId }, '1.3');
    this.attached = true;
    chrome.debugger.onEvent.addListener(this.onDebuggerEvent);
    await this.request('Page.enable');
    await this.request('Runtime.enable');
    try {
      await this.request('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'iframe', exclude: false }, { exclude: true }] });
    } catch {
      // Older builds reject the filter; input still works through root hit testing.
    }
    await this.refresh();
  }

  async refresh(force = false): Promise<void> {
    const measured = await this.measureInputSpace();
    if (!measured) return;
    const { width, height, pinched } = measured;
    const resized = width !== this.width || height !== this.height;
    if (resized) this.viewportEpoch += 1;
    const changed = force || resized || pinched !== this.pinched;
    this.width = width;
    this.height = height;
    this.pinched = pinched;
    if (!changed || !this.controller) return;
    this.publish(this.controller, {
      type: 'viewport',
      viewportEpoch: this.viewportEpoch,
      width,
      height,
      controlEpoch: this.controlEpoch,
      ...(pinched ? { paused: 'Reset pinch zoom on the shared tab to continue controlling it.' } : {})
    });
  }

  /**
   * The extent of the captured surface in CSS pixels.
   *
   * `tabCapture` records the whole tab content area, which is `innerWidth` by `innerHeight`:
   * that space includes the classic scrollbar, while the CDP layout viewport reports
   * `clientWidth`/`clientHeight` and excludes it. `getBoundingClientRect()` and
   * `Input.dispatchMouseEvent` both live in the innerWidth space, so reporting the layout
   * viewport would compress every coordinate whenever a scrollbar is present.
   */
  private async measureInputSpace(): Promise<{ width: number; height: number; pinched: boolean } | null> {
    try {
      const probe = await this.request<EvaluateResult>('Runtime.evaluate', { expression: READ_VIEWPORT, returnByValue: true });
      const value = probe.result?.value;
      if (value && typeof value === 'object' && 'width' in value && 'height' in value) {
        const candidate = value as { width?: unknown; height?: unknown; offsetX?: unknown; offsetY?: unknown; scale?: unknown };
        const width = Number(candidate.width);
        const height = Number(candidate.height);
        if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
          const pinched = Number(candidate.offsetX) !== 0 || Number(candidate.offsetY) !== 0 || Number(candidate.scale) !== 1;
          return { width, height, pinched };
        }
      }
    } catch {
      // Fall through to the CDP metrics below.
    }
    const metrics = await this.request<{
      cssLayoutViewport?: { clientWidth: number; clientHeight: number };
      cssVisualViewport?: { offsetX: number; offsetY: number; scale: number };
    }>('Page.getLayoutMetrics');
    const layout = metrics.cssLayoutViewport;
    if (!layout || !(layout.clientWidth > 0) || !(layout.clientHeight > 0)) return null;
    const visual = metrics.cssVisualViewport;
    const pinched = visual ? visual.offsetX !== 0 || visual.offsetY !== 0 || visual.scale !== 1 : false;
    return { width: layout.clientWidth, height: layout.clientHeight, pinched };
  }

  private startPolling(): void {
    clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => void this.refresh().catch(() => undefined), 250);
  }

  grant(guestId: string, epoch: number): void {
    this.release();
    this.controller = guestId;
    this.controlEpoch = epoch;
    this.sequence = 0;
    void this.refresh(true).catch(() => undefined);
    this.startPolling();
  }

  revoke(): void {
    this.controller = null;
    this.controlEpoch += 1;
    this.sequence = 0;
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.release();
  }

  async dispatch(guestId: string, input: unknown): Promise<DispatchOutcome> {
    const parsed = InputEnvelopeSchema.safeParse(input);
    if (!parsed.success || guestId !== this.controller) return {};
    const value: InputEnvelope = parsed.data;
    if (value.controlEpoch !== this.controlEpoch || value.viewportEpoch !== this.viewportEpoch || value.seq <= this.sequence) return {};
    this.sequence = value.seq;
    const event = value.event;
    switch (event.type) {
      case 'pointer': {
        const pressed = event.phase === 'down' || (event.phase === 'move' && this.held);
        await this.request('Input.dispatchMouseEvent', {
          type: event.phase === 'down' ? 'mousePressed' : event.phase === 'up' ? 'mouseReleased' : 'mouseMoved',
          x: event.u * this.width,
          y: event.v * this.height,
          button: 'left',
          buttons: pressed ? 1 : 0,
          clickCount: event.clickCount
        });
        if (event.phase === 'up') this.held = false;
        else this.held = pressed;
        return {};
      }
      case 'wheel': {
        await this.request('Input.dispatchMouseEvent', { type: 'mouseWheel', x: event.u * this.width, y: event.v * this.height, deltaX: event.deltaX, deltaY: event.deltaY });
        return {};
      }
      case 'text': {
        await this.request('Input.insertText', { text: event.text });
        return {};
      }
      case 'key': {
        const printable = event.key.length === 1 && !/[\u0000-\u001f\u007f]/.test(event.key);
        if (!printable && !ALLOWED_KEYS.has(event.key)) return {};
        await this.request('Input.dispatchKeyEvent', {
          type: event.phase === 'down' ? 'keyDown' : 'keyUp',
          key: event.key,
          code: event.code,
          modifiers: event.shift ? 8 : 0,
          text: event.phase === 'down' && printable ? event.key : '',
          autoRepeat: event.repeat
        });
        return {};
      }
      case 'copy': {
        const selection = await this.readSelection();
        return { clipboard: { requestId: event.requestId, text: selection.text, truncated: selection.truncated } };
      }
      case 'select-all': {
        await this.selectAllText();
        return {};
      }
      case 'context-click': {
        const x = event.u * this.width;
        const y = event.v * this.height;
        // A right press/release pair is what opens the page's own context menu.
        await this.request('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'right', buttons: 2, clickCount: 1 });
        await this.request('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'right', buttons: 0, clickCount: 1 });
        return {};
      }
      case 'release': {
        this.release();
        return {};
      }
    }
  }

  private targetSessions(): (string | undefined)[] {
    return [undefined, ...this.childSessions];
  }

  private async readSelection(): Promise<{ text: string; truncated: boolean }> {
    let best = '';
    for (const sessionId of this.targetSessions()) {
      try {
        const response = await this.request<EvaluateResult>('Runtime.evaluate', { expression: READ_SELECTION, returnByValue: true }, sessionId);
        const value = response.result?.value;
        if (typeof value === 'string' && value.length > best.length) best = value;
      } catch {
        // Frame detached mid-read; other frames may still answer.
      }
    }
    return { text: best.slice(0, MAX_CLIPBOARD_CHARACTERS), truncated: best.length > MAX_CLIPBOARD_CHARACTERS };
  }

  private async selectAllText(): Promise<void> {
    for (const sessionId of this.targetSessions()) {
      try {
        await this.request('Runtime.evaluate', { expression: SELECT_ALL, returnByValue: true }, sessionId);
      } catch {
        // Frame detached mid-command.
      }
    }
  }

  release(): void {
    if (this.held && this.attached) void this.request('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 0, y: 0, button: 'left', buttons: 0 });
    this.held = false;
    if (this.attached) void this.request('Input.cancelDragging').catch(() => undefined);
  }

  async detach(): Promise<void> {
    clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    this.revoke();
    chrome.debugger.onEvent.removeListener(this.onDebuggerEvent);
    this.childSessions.clear();
    if (!this.attached) return;
    this.attached = false;
    await chrome.debugger.detach({ tabId: this.tabId }).catch(() => undefined);
  }
}
