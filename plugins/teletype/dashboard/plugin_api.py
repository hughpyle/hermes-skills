from __future__ import annotations

import asyncio
import base64
import binascii
import logging
import os
from collections import deque
import re
import textwrap
import time
import typing
import unicodedata
import uuid
from pathlib import Path
from contextlib import suppress

import httpx
from fastapi import APIRouter, WebSocket

logger = logging.getLogger(__name__)
router = APIRouter()

_COLUMNS = 72
_CLEANUP_INTERVAL_SECONDS = 30
_SESSION_TTL_SECONDS = 5 * 60
_CACHED_SYSTEM_PROMPT: str | None = None
_LINE_ACC_LIMIT = 4096
_PRINT_QUEUE_LIMIT = 65536
_TRANSCRIPT_LIMIT = 200_000
_SESSION_ID_LENGTH = 32

_HERMES_DIR = Path.home() / ".hermes"
_HERMES_CONFIG = _HERMES_DIR / "config.yaml"
_HERMES_ENV = _HERMES_DIR / ".env"

_ASCII_TABLE = {i: None for i in range(128, 0x110000)}
_ASCII_TABLE[0x07] = 0x07  # Preserve explicit BEL.

_sessions: dict[str, "TtySession"] = {}
_cleanup_task: asyncio.Task[None] | None = None


class TtySession:
    def __init__(self, session_id: str):
        self.session_id = session_id
        self.line_acc: list[str] = []
        self.llm_task: asyncio.Task[None] | None = None
        self.print_queue: asyncio.Queue[str] = asyncio.Queue(maxsize=_PRINT_QUEUE_LIMIT)
        self.transcript: deque[str] = deque(maxlen=_TRANSCRIPT_LIMIT)
        self.inflight_char: str | None = None
        self.ws: WebSocket | None = None
        self.last_seen: float = 0.0
        self.prompt_needed = True
        self.prompt_pending = False


def _read_dotenv(path: Path) -> dict[str, str]:
    """Read KEY=VALUE pairs from a .env file."""
    values: dict[str, str] = {}
    try:
        text = path.read_text()
    except OSError:
        return values

    for line in text.splitlines():
        raw = line.strip()
        if not raw or raw.startswith("#"):
            continue
        if raw.startswith("export "):
            raw = raw[7:]
        value_text = raw.split("#", 1)[0].strip()
        if not value_text or "=" not in value_text:
            continue
        key, value = value_text.split("=", 1)
        values[key.strip()] = value.strip().strip("'\"")
    return values


def _read_gateway_config() -> tuple[str | None, int | None, str | None]:
    """Parse `api_server` from `~/.hermes/config.yaml` using simple line parsing."""
    try:
        text = _HERMES_CONFIG.read_text()
    except OSError:
        return None, None, None

    in_api_server = False
    key: str | None = None
    port: int | None = None
    host: str | None = None

    for raw_line in text.splitlines():
        stripped = raw_line.strip()
        if stripped == "api_server:":
            in_api_server = True
            continue
        if in_api_server:
            if raw_line and not raw_line[0].isspace():
                break
            if stripped.startswith("key:"):
                _, value = stripped.split(":", 1)
                key = value.strip().strip("'\"")
            elif stripped.startswith("host:"):
                _, value = stripped.split(":", 1)
                host = value.strip().strip("'\"")
            elif stripped.startswith("port:"):
                _, value = stripped.split(":", 1)
                try:
                    port = int(value.strip())
                except ValueError:
                    port = None
    return key, port, host


