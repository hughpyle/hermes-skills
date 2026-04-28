import asyncio
import base64
import importlib.util
import sys
import types
from pathlib import Path

import pytest

# Keep these helper tests independent of dashboard runtime dependencies.
class _RouterStub:
    def websocket(self, *_args, **_kwargs):
        return lambda func: func

    def post(self, *_args, **_kwargs):
        return lambda func: func

    def get(self, *_args, **_kwargs):
        return lambda func: func


if "httpx" not in sys.modules:
    sys.modules["httpx"] = types.SimpleNamespace(
        AsyncClient=object,
        HTTPStatusError=Exception,
        RequestError=Exception,
    )
if "fastapi" not in sys.modules:
    sys.modules["fastapi"] = types.SimpleNamespace(APIRouter=_RouterStub, WebSocket=object)

_PLUGIN_PATH = (
    Path(__file__).resolve().parent.parent
    / "plugins"
    / "teletype"
    / "dashboard"
    / "plugin_api.py"
)
_spec = importlib.util.spec_from_file_location("teletype_plugin_api", _PLUGIN_PATH)
plugin_api = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(plugin_api)

OutputSegment = plugin_api.OutputSegment
split_output_segments = plugin_api.split_output_segments


def test_binary_block_preserves_cr_only():
    payload = base64.b64encode(b"A\rB\r\n").decode("ascii")
    segments = split_output_segments(f"<BINARY>{payload}</BINARY>")
    assert segments == [OutputSegment("raw", "A\rB\r\n")]


def test_mixed_text_and_binary_segments():
    payload = base64.b64encode(b"X\rY").decode("ascii")
    segments = split_output_segments(f"HI\n<BINARY>{payload}</BINARY>BYE")
    assert [s.kind for s in segments] == ["text", "raw", "text"]
    assert segments[0].data == "HI\n"
    assert segments[1].data == "X\rY"
    assert segments[2].data == "BYE"


def test_double_angle_binary_marker():
    payload = base64.b64encode(b"Z\r").decode("ascii")
    segments = split_output_segments(f"<<BINARY>>{payload}<</BINARY>>")
    assert len(segments) == 1
    assert segments[0].kind == "raw"
    assert segments[0].data == "Z\r"


def test_invalid_binary_base64_rejected():
    with pytest.raises(ValueError):
        split_output_segments("<BINARY>!!!!</BINARY>")


def test_binary_block_unsupported_byte_rejected():
    payload = base64.b64encode(b"\x00abc").decode("ascii")
    with pytest.raises(ValueError):
        split_output_segments(f"<BINARY>{payload}</BINARY>")


def test_whitespace_inside_payload_is_ignored():
    raw = b"HELLO\rWORLD"
    encoded = base64.b64encode(raw).decode("ascii")
    chunked = "\n".join(encoded[i : i + 8] for i in range(0, len(encoded), 8))
    segments = split_output_segments(f"<BINARY>\n{chunked}\n</BINARY>")
    assert len(segments) == 1
    assert segments[0].kind == "raw"
    assert segments[0].data == raw.decode("ascii")


def test_no_binary_block_returns_single_text_segment():
    text = "plain ASCII\nwith newline"
    segments = split_output_segments(text)
    assert segments == [OutputSegment("text", text)]


def test_multiple_binary_blocks_are_each_isolated():
    p1 = base64.b64encode(b"A\r").decode("ascii")
    p2 = base64.b64encode(b"B\r").decode("ascii")
    msg = f"start <BINARY>{p1}</BINARY> mid <BINARY>{p2}</BINARY> end"
    segments = split_output_segments(msg)
    kinds = [s.kind for s in segments]
    assert kinds == ["text", "raw", "text", "raw", "text"]
    assert segments[1].data == "A\r"
    assert segments[3].data == "B\r"


def test_format_text_for_teletype_wraps_and_normalizes():
    out = plugin_api.format_text_for_teletype("hello\nworld")
    assert out == "hello\r\nworld"


def test_mixed_enqueue_preserves_separator_before_raw_block():
    async def run():
        state = plugin_api.TtySession("a" * 32)
        raw = b"A\rB\r\n"
        payload = base64.b64encode(raw).decode("ascii")
        ok = await plugin_api._enqueue_assistant_output(
            state,
            f"HI\n<BINARY>{payload}</BINARY>BYE",
        )
        assert ok
        return "".join(
            state.print_queue.get_nowait() for _ in range(state.print_queue.qsize())
        )

    assert asyncio.run(run()) == "HI\r\nA\rB\r\nBYE"


def test_wave_file_round_trips_through_split_output_segments():
    wave_path = (
        Path(__file__).resolve().parent.parent
        / "skills"
        / "tty"
        / "images"
        / "wave.txt"
    )
    raw = wave_path.read_bytes()
    msg = "<BINARY>\n" + base64.b64encode(raw).decode("ascii") + "\n</BINARY>"
    segments = split_output_segments(msg)
    assert len(segments) == 1
    assert segments[0].kind == "raw"
    assert segments[0].data.encode("ascii") == raw
    assert raw.count(b"\r") > 0


def test_gateway_probe_reports_disconnected_on_request_error(monkeypatch):
    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def get(self, url):
            raise plugin_api.httpx.RequestError("connection refused")

    monkeypatch.setattr(plugin_api, "detect_gateway", lambda: ("http://127.0.0.1:8642", "secret"))
    monkeypatch.setattr(plugin_api.httpx, "AsyncClient", FakeClient)

    result = asyncio.run(plugin_api.probe_gateway())

    assert result["ok"] is False
    assert result["state"] == "disconnected"
    assert result["url"] == "http://127.0.0.1:8642"
    assert result["api_key"] is True


def test_gateway_probe_reports_missing_key_when_reachable(monkeypatch):
    calls = []

    class FakeResponse:
        status_code = 200

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def get(self, url):
            calls.append(url)
            return FakeResponse()

    monkeypatch.setattr(plugin_api, "detect_gateway", lambda: ("http://127.0.0.1:8642", None))
    monkeypatch.setattr(plugin_api.httpx, "AsyncClient", FakeClient)

    result = asyncio.run(plugin_api.probe_gateway())

    assert result["ok"] is False
    assert result["state"] == "missing_key"
    assert result["api_key"] is False
    assert calls == ["http://127.0.0.1:8642/health/detailed"]


def test_gateway_probe_reports_connected_with_key_when_reachable(monkeypatch):
    class FakeResponse:
        status_code = 200

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def get(self, url):
            return FakeResponse()

    monkeypatch.setattr(plugin_api, "detect_gateway", lambda: ("http://127.0.0.1:8642", "secret"))
    monkeypatch.setattr(plugin_api.httpx, "AsyncClient", FakeClient)

    result = asyncio.run(plugin_api.probe_gateway())

    assert result["ok"] is True
    assert result["state"] == "connected"
    assert result["api_key"] is True
