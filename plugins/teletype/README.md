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

## Licensing

`dashboard/dist/fonts/TELE_B.TTF` is copyright Mark Zanzig (1995), free for
personal use. `dashboard/dist/fonts/LICENSE-TELE_B.txt` documents that the plugin
license file applies only to code, not to font usage.