def detect_gateway() -> tuple[str, str | None]:
    """Resolve Hermes gateway URL and API key from environment + `~/.hermes` files."""
    dotenv = _read_dotenv(_HERMES_ENV)
    api_key = os.getenv("API_SERVER_KEY") or dotenv.get("API_SERVER_KEY")

    host = os.getenv("API_SERVER_HOST") or dotenv.get("API_SERVER_HOST") or "127.0.0.1"
    port_text = os.getenv("API_SERVER_PORT") or dotenv.get("API_SERVER_PORT")
    try:
        port = int(port_text) if port_text else None
    except ValueError:
        port = None

    cfg_key, cfg_port, cfg_host = _read_gateway_config()
    if not api_key and cfg_key:
        api_key = cfg_key
    if not port and cfg_port:
        port = cfg_port
    if not os.getenv("API_SERVER_HOST") and not dotenv.get("API_SERVER_HOST") and cfg_host:
        host = cfg_host

    return f"http://{host}:{port or 8642}", api_key


def build_system_prompt(columns: int) -> str:
    global _CACHED_SYSTEM_PROMPT
    if _CACHED_SYSTEM_PROMPT is None:
        path = Path(__file__).resolve().parent / "system_prompt.txt"
        _CACHED_SYSTEM_PROMPT = path.read_text()
    return _CACHED_SYSTEM_PROMPT.replace("{columns}", str(columns))


def ascii_sanitize(text: str) -> str:
    return unicodedata.normalize("NFKD", text).translate(_ASCII_TABLE)


def wrap_text(text: str, width: int) -> str:
    width = max(8, width)
    out_lines: list[str] = []
    for line in text.split("\n"):
        stripped = line.rstrip(" \t\f\v\n")
        if len(stripped) <= width:
            out_lines.append(stripped)
            continue
        indent = stripped[: len(stripped) - len(stripped.lstrip())]
        body = stripped.lstrip()
        usable = width - len(indent)
        if usable < 8:
            usable = width
            indent = ""
        wrapped = textwrap.fill(
            body,
            width=usable,
            break_long_words=True,
            break_on_hyphens=False,
            initial_indent=indent,
            subsequent_indent=indent,
        )
        out_lines.append(wrapped)
    while out_lines and out_lines[-1] == "":
        out_lines.pop()
    return "\n".join(out_lines)


def normalize_newlines_for_teletype(text: str) -> str:
    text = text.replace("\r\n", "\n")
    return text.replace("\n", "\r\n")


_BINARY_BLOCK_RE = re.compile(
    r"(?s)(<BINARY>\s*(.*?)\s*</BINARY>|<<BINARY>>\s*(.*?)\s*<</BINARY>>)",
    re.IGNORECASE,
)


class OutputSegment(typing.NamedTuple):
    kind: str  # "text" or "raw"
    data: str


def _is_allowed_output_byte(value: int) -> bool:
    return value in (0x07, 0x08, 0x09, 0x0A, 0x0C, 0x0D) or 0x20 <= value <= 0x7E


