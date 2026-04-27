# Teletype Plugin — Detailed Design

A Hermes dashboard plugin + theme that renders chat with an AI agent as a
1960s ASR-33 teletype: 72-column uppercase paper roll, 10-character-per-second
electromechanical printing, full audio (motor hum, key clack, print clack,
carriage return, margin bell), and a strict mechanical interlock that limits
the operator to 10 cps input as well as 10 cps output.

The plugin is a runtime drop-in for the dashboard described in
[Extending the Dashboard](https://hermes-agent.nousresearch.com/docs/user-guide/features/extending-the-dashboard).
It chats with the locally-running hermes API server over the non-streaming
OpenAI-compatible `/v1/chat/completions` endpoint. The completion response is
received as one body by the plugin backend, then released to the browser's
mechanical print queue and rendered at 10 characters per second.

The behavior is a faithful browser port of `~/play/ttyemu` (PygameFrontend +
sounds.py) crossed with `~/play/hermes-shell` (hsh — completions API client
with ASCII sanitization and column wrapping).

---

## Goals

1. Visceral teletype experience: feel mechanical, feel slow, feel correct.
2. End-to-end fidelity: no character ever appears that wasn't transmitted,
   echoed, and printed under the 10 cps interlock.
3. Mechanical carriage fidelity: carriage-position-driven bell and LF/CR behavior,
   no completion-timing coupling.
4. Self-contained plugin: themed skin + plugin lives entirely under
   `~/play/tty-skills/`. No core hermes-agent changes.
5. Resumable: WS reconnect picks up the same hermes session.

## Non-goals

- Markdown rendering. Output is plain ASCII; whatever the model emits is
  printed literally (after NFKD normalization to drop high codepoints).
- Tool-call diagnostics. The hermes API server runs the agent with full
  tools, but only the final assistant text is sent to the teletype.
- Line editing / readline behavior. There is no cursor recall, no
  history-up. Backspace overstrikes — it does not erase.
- Reverse line feed. There is LF (down one row) but no negative LF; once
  the paper has scrolled, you cannot print above it.
- Accessibility parity in v0. Canvas output hides text from screen readers;
  a DOM mirror can be added later.

---

## High-level architecture

```
Browser plugin /teletype                     Backend FastAPI router
─────────────────────────                    ──────────────────────
React + Canvas + WebAudio                    /api/plugins/teletype/tty (WS)
                                                            │
  KeyQueue ── 100ms tick ──► WS ─send char─► [echo char]    │
                                              [accumulate]  │
                                                            │
  PrintQueue ◄─ recv char ──── WS ◄───────[burst chars after completion]─┤
       │                                                    │
       └─ 100ms tick ─► Renderer + AudioEngine              │
                                                            │
                                              On '\r' in line:
                                                [send '\r' '\n']
                                                [POST /v1/chat/completions]
                                                [enqueue reply chars over WS]
                                                            │
                                                            ▼
                                              http://127.0.0.1:8642/v1/...
                                              (hermes API server, separate
                                               process from dashboard)
```

Three independent clocks, one rate:

| Clock | Owner | Rate | Drives |
|---|---|---|---|
| KeyTick | Browser | 100 ms | Pop one keystroke from KeyQueue → WS send + key-clack |
| PrintTick | Browser | 100 ms (105 ms in ttyemu) | Pop one char from PrintQueue → render + char-clack |
| LLM completion | Backend | one HTTP response per turn | Push completed reply chars into the WS; browser PrintQueue absorbs the burst |

The KeyTick and PrintTick are independent timers. They share the cadence but
not the phase. The PrintQueue and KeyQueue are independent FIFOs; the only
coupling is that the backend receives KeyQueue output, echoes into the WS,
which the browser puts in the PrintQueue. The LLM call is not SSE and does not
drive visible output directly; it only fills the browser PrintQueue after the
plain completion response returns.

---

## Repo layout

```
~/play/tty-skills/
├── README.md                      # update: mention plugin + theme + install
├── skills/tty/                    # existing skill content (unchanged)
├── themes/
│   └── teletype.yaml              # the dashboard skin
└── plugins/
    └── teletype/
        ├── DESIGN.md              # this document
        ├── README.md              # install + usage
        └── dashboard/
            ├── manifest.json
            ├── plugin_api.py      # WS handler + LLM proxy
            ├── system_prompt.txt  # adapted from hsh
            └── dist/              # browser bundle + assets (committed)
                ├── index.js
                ├── style.css
                ├── img/
                │   └── paper.png
                ├── fonts/
                │   ├── Teletype33.ttf
                │   ├── teleprinter.css
                │   └── LICENSE-Teletype33.txt
                └── sounds/
                    ├── up-{hum,bell,cr-01..03,key-01..07,...}.wav
                    └── down-{...}.wav    # all 34 from ~/play/ttyemu/sounds
```

### Install

```sh
ln -s ~/play/tty-skills/plugins/teletype  ~/.hermes/plugins/teletype
cp ~/play/tty-skills/themes/teletype.yaml ~/.hermes/dashboard-themes/
```

Then restart the Hermes dashboard/gateway process that serves the web
dashboard so plugin routes are (re)discovered. A plugin API route remount requires
process restart in this version.
The theme file is loaded by the dashboard theme system.
Security note: the WebSocket endpoint is trusted local-only and intentionally has
no token auth; do not expose it without dashboard-level auth/proxying.
After copying the theme, select `Teletype` in the dashboard theme picker or set
`dashboard.theme: teletype` in `~/.hermes/config.yaml`.

Hermes dashboard discovery expects the symlink target to contain
`dashboard/manifest.json`. The symlink above is therefore to
`plugins/teletype/`, not to `plugins/teletype/dashboard/`.

### Hermes integration contract

Dashboard plugin discovery:
- Manifest path after install:
  `~/.hermes/plugins/teletype/dashboard/manifest.json`.
- Static assets are served from the plugin dashboard directory:
  `/dashboard-plugins/teletype/<path-inside-dashboard>`.
- Backend API routes are mounted under `/api/plugins/teletype/` because the
  manifest declares `"api": "plugin_api.py"`.
- `plugin_api.py` must export a module-level `router = APIRouter()`.

Frontend bundle contract:
- `dashboard/dist/index.js` is an IIFE loaded by `<script>`, not an ES module.
- The bundle must call
  `window.__HERMES_PLUGINS__.register("teletype", TeletypePage)` within the
  dashboard plugin load window.
- Do not bundle React. Read `React` from `window.__HERMES_PLUGIN_SDK__.React`.
- The plugin should not depend on shadcn components for its main surface; it
  owns a full-page canvas/paper UI and only uses dashboard globals for mount,
  fetch helpers if needed, and CSS variables.

WebSocket URL construction:

```ts
function teletypeWsUrl(sessionId: string): string {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  const qs = new URLSearchParams({ session: sessionId });
  return `${scheme}//${window.location.host}/api/plugins/teletype/tty?${qs}`;
}
```

No separate CORS or gateway host configuration is needed for the browser WS:
the browser talks to the dashboard origin. Only `plugin_api.py` talks to the
Hermes OpenAI-compatible API server at `http://127.0.0.1:8642` or the configured
`api_server` host/port.

