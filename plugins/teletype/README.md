# Teletype Hermes Plugin

This plugin adds a full dashboard tab at `/teletype` that emulates a Model 33
teletype printer with 10 cps print timing.

It uses:

- `/api/plugins/teletype/tty` for websocket key echoing and completion bridging.
- `/api/plugins/teletype/` manifest/plugin discovery in Hermes Dashboard.
- A locally-hosted `dist` bundle under this directory for renderer/audio.
- v0 renders only paper text and mechanical audio; no explicit print-head/cursor
  visual.

## Install

```sh
cd ~/play/tty-skills
ln -s "$(pwd)/plugins/teletype" ~/.hermes/plugins/teletype
cp themes/teletype.yaml ~/.hermes/dashboard-themes/
```

Then restart the dashboard process so plugin API routes are remounted.
Select `Teletype` theme from the dashboard theme picker (or set
`dashboard.theme: teletype` in `~/.hermes/config.yaml`).

The WebSocket endpoint is local-host local-only by design: `/api/plugins/teletype/tty` trusts the dashboard host process and has no
separate token auth. If you expose the dashboard outside localhost, proxy it behind your own auth before relying on this plugin.

## Environment

The backend calls the Hermes API server at `/v1/chat/completions` using the same
session ID for continuity and requires `API_SERVER_KEY`:

- `~/.hermes/.env` (`API_SERVER_KEY`, optional `API_SERVER_HOST`, `API_SERVER_PORT`)
- environment variables
- `~/.hermes/config.yaml` (`api_server: key/host/port`)

Without `API_SERVER_KEY`, the plugin still echoes input but cannot resume sessions
with `X-Hermes-Session-Id`.

## Dashboard controls

The toolbar at the top of the paper roll has three controls:

- `33` / `37`: typewheel/case mode. `33` (default) emulates the ASR-33's
  uppercase-only print head — incoming codepoints in 0x60-0x7F are folded
  down to 0x40-0x5F at render time (`a`→`A`, `` ` ``→`@`, `~`→`^`,
  `{|}`→`[\]`). `37` allows lowercase, like a Model 37. Setting is
  persisted in localStorage; the toggle affects future characters only,
  not text already on the paper.
- `OPEN LID` / `CLOSE LID`: switches between lid-up and lid-down audio
  sample sets. Also bound to F7.
- `CLEAR`: clears the session and starts a fresh paper roll.

Typed input is always sent to the backend cleanly — no case folding at
send time. Case folding happens only in the renderer.

## Binary output blocks

Assistant replies may include base64 blocks for byte-accurate teletype output:

```text
<BINARY>
BASE64...
</BINARY>
```

or:

```text
<<BINARY>>
BASE64...
<</BINARY>>
```

The backend decodes these blocks and sends the resulting ASCII/control bytes
straight to the printer queue, bypassing wrapping, Unicode sanitizing, and LF to
CRLF normalization. This is intended for CR-only overstrike art and similar
paper-tape-style byte streams. Decoded bytes are limited to printable ASCII plus
BEL, BS, TAB, LF, FF, and CR; malformed blocks report an error instead of
printing corrupted marker text.

## Licensing

`dashboard/dist/fonts/Teletype33.ttf` (by progs-n-things) is released under
CC0 1.0 Universal (public domain dedication); see
`dashboard/dist/fonts/LICENSE-Teletype33.txt`.
Source: https://github.com/progs-n-things/Teletype33-Font
