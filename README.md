# Tab Share

Self-hosted Chrome tab sharing for an explicitly selected tab. Approved guests receive live video; exactly one guest can control at a time through `chrome.debugger` CDP input.

## Local development

Requires Node.js 24 and desktop Chrome 125 or newer.

```sh
npm install
npm run build
HOST_ACCESS_KEY=development-host-access-key-change-me NODE_ENV=development npm run dev
npm run fixtures
```

Load `apps/extension/dist` through `chrome://extensions` → Developer mode → Load unpacked. Copy its extension ID into `ALLOWED_EXTENSION_IDS`, restart the server, then configure the popup with `http://localhost:3000` and the development host key. Open `http://localhost:4100/tab.html`, select the toolbar action, and start sharing.

The extension build fixes `SERVICE_ORIGIN`; production origin changes require rebuilding:

```sh
SERVICE_ORIGIN=https://share.example.com npm run build -w @tab-share/extension
```

## Deployment

Copy `deploy/.env.example` to `deploy/.env`, supply real DNS, secrets, public IPv4, and publicly trusted TURN certificate paths. Open TCP 80, 443, 3478, 5349; UDP 3478 and 49160–49239. Then on the Linux VPS:

```sh
docker compose --env-file deploy/.env -f deploy/compose.yml config
docker compose --env-file deploy/.env -f deploy/compose.yml up --build -d
```

Caddy obtains the application certificate. Coturn uses the separately mounted certificate and host networking. A direct public IP needs no `external-ip`. Behind 1:1 NAT, add the validated coturn `external-ip=PUBLIC/PRIVATE` setting while preserving relay ports. Networks allowing only port 443 require coturn TLS on a second public IP with `TURN_TLS_PORT=443`; do not proxy TURN through Caddy.

## Guest experience

After approval the guest window is full-bleed: the video stage occupies the entire viewport and a single `[ GUIDE ]` toggle opens one bottom sheet. That sheet is documentation first — how to click, drag, right-click, scroll, and select all — followed by only the actions that need a button: transmit a message to the host, request control, and leave. Desktop keeps keyboard paths (`^C`, `^A`); touch devices additionally get explicit RIGHT CLICK, COPY SELECTION, SELECT ALL, KEYBOARD, and FULL SCREEN actions.

Guests receive **video pixels**, not the host DOM. Interaction is real browser input replayed on the host tab through `chrome.debugger`:

- Pointer, wheel, keyboard, and committed text input, for the single granted controller.
- Desktop mouse drag performs real text selection in the shared tab.
- Right-click, `Ctrl`-click, or a long-press opens the page's own context menu **on the host's screen**, not the guest's. The host dismisses it locally with Escape.
- `Ctrl+C` / `Cmd+C` or **Copy selection** asks the host for its current page selection and writes it to the guest clipboard. Main-frame and same-process frame selections are read; the payload is capped at 60,000 characters and reports truncation.
- `Ctrl+A` / **Select all** selects the focused frame's contents on the host.
- Touch: **Scroll** mode pans with one finger (turning into wheel deltas after a 6px threshold) and taps click; **Drag** mode performs left-button drags.

Copy is deliberately one-directional and gesture-driven. There is no host clipboard read, no guest-to-host clipboard write, no automatic clipboard synchronization, and no DOM access on the guest side.

## Guest to host messages

An approved guest can send the host a plain-text report of up to 280 characters from the guide panel. This exists for exactly the cases where the picture is not enough: a stuck negotiation, an unresponsive page, or a request for control.

- The server accepts the message only from an authenticated guest whose state is `approved`; pending guests receive `UNAUTHORIZED`.
- Rate limited to five messages per guest per minute, and the text is trimmed plain text, so no markup can reach the host.
- The host extension raises a `chrome.notifications` notification titled with the guest's name, and keeps a bounded 50-entry transcript in the host console so nothing is lost if notifications are unavailable.
- Messaging is available as soon as approval lands, not only once media is connected, because a failed negotiation is precisely when a report matters.

Notifications need the `notifications` permission and the extension icon; icons are generated deterministically by `node tools/make-icons.mjs`.

## Coordinate contract

Pointer accuracy and picture shape are two separate concerns, so the contract is explicit:

1. **Shape.** The picture is drawn with `object-fit: contain`, so the visible frame occupies exactly the largest rectangle with the *video's own intrinsic aspect* that fits the stage. Coordinates are normalized over that same rectangle. The host viewport aspect is never used for drawing: the encoder may deliver any resolution or rounding, and forcing the frame into the host ratio is what stretched the image.
2. **Extent.** The host reports the extent of the captured surface in CSS pixels as `window.innerWidth` by `window.innerHeight`. That is the whole tab content area, which is what `tabCapture` records — it includes the classic scrollbar, whereas the CDP layout viewport reports `clientWidth`/`clientHeight` and excludes it. `getBoundingClientRect()` and `Input.dispatchMouseEvent` both live in the `innerWidth` space, so using the layout viewport would compress every coordinate whenever a scrollbar is present.
3. **Freshness.** The host publishes `{ viewportEpoch, width, height, controlEpoch }`, incrementing the epoch only when dimensions actually change, and re-reads every 250 ms while a controller is granted, so resize, zoom, and navigation cannot leave stale dimensions in play.
4. **Mapping.** The host converts with `x = u * width`, `y = v * height`. Clicks in the letterbox band are rejected rather than clamped.
5. **Generations.** Every envelope carries `controlEpoch`, `viewportEpoch`, and a monotonic `seq`; the host rejects stale generations, replayed sequences, and out-of-range or non-finite values. Pinch zoom pauses input rather than guessing an offset.

Telemetry and notices are `pointer-events: none`, so nothing drawn over the picture can swallow a click — an overlay in the top band of the stage previously did exactly that.

If the frame and the reported viewport disagree by more than 1%, the guest's SCALE readout turns red and a notice appears, so a mismatch is visible rather than silent.

Capture applies **no size or frame-rate constraints**: constraint-driven fitting is the one place Chrome may deliver a frame that does not correspond one-to-one with the tab viewport. Bandwidth is bounded on the sender instead, with `maxBitrate` 2,500,000 and `degradationPreference: 'maintain-resolution'`, and resolution is capped by `scaleResolutionDownBy`, an integer divisor that is always aspect-preserving.

## Handshake ordering

The host offers only after the guest reports readiness, because an offer sent before the guest's socket authenticated is dropped and nothing would retry it.

- A guest sends `ready` when approval lands.
- The server also sends `ready` to the host when an already-approved guest socket authenticates, which covers a late-connecting guest.
- The host builds the peer on `ready` and only on `ready`, so ordering cannot strand a guest on "negotiating".

Live-video latency and mid-flight layout changes still cause temporal skew; frame-accurate clicks are not promised.

## Interface language

The guest window, toolbar popup, and host console all follow the Tactical Telemetry / CRT terminal guidelines:

- Dark CRT substrate (`#0a0a0a`, `#121212`, `#1a1a1a`) with `#eaeaea` phosphor text.
- Monospace type throughout; uppercase metadata and labels with generous tracking.
- Hazard red `#e61919` as the only accent, reserved for primary actions, alert borders, and vital readouts.
- Terminal green `#4af626` on exactly one element: the `CONTROL` readout when control is granted.
- Zero border radius; no decorative gradients, translucency, or drop shadows.
- Visible compartmentalisation through solid 1px borders and 1px grid gaps over contrasting parent/child backgrounds.
- ASCII framing (`[ INVITATION ]`, `>>>`, `///`) and semantic `<data>`, `<samp>`, `<kbd>`, `<output>`, `<dl>` markup.
- A faint scanline overlay sits over the video plane only, below every text layer, so readouts stay crisp.

Text contrast is 4.5:1 or better everywhere, including disabled controls, which are dimmed rather than faded to unreadable. No web fonts are loaded; the monospace stack is system-local, keeping the guest free of third-party requests.

## Security and compatibility boundary

- Video only. No microphone, desktop, toolbar, clipboard synchronization, native file transfer, or OS-dialog control.
- New tabs are never followed. Same-tab navigation remains captured.
- Remote actions use the host's signed-in page and can submit forms, navigate, start downloads, and trigger local-only permission surfaces.
- Pending guests receive no media, SDP, ICE, or TURN credentials.
- Session state is memory-only; restart ends rooms.
- `chrome.debugger` use for end-user interaction is explicitly unsupported by Chrome's CDP documentation and can break with browser updates or enterprise policy. This unpacked extension is not represented as Chrome Web Store approved.
- Protected pages, DRM, file pickers, native dialogs, and some HTML5 drag operations may not work. Direct ICE may expose peer network addresses. DTLS/SRTP does not protect against a malicious signaling operator.

## Verification fixtures

`npm run fixtures` serves the main fixture on `http://localhost:4100/tab.html`, an unrelated tab on `/unrelated.html`, and its cross-site frame on `http://127.0.0.1:4101/frame.html`.