---

## Theme — `themes/teletype.yaml`

```yaml
name: teletype
label: Teletype
description: ASR-33 paper roll with ink-on-beige and Teletype33 font.
palette:
  background:
    hex: "#FFEEDD"
    alpha: 1.0
  midground:
    hex: "#333333"
    alpha: 1.0
  foreground:
    hex: "#000000"
    alpha: 0.0
  warmGlow: "rgba(120, 90, 60, 0.15)"
  noiseOpacity: 0.4
typography:
  fontSans: '"Teletype33", monospace'
  fontMono: '"Teletype33", monospace'
  fontDisplay: '"Teletype33", monospace'
  fontUrl: "/dashboard-plugins/teletype/dist/fonts/teleprinter.css"
  baseSize: "16px"
  lineHeight: "1.4"
  letterSpacing: "0"
layout:
  radius: "0"
  density: "comfortable"
layoutVariant: standard
assets:
  bg: "/dashboard-plugins/teletype/dist/img/paper.png"   # 256x256 tileable beige
componentStyles:
  page:
    background-color: "#FFEEDD"
    color: "#333333"
  card:
    background-color: "#FFEEDD"
    border: "1px solid #d4c4a4"
    box-shadow: "none"
customCSS: |
  /* paper texture scrolls with the page (background-attachment: local), so as
     the paper roll grows the grain moves with it. */
  body {
    background-image: var(--theme-asset-bg);
    background-repeat: repeat;
  }
  /* drop the gradient backdrop the standard layout adds */
  [data-layout-variant="standard"] .backdrop { display: none; }
```

Notes on the paper background:

- A subtle 256×256 tileable PNG of warm-beige fiber paper. ~50 KB.
- `fontUrl` points at `dashboard/dist/fonts/teleprinter.css`, which declares
  `@font-face { font-family: "Teletype33"; src: url("./Teletype33.ttf"); }`.
- `Teletype33.ttf` is released under CC0 1.0 Universal. Ship
  `LICENSE-Teletype33.txt` next to the font.
- `background-attachment: local`. As the user scrolls down through the paper
  roll, the grain moves with the page content — the paper feels physical, not
  pinned to the viewport.
- Plugin renders text on top using a transparent canvas (or DOM rows) so the
  paper texture shows through.
- `dist/style.css` must scope all selectors under a stable root class such as
  `.teletype-plugin` except for intentional font-face declarations. Avoid
  global resets; the theme owns global dashboard skinning.
- The theme may reference plugin-served assets. If the theme is selected while
  the plugin is not installed, those asset URLs can 404; this is acceptable for
  v0 and should be mentioned in the README.

---

## Plugin manifest — `plugins/teletype/dashboard/manifest.json`

```json
{
  "name": "teletype",
  "label": "Teletype",
  "description": "ASR-33 teletype chat — 10cps mechanical printer + audio.",
  "icon": "Type",
  "version": "0.1.0",
  "tab": {
    "path": "/teletype",
    "position": "end"
  },
  "entry": "dist/index.js",
  "css": "dist/style.css",
  "api": "plugin_api.py"
}
```

Standard tab plugin. No slot injection. No page override.

The route `/teletype` is owned by the dashboard router after plugin discovery.
The plugin component itself should render a root element like:

```tsx
<div className="teletype-plugin" data-plugin="teletype">
  ...
</div>
```

Use this root for CSS scoping and keyboard focus management.

---

## Backend — `plugin_api.py`

A FastAPI router exporting `router`. Mounted at `/api/plugins/teletype/`.

### Routes

```
WS   /api/plugins/teletype/tty?session=<hex>     primary TTY channel
```

### Vendored/adapted from hsh (`~/play/hermes-shell/hermes_shell/shell.py`)

Copy these helpers into `plugin_api.py` and own them locally. Keep behavior the
same as hsh unless noted:

| Function | Purpose |
|---|---|
| `_read_dotenv(path)` | Parse `~/.hermes/.env` |
| `_read_gateway_config()` | Parse `api_server` block from `~/.hermes/config.yaml` |
| `detect_gateway()` | → `(url, api_key)` from env / .env / config.yaml; defaults port 8642 |
| `ascii_sanitize(text)` | NFKD normalize + drop > 0x7F, preserve BEL (`_ASCII_TABLE` pattern) |
| `wrap_text(text, width)` | 72-col wrap preserving leading indent and blank lines |
| `build_system_prompt(columns)` | Read `system_prompt.txt`, substitute `{columns}` |

### `system_prompt.txt`

Adapted from `~/play/hermes-shell/hermes_shell/system_prompt.txt`. Drop the
`<<FILE>>` marker and asr33 repo references. The backend now supports
`<BINARY>` and `<<BINARY>>` base64 output markers after the model response is
received, decoding them to raw teletype bytes before the printer queue. Keep:

- "operating through a hardcopy teletype terminal"
- "plain ASCII only, wrapped to {columns} columns"
- "no ANSI escapes, Unicode, Markdown tables, banners"
- "Printing is extremely slow ... please be brief!"
- "ASCII-63 character set ... `^` prints up-arrow, `_` prints left-arrow"
- "overstrike text (CR without LF) for image generation ... ASCII art"

Substituted at request build time with `columns=72`.

### Gateway session contract

The plugin sends one non-streaming `/v1/chat/completions` request per completed
operator line. It sends only the current prompt in the request body and relies
on Hermes session persistence for multi-turn history.