def _decode_binary_payload(payload: str) -> str:
    compact = re.sub(r"\s+", "", payload)
    try:
        raw = base64.b64decode(compact, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("invalid binary block base64") from exc
    bad = [byte for byte in raw if not _is_allowed_output_byte(byte)]
    if bad:
        raise ValueError("binary block contains unsupported control bytes")
    return raw.decode("ascii")


def split_output_segments(text: str) -> list[OutputSegment]:
    segments: list[OutputSegment] = []
    pos = 0
    for match in _BINARY_BLOCK_RE.finditer(text):
        if match.start() > pos:
            segments.append(OutputSegment("text", text[pos:match.start()]))
        payload = match.group(2) if match.group(2) is not None else match.group(3)
        segments.append(OutputSegment("raw", _decode_binary_payload(payload or "")))
        pos = match.end()
    if pos < len(text):
        segments.append(OutputSegment("text", text[pos:]))
    return segments


def format_text_for_teletype(text: str, preserve_trailing_newlines: bool = False) -> str:
    text = ascii_sanitize(text)
    trailing_lfs = len(text) - len(text.rstrip("\n")) if preserve_trailing_newlines else 0
    output = normalize_newlines_for_teletype(wrap_text(text, _COLUMNS))
    if trailing_lfs:
        missing = trailing_lfs - (len(output) - len(output.rstrip("\n")))
        if output and not output.endswith("\r\n"):
            output += "\r\n"
            missing -= 1
        if missing > 0:
            output += "\r\n" * missing
    return output


def get_or_create_session(session_id: str) -> TtySession:
    try:
        session = _sessions[session_id]
        session.last_seen = time.monotonic()
        return session
    except KeyError:
        session = TtySession(session_id=session_id)
        session.last_seen = time.monotonic()
        _sessions[session_id] = session
        return session


async def _reap_sessions() -> None:
    while True:
        await asyncio.sleep(_CLEANUP_INTERVAL_SECONDS)
        now = time.monotonic()
        for sid, session in list(_sessions.items()):
            stale = (
                session.ws is None
                and now - session.last_seen > _SESSION_TTL_SECONDS
                and not session.llm_task
                and session.print_queue.empty()
                and session.inflight_char is None
            )
            if stale:
                _sessions.pop(sid, None)


def _ensure_reaper() -> None:
    global _cleanup_task
    if _cleanup_task is not None:
        return
    try:
        _cleanup_task = asyncio.create_task(_reap_sessions())
    except RuntimeError:
        # Called before an event loop is active.
        _cleanup_task = None


def _is_ws_connected(ws: WebSocket | None) -> bool:
    if ws is None:
        return False
    try:
        return ws.client_state.name == "CONNECTED"
    except Exception:
        return False


async def send_status(state: TtySession, value: str) -> None:
    if not _is_ws_connected(state.ws):
        return
    try:
        await state.ws.send_json({"t": "status", "state": value})
    except Exception as exc:
        # Client disappeared between the connected-check and the send.
        logger.debug("teletype: status send failed (%s): %s", value, exc)


async def send_error(state: TtySession, msg: str) -> None:
    if not _is_ws_connected(state.ws):
        return
    try:
        await state.ws.send_json({"t": "error", "msg": msg})
    except Exception as exc:
        logger.debug("teletype: error send failed: %s", exc)


async def _pump_outbound(ws: WebSocket, state: TtySession) -> None:
    try:
        while True:
            if state.inflight_char is None:
                state.inflight_char = await state.print_queue.get()
            if ws.client_state.name != "CONNECTED":
                break
            try:
                await ws.send_json({"t": "out", "c": state.inflight_char})
                state.transcript.append(state.inflight_char)
                if state.prompt_pending and _transcript_ends_with_prompt(state):
                    state.prompt_pending = False
                state.inflight_char = None
            except Exception:
                # Keep the char for replay on next connection.
                break
    except asyncio.CancelledError:
        return


async def _call_completions(session_id: str, prompt: str) -> str:
    url, api_key = detect_gateway()
    if not api_key:
        raise RuntimeError(
            "API_SERVER_KEY is required for X-Hermes-Session-Id session continuity"
        )

    body = {
        "messages": [
            {"role": "system", "content": build_system_prompt(columns=_COLUMNS)},
            {"role": "user", "content": prompt},
        ],
    }
    headers = {
        "Content-Type": "application/json",
        "X-Hermes-Session-Id": session_id,
        "Authorization": f"Bearer {api_key}",
    }
    async with httpx.AsyncClient(timeout=300.0) as client:
        try:
            response = await client.post(f"{url}/v1/chat/completions", json=body, headers=headers)
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise RuntimeError(f"completion request failed with status {exc.response.status_code}") from exc
        except httpx.RequestError as exc:
            raise RuntimeError("completion request failed") from exc
        data = response.json()
    return data["choices"][0]["message"]["content"]


async def _send_overflow_error(state: TtySession) -> None:
    if state.ws is None:
        return
    with suppress(Exception):
        await state.ws.send_json({"t": "error", "msg": "session overflow"})


def _is_allowed_input_char(ch: str) -> bool:
    if ch in ("\x07", "\b", "\t", "\n", "\r", "\f"):
        return True
    return " " <= ch <= "~"


async def _close_overflow_session(state: TtySession) -> None:
    await _send_overflow_error(state)
    if not state.ws:
        return
    if state.ws.client_state.name != "CONNECTED":
        state.ws = None
        return
    with suppress(Exception):
        await state.ws.close(code=1009, reason="session queue overflow")
    state.ws = None


async def _clear_session_state(state: TtySession) -> None:
    """Clear volatile terminal state for a session while keeping the session id."""
    state.line_acc.clear()
    state.transcript.clear()
    state.inflight_char = None
    state.prompt_needed = True
    state.prompt_pending = False
    _drain_print_queue(state)
    await _cancel_llm_task(state)
    if state.ws is not None and state.ws.client_state.name == "CONNECTED":
        with suppress(Exception):
            await state.ws.close(code=1000, reason="session cleared")
    state.ws = None


def _drain_print_queue(state: TtySession) -> None:
    while True:
        try:
            state.print_queue.get_nowait()
        except asyncio.QueueEmpty:
            break


async def _cancel_llm_task(state: TtySession) -> None:
    if state.llm_task is not None and not state.llm_task.done():
        state.llm_task.cancel()
        with suppress(asyncio.CancelledError):
            await state.llm_task
    state.llm_task = None


async def _enqueue_print_char(state: TtySession, ch: str) -> bool:
    try:
        state.print_queue.put_nowait(ch)
        return True
    except asyncio.QueueFull:
        await _close_overflow_session(state)
        return False


async def _enqueue_assistant_output(state: TtySession, text: str) -> bool:
    segments = split_output_segments(text)
    for segment in segments:
        if segment.kind == "raw":
            output = segment.data
        else:
            output = format_text_for_teletype(
                segment.data,
                preserve_trailing_newlines=segment is not segments[-1],
            )
        for ch in output:
            if not await _enqueue_print_char(state, ch):
                return False
    return True


async def _enqueue_prompt(state: TtySession) -> bool:
    if state.prompt_pending:
        return True
    if not await _enqueue_print_char(state, ">"):
        return False
    if not await _enqueue_print_char(state, " "):
        return False
    state.prompt_needed = False
    state.prompt_pending = True
    return True


def get_session_transcript(state: TtySession) -> str:
    return "".join(state.transcript)


def _append_line_acc(state: TtySession, ch: str) -> bool:
    if len(state.line_acc) >= _LINE_ACC_LIMIT:
        return False
    state.line_acc.append(ch)
    return True


def _transcript_ends_with_prompt(state: TtySession) -> bool:
    if len(state.transcript) < 2:
        return False
    if len(state.transcript) == 2:
        return state.transcript[0] == ">" and state.transcript[1] == " "
    if state.transcript[-2] != ">" or state.transcript[-1] != " ":
        return False
    return state.transcript[-3] in "\r\n"


async def _ensure_prompt(state: TtySession) -> bool:
    if state.line_acc:
        return True
    if state.prompt_pending:
        return True
    if state.prompt_needed or not _transcript_ends_with_prompt(state):
        return await _enqueue_prompt(state)
    return True


async def _interrupt_session(state: TtySession) -> bool:
    await _cancel_llm_task(state)
    _drain_print_queue(state)
    state.inflight_char = None
    state.line_acc.clear()
    state.prompt_needed = True
    state.prompt_pending = False
    for ch in ("\r", "\n"):
        if not await _enqueue_print_char(state, ch):
            return False
    return await _enqueue_prompt(state)



async def _await_then_call(
    prev_task: asyncio.Task[None] | None,
    state: TtySession,
    prompt: str,
) -> None:
    if prev_task is not None and not prev_task.done():
        try:
            await prev_task
        except asyncio.CancelledError:
            pass

    current_task = asyncio.current_task()
    state.llm_task = current_task
    await send_status(state, "thinking")
    try:
        text = await _call_completions(state.session_id, prompt)
    except Exception as exc:
        await send_error(state, str(exc).split("\n", 1)[0])
        await send_status(state, "ready")
        if state.llm_task is current_task:
            state.llm_task = None
        return

    try:
        ok = await _enqueue_assistant_output(state, text)
    except ValueError as exc:
        await send_error(state, str(exc).split("\n", 1)[0])
        await send_status(state, "ready")
        if state.llm_task is current_task:
            state.llm_task = None
        return
    if not ok:
        if state.llm_task is current_task:
            state.llm_task = None
        await send_status(state, "ready")
        return
    for ch in ("\r", "\n"):
        if not await _enqueue_print_char(state, ch):
            if state.llm_task is current_task:
                state.llm_task = None
            await send_status(state, "ready")
            return
    if state.prompt_needed and not await _enqueue_prompt(state):
        if state.llm_task is current_task:
            state.llm_task = None
        await send_status(state, "ready")
        return
    await send_status(state, "ready")
    if state.llm_task is current_task:
        state.llm_task = None


@router.websocket("/tty")
async def tty_ws(ws: WebSocket, session: str | None = None):
    await ws.accept()

    _ensure_reaper()

    session_id = session or uuid.uuid4().hex
    if not re.fullmatch(rf"[0-9a-fA-F]{{{_SESSION_ID_LENGTH}}}", session_id):
        session_id = uuid.uuid4().hex

    state = get_or_create_session(session_id)
    state.ws = ws
    state.last_seen = time.monotonic()
    await _ensure_prompt(state)
    await send_status(state, "ready")

    pump = asyncio.create_task(_pump_outbound(ws, state))
    try:
        while True:
            try:
                raw = await ws.receive_json()
            except Exception:
                break
            if not isinstance(raw, dict):
                continue
            if raw.get("t") == "prompt":
                if not await _ensure_prompt(state):
                    break
                continue
            if raw.get("t") == "interrupt":
                if not await _interrupt_session(state):
                    break
                await send_status(state, "ready")
                continue
            if raw.get("t") != "key":
                continue

            ch = raw.get("c")
            if not isinstance(ch, str) or len(ch) != 1:
                continue
            if not _is_allowed_input_char(ch):
                continue

            if ch == "\r":
                if not await _enqueue_print_char(state, ch):
                    break
                prompt = "".join(state.line_acc).strip()
                if not await _enqueue_print_char(state, "\n"):
                    break
                was_empty_line = not prompt
                state.line_acc.clear()
                if was_empty_line:
                    if not await _enqueue_prompt(state):
                        break
                    continue
                state.prompt_needed = True
                if prompt:
                    state.llm_task = asyncio.create_task(_await_then_call(state.llm_task, state, prompt))
            elif ch == "\b":
                if not await _enqueue_print_char(state, ch):
                    break
                if not _append_line_acc(state, ch):
                    await _close_overflow_session(state)
                    break
            elif ch == "\f":
                if not await _enqueue_print_char(state, ch):
                    break
                state.line_acc.clear()
            elif ch == "\x07":
                if not await _enqueue_print_char(state, ch):
                    break
            else:
                if state.prompt_needed:
                    if not await _enqueue_prompt(state):
                        break
                if not await _enqueue_print_char(state, ch):
                    break
                if not _append_line_acc(state, ch):
                    await _close_overflow_session(state)
                    break
    finally:
        pump.cancel()
        if state.ws is ws:
            state.ws = None
        state.last_seen = time.monotonic()


@router.post("/tty/clear")
async def tty_clear(session: str | None = None):
    if session and not re.fullmatch(rf"[0-9a-fA-F]{{{_SESSION_ID_LENGTH}}}", session):
        return {"ok": False, "error": "invalid_session"}
    if session:
        old_state = _sessions.pop(session, None)
        if old_state is not None:
            await _clear_session_state(old_state)
    new_session = uuid.uuid4().hex
    _sessions[new_session] = TtySession(new_session)
    return {"ok": True, "session": new_session}


@router.get("/tty/transcript")
async def tty_transcript(session: str | None = None):
    if not session or not re.fullmatch(rf"[0-9a-fA-F]{{{_SESSION_ID_LENGTH}}}", session):
        return {"transcript": "", "session": session, "ok": False}

    state = get_or_create_session(session)
    return {
        "ok": True,
        "session": session,
        "transcript": get_session_transcript(state),
    }
