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

`dashboard/dist/fonts/Teletype33.ttf` is released under CC0 1.0 Universal
(public domain dedication); see `dashboard/dist/fonts/LICENSE-Teletype33.txt`.
Source: https://github.com/hughpyle/Teletype33-Font