Hermes requires API-key authentication before it will accept
`X-Hermes-Session-Id` session continuation. Therefore resumable multi-turn
operation requires `API_SERVER_KEY` to be configured in `~/.hermes/config.yaml`,
`~/.hermes/.env`, or the process environment. `detect_gateway()` must return
both the gateway URL and key, and `_call_completions()` must send:

```http
Authorization: Bearer <api_key>
X-Hermes-Session-Id: <teletype_session_id>
```

If no API key is available, the backend sends an `error` message explaining
that teletype session continuity requires `API_SERVER_KEY`. It does not fall
back to stateless turns, because that would silently violate the "resumable"
goal.

### WebSocket protocol

Messages are JSON WebSocket messages. Supported input chars are
`\x07`, `\x08`, `\x09`, `\x0A`, `\x0C`, and printable `0x20..0x7E`.
Non-string, empty, multi-codepoint, or unsupported control input is
discarded at the WS boundary.

Client → Server:
```json
{ "t": "key", "c": "A" }
```

Server → Client:
```json
{ "t": "out", "c": "A" }                 // any char to print
{ "t": "status", "state": "thinking" }   // "thinking" | "ready"
{ "t": "error", "msg": "gateway unreachable: ..." }
```

The browser doesn't echo locally — every visible character arrives as `out`
from the server. A successful websocket handshake is required before input is
enqueued to output.

Status split:
- Backend status only reports LLM request state: `thinking` while the
  non-streaming completion request is in flight, `ready` once reply characters
  have been enqueued to the browser.
- Browser status reports transport state plus printing activity: websocket
  `connected` or `disconnected`, overridden by `printing` while PrintQueue is
  non-empty.

### Server state per teletype session

```python
class TtySession:
    def __init__(self, session_id: str):
        self.session_id = session_id                    # passed by client; uuid hex; stable across reconnects
        self.line_acc: list[str] = []                   # chars typed since last '\r'
        self.llm_task: asyncio.Task | None = None       # in-flight completion call (or None)
        self.print_queue = asyncio.Queue(maxsize=4096)  # chars to push to client; ordered FIFO
        self.inflight_char: str | None = None           # one char consumed from queue, awaiting websocket send
        self.ws: WebSocket | None = None                # current connected browser, if any
        self.last_seen: float = 0.0                    # monotonic timestamp for GC


_sessions: dict[str, TtySession] = {}
```

`TtySession` objects are process-local and keyed by browser-generated
`session_id`. A WebSocket connection attaches to an existing session if one is
still in memory; otherwise it creates a new server-side `TtySession` with the
same `session_id`.

### Handler skeleton

```python
async def tty_ws(ws: WebSocket, session: str):
    await ws.accept()
    state = get_or_create_session(session)
    state.ws = ws
    state.last_seen = time.monotonic()

    pump = asyncio.create_task(_pump_outbound(ws, state))
    try:
        async for raw in ws.iter_json():
            if raw.get("t") != "key":
                continue
            ch = raw.get("c", "")
            if not isinstance(ch, str) or len(ch) != 1:
                continue
            if not _is_allowed_input_char(ch):
                continue                                 # discard junk

            if not await _enqueue_print_char(state, ch):
                break                                    # close on queue overflow

            if ch == "\r":
                # Per Model 33: carriage return alone returns the carriage.
                # Always emit LF for ergonomic line-advance behavior.
                if not await _enqueue_print_char(state, "\n"):
                    break
                prompt = "".join(state.line_acc).strip()
                state.line_acc.clear()
                if prompt:
                    # Mechanically-locked input means we cannot interrupt:
                    # if a previous LLM task is still running, queue the next
                    # request to fire after it completes.
                    state.llm_task = asyncio.create_task(
                        _await_then_call(state.llm_task, state, prompt)
                    )
            elif ch == "\b":
                # Include backspace in prompt so overstrike sequences survive.
                if not _append_line_acc(state, ch):
                    await _close_overflow_session(state)
                    break
            else:
                if not _append_line_acc(state, ch):
                    await _close_overflow_session(state)
                    break
    finally:
        pump.cancel()
        if state.ws is ws:
            state.ws = None
        state.last_seen = time.monotonic()


async def _pump_outbound(ws, state):
    while True:
        if state.inflight_char is None:
            state.inflight_char = await state.print_queue.get()
        ch = state.inflight_char
        try:
          await ws.send_json({"t": "out", "c": ch})
          state.inflight_char = None
        except Exception:
          # keep char for replay on reconnect
          break


async def send_status(state, value):
    if state.ws is not None and state.ws.client_state.name == "CONNECTED":
        await state.ws.send_json({"t": "status", "state": value})


async def send_error(state, msg):
    if state.ws is not None and state.ws.client_state.name == "CONNECTED":
        await state.ws.send_json({"t": "error", "msg": msg})


async def _await_then_call(prev_task, state, prompt):
    if prev_task and not prev_task.done():
        try: await prev_task
        except asyncio.CancelledError: pass
    await send_status(state, "thinking")
    try:
        text = await _call_completions(state.session_id, prompt)
    except Exception as exc:
        await send_error(state, str(exc).split("\n", 1)[0])
        await send_status(state, "ready")
        return
    text = ascii_sanitize(text)
    text = normalize_newlines_for_teletype(wrap_text(text, 72))
    for ch in text:
        await state.print_queue.put(ch)
    await state.print_queue.put("\r")
    await state.print_queue.put("\n")
    await send_status(state, "ready")
```

The `llm_task` is not canceled on WebSocket disconnect. If the browser
reconnects while a completion is in flight, the same `TtySession` continues
and the new WS pump drains the queued reply. If the dashboard process exits,
the in-memory queue is lost; the browser keeps the same Hermes session id for
the next turn, but any in-flight reply is gone.

### `_call_completions`

```python
async def _call_completions(session_id: str, prompt: str) -> str:
    url, key = detect_gateway()
    if not key:
        raise RuntimeError(
            "API_SERVER_KEY is required for X-Hermes-Session-Id session continuity"
        )
    body = {
        "messages": [
            {"role": "system", "content": build_system_prompt(columns=72)},
            {"role": "user", "content": prompt},
        ],
    }
    headers = {
        "Content-Type": "application/json",
        "X-Hermes-Session-Id": session_id,
        "Authorization": f"Bearer {key}",
    }
    async with httpx.AsyncClient(timeout=300) as client:
        resp = await client.post(f"{url}/v1/chat/completions",
                                 json=body, headers=headers)
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"]
```

`X-Hermes-Session-Id` carries multi-turn state on the hermes side. The plugin
sends only the current prompt (no client-side history) — exactly hsh's pattern.

### Output preparation

`wrap_text()` is vendored from hsh and returns `\n` line breaks. Before sending
to the browser, normalize line endings for the teletype:

```python
def normalize_newlines_for_teletype(text: str) -> str:
    # Preserve literal CR overstrike sequences from the model. Convert bare LF
    # into CRLF so wrapped ordinary text starts at column 0 on the next row.
    text = text.replace("\r\n", "\n")
    text = text.replace("\n", "\r\n")
    return text
```

---

## Frontend

### Component tree

```
<TeletypePage>                     # /teletype route
  <BootSplash/>                    # "PRESS ANY KEY TO SWITCH ON"; until first keydown
  <PaperRoll                       # canvas, takes available space
       cols={72}
       onKeyDown={key.enqueue}/>
  <StatusBar/>                     # combines backend thinking + transport + local printing
```

The boot splash is required because Web Audio AudioContext can only start in
a user-gesture handler. The first key dismisses it, starts the audio context,
plays the motor-on sample, and after 1500 ms fades to the looping hum.

The built bundle is a single IIFE loaded by the dashboard plugin system. It
must not bundle React. It reads React from `window.__HERMES_PLUGIN_SDK__.React`
and registers the page component with:

```ts
window.__HERMES_PLUGINS__.register("teletype", TeletypePage);
```

### KeyQueue

```ts
class KeyQueue {
  private buf: string[] = [];
  private timer: number | null = null;
  private nextTickAt = 0;
  constructor(private send: (c: string) => void,
              private onTick: () => void) {}   // for key-clack sound

  enqueue(c: string) {
    this.buf.push(c);
    this.startTimer();
  }
  private startTimer() {
    if (this.timer != null) return;
    this.nextTickAt = performance.now();
    this.timer = window.setTimeout(() => this.tick(), 100);
  }
  private tick() {
    const c = this.buf.shift();
    if (c === undefined) {
      window.clearTimeout(this.timer!);
      this.timer = null;
      return;
    }
    this.send(c);
    this.onTick();   // play key-clack
    this.nextTickAt += 100;
    const delay = Math.max(0, this.nextTickAt - performance.now());
    this.timer = window.setTimeout(() => this.tick(), delay);
  }
}
```

Notes:
- Browser keydown is captured by the React component; `KeyQueue.enqueue()` is
  the only way characters reach the WS.
- The 100ms tick is the **input mechanical interlock**. Even if the user mashes
  the keyboard at 200wpm, characters drip into the backend at 10cps.
- No queue cap in the browser-side queues — this preserves type-ahead and local
  print buffering feel. Backend queues are bounded (`line_acc` + `print_queue`) for safety.
- KeyEvent → char mapping must fold to ASCII upper-case. Keys outside
  printable ASCII (function keys, arrow keys) are ignored at the source.
- Special keys: `Enter` → `\r`, `Backspace` → `\b`, `Tab` → `\t`,
  `Ctrl+G` → `\x07` (BEL), `Ctrl+L` → `\x0c` (FF).

### PrintQueue

```ts
class PrintQueue {
  private buf: string[] = [];
  private timer: number | null = null;
  private nextTickAt = 0;
  constructor(private renderer: PaperRoll,
              private audio: AudioEngine,
              private onPrintingChange: (printing: boolean) => void) {}

  enqueue(c: string) {
    this.buf.push(c);
    this.onPrintingChange(true);
    this.audio.lookAhead(c);          // pick channel for next 100ms slot
    this.startTimer();
  }
  private startTimer() {
    if (this.timer != null) return;
    this.nextTickAt = performance.now();
    this.timer = window.setTimeout(() => this.tick(), 100);
  }
  private tick() {
    const c = this.buf.shift();
    if (c === undefined) {
      window.clearTimeout(this.timer!);
      this.timer = null;
      this.audio.fadeToHum();
      this.onPrintingChange(false);
      return;
    }
    const event = this.renderer.outputChar(c);
    this.audio.onPrintChar(c, event);
    if (this.buf.length > 0) this.audio.lookAhead(this.buf[0]);
    this.nextTickAt += 100;
    const delay = Math.max(0, this.nextTickAt - performance.now());
    this.timer = window.setTimeout(() => this.tick(), delay);
  }
}
```

Uses ttyemu's "next-char lookahead" pattern: when a new char arrives, the
audio engine inspects the *next* upcoming char to pre-select chars vs spaces
loop and fade in.

### Renderer (PaperRoll, Canvas2D)

Direct port of `Terminal` + `AbstractLine` from `~/play/ttyemu/ttyemu.py`.

State:
```ts
interface PaperState {
  rows: AbstractLine[];   // every line ever printed; never freed (paper roll)
  col: number;            // current carriage column 0..71
  rowIdx: number;         // current carriage row (= rows.length - 1 typically)
}
```

`AbstractLine` mirrors the Python class: a sparse representation of overstrikes.
For each column, store an array of glyphs. On render, paint them one over
another (semi-opaque ink builds up — second strike darker than first, like
real ribbon ink).

`outputChar(c)`:
```ts
switch (c) {
  case '\n': this.rowIdx++; this.ensureRow(this.rowIdx); break;     // LF
  case '\r': this.col = 0; break;                                    // CR (no LF!)
  case '\t':
    this.col = Math.min(71, ((this.col >> 3) + 1) << 3); break;     // next 8-col stop
  case '\b': this.col = Math.max(0, this.col - 1); break;           // overstrike, no erase
  case '\f': this.rows = []; this.col = 0; this.rowIdx = 0; break;  // form feed
  case '\x07': /* bell — handled by audio */; break;
  default:
    if (c.charCodeAt(0) >= 0x20) {
      const upper = upperFold(c);
      this.rows[this.rowIdx].overstrike(this.col, upper);
      this.col = Math.min(71, this.col + 1);
    }
}
```

`PaperRoll.outputChar()` returns mechanical events for AudioEngine:

```ts
type MechanicalEvent = "marginBell" | "platen" | null;
```

The margin bell is not a completion sound. It is physically tied to carriage
position. For the 72-column plugin default, use:

```ts
const MARGIN_BELL_COLUMN = 68; // one-based character position
```

Teletype Bulletin 310B lists variants: for 72-character lines, one end-of-line
bell configuration rings at approximately character 68, another at 71; separate
margin-bell parts are described around the 61st/63rd character depending on
friction vs sprocket feed. The browser implementation uses 68 as the default
72-column end-of-line warning because it leaves four columns before the line
end. Make it a named constant, not a magic number.

Trigger `marginBell` when forward carriage motion crosses or arrives at the
configured one-based position. Printable characters, spaces, and TAB can all
move the carriage forward; CR, LF, BS, and FF do not ring it. Reset
`lineBellArmed` on CR, LF, or FF so the bell rings at most once per line. This
keeps the bell attached to print-head motion instead of backend response
completion.

Critical detail: **CR alone does not advance the paper.** The user can do
`HELLO\rWORLD` and get `WORLD` overstruck on `HELLO`. Backend auto-injects
`\n` after every typed `\r` for ergonomics, but CR-only sequences from the
LLM (used for ASCII art) are preserved.

Critical detail: **No reverse line feed.** Once `rows[]` is populated past a
row index, you cannot move the cursor back up. This matches the Model 33's
mechanical reality — the platen only ratchets one direction.

`upperFold` ports `~/play/ttyemu/ttyemu.py:37-43` exactly:

```ts
function upperFold(ch: string): string {
  let c = ch.charCodeAt(0);
  c = (c - 32) & 127;
  if (c > 64) c = 32 | (c & 31);
  return String.fromCharCode(c + 32);
}
```

Render loop: RAF at 60fps. Repaint dirty rows only. Auto-scroll to keep new lines
visible; there is no explicit print-head/cursor overlay rendered in v0.

Width: 72 cols × glyph width. Glyph width measured once on font load.
Height: row count × line height; container scrolls on overflow.

### AudioEngine (Web Audio port of `~/play/ttyemu/sounds.py`)

This is the **most critical** subsystem. `ttyemu` implements a realistic
activity-synchronized Teletype sound model: hum is present whenever the machine
is powered and no foreground activity is occurring; foreground activity mutes
or cross-fades the hum; spaces/control motion and printing characters have
distinct continuous loop sounds; CR, BEL, keypresses, platen, lid, and motor
events are one-shot effects layered over that state. This fidelity is a core
requirement, not polish.

#### Asset loading (one-time on AudioContext start)

```ts
const ctx = new AudioContext({ sampleRate: 48000 });   // match WAV files
const buffers: Record<string, AudioBuffer> = {};
for (const name of [
  "up-hum", "down-hum",
  "up-motor-on", "up-motor-off", "down-motor-on", "down-motor-off",
  "up-print-chars-01", "up-print-chars-02",
  "up-print-spaces-01", "up-print-spaces-02",
  "down-print-chars-01", "down-print-chars-02",
  "down-print-spaces-01", "down-print-spaces-02",
  "up-cr-01", "up-cr-02", "up-cr-03",
  "down-cr-01", "down-cr-02", "down-cr-03",
  "up-bell", "down-bell",
  "up-key-01" .. "up-key-07",
  "down-key-01" .. "down-key-07",
  "up-platen", "down-platen",
  "up-lid", "down-lid",
]) {
  const r = await fetch(`/dashboard-plugins/teletype/dist/sounds/${name}.wav`);
  buffers[name] = await ctx.decodeAudioData(await r.arrayBuffer());
}
```

#### Channel structure (mirrors sounds.py 6-channel design)

| Channel | Type | Source | Gain node |
|---|---|---|---|
| `motor` | one-shot | `{lid}-motor-on/off`, `{lid}-lid` | `motorGain` (always 1) |
| `humLoop` | looping | `{lid}-hum.wav` (loop=true) | `humGain` (0..1, faded) |
| `spacesLoop` | looping | `{lid}-print-spaces-0X.wav` | `spacesGain` |
| `charsLoop` | looping | `{lid}-print-chars-0X.wav` | `charsGain` |
| `keyEffects` | one-shot pool | random `{lid}-key-0X.wav` | (full vol) |
| `effects` | one-shot pool | bell, cr, platen | (full vol) |

```ts
const motorGain = ctx.createGain(); motorGain.connect(ctx.destination);
const humGain = ctx.createGain(); humGain.gain.value = 0; humGain.connect(ctx.destination);
const spacesGain = ctx.createGain(); spacesGain.gain.value = 0; spacesGain.connect(ctx.destination);
const charsGain = ctx.createGain(); charsGain.gain.value = 0; charsGain.connect(ctx.destination);
```

The three looping background sources are started when audio boots and restarted
after CR/lid sync events. Their gain is what changes during normal operation:

```ts
function startLoop(buf: AudioBuffer, dest: GainNode): AudioBufferSourceNode {
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  src.connect(dest);
  src.start();
  return src;
}
```

#### Cross-fade primitive

9 ms cross-fades approximate `pygame.time.wait(3)` × 3 in sounds.py. Preserve
the ttyemu shape: the target channel rises through 0.3, 0.5, 0.7, then 1.0
while the other background channels are multiplied down, rather than abruptly
switching samples.

```ts
function fade(g: GainNode, target: number, durMs = 9) {
  const t = ctx.currentTime;
  g.gain.cancelScheduledValues(t);
  g.gain.setValueAtTime(g.gain.value, t);
  g.gain.linearRampToValueAtTime(target, t + durMs / 1000);
}

function fadeToHum() {
  fade(humGain, 1);
  fade(spacesGain, 0);
  fade(charsGain, 0);
}
function fadeToSpaces() {
  fade(humGain, 0);
  fade(spacesGain, 1);
  fade(charsGain, 0);
}
function fadeToChars() {
  fade(humGain, 0);
  fade(spacesGain, 0);
  fade(charsGain, 1);
}
```

### Audio state machine

Port these semantic states from `PygameSounds`:

| State | Meaning | WebAudio action |
|---|---|---|
| `poweredOff` | AudioContext absent/suspended. | no loops, no hum |
| `booting` | User gesture has started the motor. | load buffers, start loops at 0 gain, play `{lid}-motor-on`, schedule sync at 1500 ms |
| `hum` | Powered and idle. | `humGain=1`, `spacesGain=0`, `charsGain=0` |
| `printingSpaces` | Next queued char is space/control motion. | cross-fade to spaces loop, hum down |
| `printingChars` | Next queued char is printable. | cross-fade to chars loop, hum down |
| `effectMute` | Explicit BEL codepoint. | hum/spaces/chars to 0, play bell |

The state machine is driven by the browser PrintQueue. It does not use LLM
timing. A long backend completion may arrive as a burst, but `lookAhead()` and
`onPrintChar()` consume that burst at 100 ms per character and keep the audio
synchronized with the actual printed character activity.

#### Lookahead-driven channel selection

ttyemu's `_sound_for_char` (sounds.py:188–213) inspects the *next* character
in the print queue to pick which loop to fade to. The teletype's mechanical
sound is determined by what's about to print, not what just printed.

```ts
function lookAhead(nextCh: string) {
  if (nextCh === "\r") {
    fadeToSpaces();
    playEffect(`${lid}-cr-${rand(1,3)}`);   // CR sample
    syncLoops(10);                          // restart loops aligned (10 ms wait)
  } else if (nextCh === "\x07") {
    fade(humGain, 0);
    fade(spacesGain, 0);
    fade(charsGain, 0);
    playEffect(`${lid}-bell`);
  } else if (nextCh === " " || nextCh < " ") {
    fadeToSpaces();
  } else {
    fadeToChars();
  }
}
```

#### Print-tick handler

```ts
function onPrintChar(ch: string, event: MechanicalEvent) {
  // Already faded to the right channel by lookAhead.
  // The continuous loop produces the per-char clack sound.
  // CR and BEL code effects were fired in lookAhead.
  if (event === "marginBell") playEffect(`${lid}-bell`);
  if (event === "platen") playEffect(`${lid}-platen`);
}
```

Bell playback detail:
- `up-bell.wav` and `down-bell.wav` are 3.000 second one-shot recordings, not
  100 ms character-tick sounds.
- Explicit BEL (`\x07`) follows ttyemu: `_sound_for_char()` mutes hum, spaces,
  and chars, then plays the bell effect.
- Margin/end-of-line bell is mechanical carriage behavior, not a received BEL
  character. Play the same bell sample on the effects channel without muting or
  changing the current print-loop state, so it rings out and mixes with
  continuing character/space/carriage sounds.
- Effects use one-shot `AudioBufferSourceNode`s on the effects pool. Do not
  truncate bell playback at the next PrintTick.

CR/LF playback detail:
- CR (`\r`) is the only newline-related character with a dedicated one-shot
  effect. `up-cr-0X.wav` and `down-cr-0X.wav` are 0.800 second carriage-return
  recordings. On lookahead, set hum to 0, spaces loop to 1, chars loop to 0,
  play a random CR sample, and schedule `syncLoops(10)`.
- LF (`\n`) has no dedicated one-shot sample in ttyemu. It is classified by
  `_sound_for_char()` as `ord(next_char) <= 32`, so it cross-fades to the
  spaces/control-motion loop for that 100 ms print tick.
- CRLF therefore sounds like: CR thunk/effect plus spaces loop and sync reset,
  followed by an LF tick that continues/renews the spaces/control-motion loop.
  Do not collapse CRLF into a single visual newline event before audio sees
  both characters.
- Bare CR from the model keeps overstrike behavior and still plays the CR
  effect. Bare LF advances paper without resetting column and sounds like
  spaces/control motion.

#### Key-clack (separate channel, fires on KeyTick)

```ts
function onKeyTick() {
  const variant = 1 + Math.floor(Math.random() * 7);
  playEffect(`${lid}-key-${pad(variant)}`);
}
```

Random-of-7 sample to avoid robotic repetition. Each call creates a new
`AudioBufferSourceNode`, plays once, and is GC'd.

#### Boot/shutdown sequence

Boot (on first user gesture):
1. Create AudioContext.
2. Load all WAVs (background, can take 1-2s).
3. Start hum, spaces, and chars loops immediately at gain 0.
4. Play `up-motor-on.wav` (754 KB).
5. After 1500 ms, call `syncLoops(0)` to match ttyemu's startup `EVENT_SYNC`,
   then `fadeToHum()` so idle hum becomes audible.

Shutdown (on tab unmount):
1. Fade humGain to 0 (1000 ms ramp).
2. Play `up-motor-off.wav`.
3. After 500 ms, suspend AudioContext.

#### Lid state

The audio engine has two distinct sample modes: lid up and lid down. `F7`
toggles `lid` between `"up"` and `"down"`. All sample names switch prefix. With
lid down, all sounds are heavily muffled (different recordings, lower
amplitude). This is not a volume shortcut; it is a different acoustic state.
Useful for muting in shared spaces while keeping the visual.
Trigger the current-lid `{lid}-lid` transition sound, then flip `lid`, then
schedule `syncLoops(250)` so the background loops restart with the new-lid
sample set, matching ttyemu's lid behavior.

#### CR sync detail (subtle)

When `\r` plays, the looping background channels need to *restart in sync* so
the perceived rhythm of the print bar resets. ttyemu does this via a 10 ms
timer (`EVENT_SYNC` reset). In Web Audio:

```ts
function syncLoops(waitMs: number) {
  setTimeout(() => {
    // stop+restart the looping sources to reset their playback heads
    humSrc.stop();    humSrc    = startLoop(buffers[`${lid}-hum`], humGain);
    spacesSrc.stop(); spacesSrc = startLoop(buffers[`${lid}-print-spaces-${pickIdx()}`], spacesGain);
    charsSrc.stop();  charsSrc  = startLoop(buffers[`${lid}-print-chars-${pickIdx()}`],  charsGain);
  }, waitMs);
}
```

This is what gives the carriage-return its distinctive "clack-CHUNK-and-the-
rhythm-resets" feel. Skipping this makes the audio feel mechanical-but-wrong.

---

## Special character semantics

| Char | Code | Behavior | Audio |
|---|---|---|---|
| LF (`\n`) | 0x0A | Advance one row; column unchanged. New row created if cursor at end of paper. | spaces/control-motion loop for one tick; no one-shot |
| CR (`\r`) | 0x0D | Cursor → column 0; row unchanged. **Backend auto-injects LF after a `\r` typed by user.** LLM-emitted `\r` without LF is preserved (overstrike). | 0.800s CR one-shot + spaces loop + sync reset |
| TAB (`\t`) | 0x09 | Cursor → next column-multiple-of-8 (max 71). | spaces channel |
| BS (`\b`) | 0x08 | Cursor → max(0, col-1). **No erase. Enables overstrike.** | spaces channel |
| FF (`\f`) | 0x0C | Clear paper roll, cursor to (0,0). | platen sample (paper feed) |
| BEL (`\x07`) | 0x07 | No visual change. Explicit BEL code only. | bell sample, mute hum/print briefly |
| Margin bell | carriage position | No character code; triggered once per line when carriage reaches `MARGIN_BELL_COLUMN`. | bell sample |
| Printable | 0x20–0x7E | Apply `upperFold`, overstrike at current column, advance column (clamped at 71). | chars channel |
| Other | — | Discarded at WS boundary. | — |

### Reverse LF policy

There is no escape sequence for reverse LF. The renderer's API only allows
appending rows; `rowIdx` only increases (or wraps to 0 via FF). This is a
hard architectural limit that mirrors the Model 33's platen ratchet.

### CR + LF interaction

Real Model 33: CR returns the carriage; LF advances the paper. They are
independent. To start a new line you send `\r\n`.

Plugin behavior:
- LLM output is wrapped to 72 cols on the backend with hsh `wrap_text()`,
  which returns `\n` line breaks. The backend then converts bare LF to `\r\n`
  before enqueueing output. The renderer keeps LF as LF-only; it does not
  secretly reset the column.
- User input typing `\r` (Enter): backend auto-emits `\n` after.
- LLM-emitted bare `\r` (for ASCII art): preserved literally. Overstrike
  works as expected.

---

## Reconnect behavior

The Hermes conversation lives in the API server keyed by
`X-Hermes-Session-Id`. The dashboard plugin backend keeps a process-local
`TtySession` keyed by the same browser-generated `?session=<hex>` value.

### Browser → server

On WS open, the browser connects with its persisted `session_id` from
`localStorage["teletype.session_id"]`, or a freshly generated hex id on first run.
The backend uses that as the `X-Hermes-Session-Id` for all completion calls.

If the WS drops, the browser's PrintQueue, KeyQueue, AudioEngine, and paper
roll continue running on whatever they had. The browser auto-reconnects with
exponential backoff (1s, 2s, 4s, max 30s) using the same `session_id`.

### Server → browser

When a new WS opens with a `session_id` the server has seen before:
- Reuse the `TtySession` if still in memory (e.g. brief disconnect during a
  long completion). Continue draining `print_queue` to the new WS.
- If no in-memory session (server restart), create a new `TtySession` with
  the same `session_id` — the *next* completion call will resume hermes-side
  history via the `X-Hermes-Session-Id` header. The paper roll on the
  browser is not restored from the server; it's just whatever the browser
  was already showing.

If a WS disconnects while a plain completion request is in flight, the backend
does not cancel that request. When it returns, its output goes into the
session's `print_queue`. A reconnect within the 5-minute retention window drains
that queue to the new socket. If no browser reconnects before GC, the queued
paper output is discarded.

The server does **not** persist the paper roll. It's an ephemeral physical
artifact. If the user reloads the page, they start with a fresh roll but
keep the conversation context (because the `session_id` survives in
localStorage).

### Cleanup

Stale `TtySession` objects are GC'd by a periodic background task when there is
no active websocket, no in-flight completion task, and no enqueued/replaying
print output (queue empty plus `inflight_char is None`) for > 5 minutes.

---

## End-to-end flow examples

### Example 1: simple turn

1. User loads `/teletype`. Boot splash: "PRESS ANY KEY TO SWITCH ON".
2. User presses `H`. AudioContext starts, motor sample plays, hum fades in,
   WS connects. KeyQueue receives `H`.
3. 0 ms: KeyTick — pop `H`, send to backend, key-clack plays.
4. Backend echoes `H` back: `{"t":"out","c":"H"}`.
5. 30 ms (network round-trip): browser PrintQueue receives `H`.
6. Lookahead: chars channel (printable). Fade to chars-loop.
7. 100 ms (next PrintTick): pop `H`, render, char-clack continues.
8. User types `I` `<Enter>`. Same flow; `\r` triggers CR sample + auto-LF.
9. Backend `line_acc = ["H","I"]`, sends to `/v1/chat/completions` with
   `X-Hermes-Session-Id`.
10. Status flips to "thinking" — small indicator on the page.
11. ~3s later, the non-streaming completion response arrives:
    `"HELLO. HOW CAN I HELP?"`.
12. Backend ASCII-sanitizes, wraps to 72 cols, converts bare LF to CRLF, then
    enqueues the reply chars to the browser as fast as the WS allows.
13. PrintTick drains at 100 ms/char → ~2.2 s of clacking.
14. Backend pushes `\r\n` after the reply. Browser status remains `printing`
    until the local PrintQueue drains, then returns to `connected` or
    `disconnected` based on websocket state. The bell rings only if carriage
    motion reaches the configured margin-bell position.

### Example 2: user types while reply is printing

1. Assistant reply is still printing: PrintQueue has 200 chars buffered,
   draining at 10cps.
2. User starts typing the next prompt while the reply is printing. KeyQueue
   accepts at 10cps.
3. Each keystroke: KeyTick sends → backend echoes → PrintQueue appends to
   the *end* of the existing buffer.
4. Result: user's typed chars print *after* the current LLM output finishes.
   They visually appear on whatever line the printer is on at echo time.
5. User presses Enter. Backend collects `line_acc`; queues a follow-up
   `_call_completions` after the current one.
6. Backend status flips to `thinking` while the second non-streaming completion
   runs; browser status remains `printing` as long as local paper output is
   draining, otherwise `connected`/`disconnected`.

### Deployment notes: plugin websocket mount

Hermes loads dashboard plugin API modules with `spec_from_file_location` + `exec_module`
without requiring `sys.modules` registration. The module must be import-safe under
that execution path. Keep top-level initialization minimal and avoid `dataclass`
decorators or similar patterns that assume the module is already present in
`sys.modules` during class decoration.

### Example 3: overstrike art from LLM

1. LLM emits: `"O\b/\b-\b\\"` (filled circle approximation).
2. Backend ASCII-sanitize preserves these (all < 0x80).
3. Wrap_text doesn't break across them (no whitespace).
4. PrintTick: `O` printed, `\b` moves cursor back, `/` overstrikes `O`,
   `\b` again, `-`, `\b`, `\\`. Final glyph is all four overlaid.
5. AbstractLine stores all four glyphs at column N; renderer paints them
   semi-opaque so the overlap looks like ink build-up.

---

## Phasing

| Phase | Deliverable | Validation |
|---|---|---|
| **0** | Scaffold: directory layout, manifest, theme YAML, plugin shows up as tab. WS round-trip: keystroke → echo → console.log. | Tab appears; pressing keys logs to browser console. |
| **1** | Renderer: PaperRoll canvas, AbstractLine port, special-char handling, upperFold. PrintQueue + 100ms tick (no audio, no print-head visual). | Type "HELLO\rWORLD" → see `WORLD` overstruck on `HELLO`. Backspace overstrike works. |
| **2** | `AbstractLine` renderer + KeyQueue + KeyTick interlock. Test: user mash-types, characters trickle to backend at exactly 10cps while LF/CR/TAB/BS/FF carry forward correctly. | Hold a key down — characters print at 10cps with no acceleration; carriage state tracks columns, CR, LF, TAB, BS, FF. |
| **3** | AudioEngine boot: motor-on → hum loop. Web Audio context starts on first key. | Tab loads, key pressed, motor + hum sound. |
| **4** | Key-clack on KeyTick (random 1-of-7 sample). | Each typed char clacks. Sounds vary. |
| **5** | Print loops + cross-fade: lookahead picks chars vs spaces; chars/spaces gain ramps; CR sample + sync reset. | Distinct print-bar sounds; CR thunks audibly different from regular chars. |
| **6** | LLM proxy: vendor hsh code, system_prompt.txt, `_call_completions`, ascii_sanitize, wrap_text. Status events. | Type a prompt, get a real ASCII reply printed at 10cps. |
| **7** | Margin-bell behavior; FF/BS/TAB edge cases verified. Reconnect logic. | Bell rings when carriage reaches `MARGIN_BELL_COLUMN`, not on completion. Disconnect WS during a completion or queued printout, reconnect, see queued output drain if server retained the session. |
| **8** | Theme polish: paper texture, Teletype33 font, color palette, paper card chrome. | Looks right. |
| **9** | Lid toggle (F7), fast-mode (F5, optional dev tool). README + install instructions. | Self-documenting demo. |

Working end-to-end demo at phase 6. Phases 7–9 are polish.

---

## Implementation decisions

1. **Completion transport**: use plain non-streaming `/v1/chat/completions`.
   The backend receives the full final response, then the browser prints it at
   10cps. No SSE in v0.
2. **WebSocket framing**: use JSON WebSocket messages for v0. One `out` message
   per character is verbose but simple and adequate on localhost.
3. **Print queue bounds**: browser key/output queues are effectively unbounded for
   behavioral realism, while server-side safety bounds exist:
   `TtySession.line_acc` and `TtySession.print_queue` are capped to fixed
   limits and reconnect sessions drain before GC.
4. **Page reload during printout**: server does not persist paper state.
   Browser reload starts a fresh roll but keeps the Hermes session id in
   localStorage. A reconnect without reload can drain the server queue if the
   dashboard process retained it.
5. **Mobile / touch keyboards**: not supported in v0. The keyboard model is
   desktop-only.
6. **Accessibility**: deferred. Canvas is the renderer for v0; a hidden DOM
   mirror may be added later.
7. **Build system**: browser bundle is committed directly as `dist/index.js` (a small hand-authored IIFE). React comes from
   `window.__HERMES_PLUGIN_SDK__.React` (external). No server-side build step is
   required in v0.
8. **Font license**: ship `Teletype33.ttf` with `LICENSE-Teletype33.txt` (CC0
   1.0 Universal — public-domain dedication).
9. **Bell source**: no synthetic completion bell. Ring the bell for explicit
   BEL codepoints and for carriage-position margin/end-of-line behavior. The
   default 72-column warning position is `MARGIN_BELL_COLUMN = 68`, documented
   as a named constant because real Model 33 configurations vary.
10. **Audio lid modes**: lid up and lid down are separate sample sets, not a
   volume multiplier. F7 switches acoustic mode and restarts loops after the
   lid transition.

---

## References in code

- `~/play/ttyemu/ttyemu.py:37-43`     `upper()` bit-twiddle
- `~/play/ttyemu/ttyemu.py:57-106`    `AbstractLine` overstrike representation
- `~/play/ttyemu/ttyemu.py:431-538`   `Terminal` class (output_char + scroll)
- `~/play/ttyemu/ttyemu.py:592,662,721`  `time.sleep(0.105)` per-char interlock
- `~/play/ttyemu/sounds.py:28-95`     audio init + channel reservation
- `~/play/ttyemu/sounds.py:178-213`   print/lookahead state machine
- `~/play/ttyemu/sounds.py:215-273`   three fade primitives (hum/spaces/chars)
- `~/play/ttyemu/sounds.py:194-201`   CR audio + sync reset
- `~/play/hermes-shell/hermes_shell/shell.py:23-25`     `_ASCII_TABLE`
- `~/play/hermes-shell/hermes_shell/shell.py:81-146`    gateway detection
- `~/play/hermes-shell/hermes_shell/shell.py:206-243`   `run_turn_gateway`
- `~/play/hermes-shell/hermes_shell/shell.py:246-271`   `ascii_sanitize` + `wrap_text`
- `~/play/hermes-shell/hermes_shell/system_prompt.txt`  source for plugin's prompt
- `~/play/hermes-agent/web/src/plugins/`                plugin SDK reference
- `~/play/hermes-agent/plugins/example-dashboard/`      minimal plugin template
- `~/play/hermes-agent/plugins/strike-freedom-cockpit/` plugin + theme template
- Teletype Bulletin 310B Vol. 2, Section 574-122-700TC 2.120-2.122:
  line-length selection, margin bell, and end-of-line bell variants.
