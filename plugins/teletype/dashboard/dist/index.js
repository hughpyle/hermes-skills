(function () {
  "use strict";

  const SDK = window.__HERMES_PLUGIN_SDK__;
  if (!SDK || !SDK.React || !window.__HERMES_PLUGINS__) {
    return;
  }

  const { React } = SDK;
  const { useCallback, useEffect, useRef, useState } = SDK.hooks;

  const COLUMNS = 72;
  const TICK_MS = 100;
  const MARGIN_BELL_COLUMN = 68; // one-based carriage position for 72-column roll
  const CR_RETURN_MIN_DELAY_MS = 20;
  const CR_RETURN_PER_COLUMN_MS = 4;
  const CR_RETURN_MAX_DELAY_MS = 320;
  const SESSION_STORAGE_KEY = "teletype.session_id";
  const BOOTED_STORAGE_KEY = "teletype.booted";
  const BROWSER_LID_KEY = "teletype.lid";
  const BROWSER_CASE_KEY = "teletype.case-mode";
  const BROWSER_TERMINAL_MODE_KEY = "teletype.mode";
  const BACKOFF_INITIAL_MS = 1000;
  const BACKOFF_MAX_MS = 30000;

  const runtimeState = {
    engine: null,
    paper: null,
    queue: null,
    keyQueue: null,
    socket: null,
    sessionId: null,
    booted: false,
    lid: "up",
    caseMode: "33",
  };

  function randInt(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  // Mask incoming bytes to 7-bit ASCII. In Model 33 mode, additionally fold
  // 0x60-0x7F down to 0x40-0x5F, mirroring how a real ASR-33's printer decoded
  // codes outside its uppercase glyph range. Unicode therefore mangles into
  // low ASCII rather than producing JS toUpperCase artifacts.
  function caseFold(ch, allowLowercase) {
    let c = ch.charCodeAt(0) & 0x7F;
    if (!allowLowercase && c >= 0x60) {
      c &= 0x5F;
    }
    return String.fromCharCode(c);
  }

  function nextSessionId() {
    const rnd = (window.crypto && window.crypto.getRandomValues)
      ? window.crypto.getRandomValues(new Uint32Array(4))
      : new Uint32Array([Date.now(), Math.random() * 0xffffffff, performance.now(), 0x4d2]);
    return Array.from(rnd, (n) => n.toString(16).padStart(8, "0")).join("");
  }

  function browserStorageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (_err) {
      return null;
    }
  }

  function browserStorageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (_err) {
      // Ignore.
    }
  }

  function getSessionId() {
    const existing = browserStorageGet(SESSION_STORAGE_KEY);
    if (existing && /^[0-9a-fA-F]{32}$/.test(existing)) {
      return existing;
    }
    const sid = nextSessionId();
    browserStorageSet(SESSION_STORAGE_KEY, sid);
    return sid;
  }

  function getBooleanStorage(key, fallback) {
    const value = browserStorageGet(key);
    if (value === "true") {
      return true;
    }
    if (value === "false") {
      return false;
    }
    return fallback;
  }

  function getLidStorage() {
    const raw = browserStorageGet(BROWSER_LID_KEY);
    return raw === "down" ? "down" : "up";
  }

  function setLidStorage(value) {
    browserStorageSet(BROWSER_LID_KEY, value === "down" ? "down" : "up");
  }

  function getCaseStorage() {
    const raw = browserStorageGet(BROWSER_CASE_KEY);
    return raw === "37" ? "37" : "33";
  }

  function setCaseStorage(value) {
    browserStorageSet(BROWSER_CASE_KEY, value === "37" ? "37" : "33");
  }

  function getTerminalModeStorage() {
    return browserStorageGet(BROWSER_TERMINAL_MODE_KEY) === "local" ? "local" : "line";
  }

  function setTerminalModeStorage(value) {
    browserStorageSet(BROWSER_TERMINAL_MODE_KEY, value === "local" ? "local" : "line");
  }

  function teletypeWsUrl(sessionId, host) {
    const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
    const resolvedHost = host || window.location.host;
    return `${scheme}//${resolvedHost}/api/plugins/teletype/tty?session=${encodeURIComponent(sessionId)}`;
  }

  function buildHostCandidates() {
    const result = [];
    const seen = new Set();
    const port = window.location.port ? `:${window.location.port}` : "";
    const add = (value) => {
      if (!value || seen.has(value)) {
        return;
      }
      seen.add(value);
      result.push(value);
    };

    add(window.location.host);
    add(`127.0.0.1${port}`);
    add(`localhost${port}`);
    const host = window.location.hostname;
    if (host) {
      add(host.includes(":") ? `[${host}]${port}` : `${host}${port}`);
    }
    return [...new Set(result)];
  }

  class KeyQueue {
    constructor(send, onTick) {
      this.send = send;
      this.onTick = onTick;
      this.buf = [];
      this.timer = null;
      this.nextTickAt = 0;
      this.hold = false;
    }

    setSend(send) {
      if (typeof send === "function") {
        this.send = send;
      }
    }

    setOnTick(onTick) {
      this.onTick = typeof onTick === "function" ? onTick : null;
    }

    enqueue(ch) {
      this.buf.push(ch);
      this.start();
    }

    setHold(hold) {
      this.hold = !!hold;
      if (this.hold) {
        this.pause();
      } else {
        this.resume();
      }
    }

    start() {
      if (this.hold) {
        return;
      }
      if (this.timer !== null) {
        return;
      }
      if (this.buf.length === 0) {
        return;
      }
      // Fire the first tick synchronously so the keystroke is heard and
      // sent without the 100 ms throttle latency. Sustained typing still
      // throttles to 10 cps because each tick reschedules via
      // _scheduleNext (setTimeout TICK_MS).
      this.nextTickAt = performance.now();
      this.tick();
    }

    tick() {
      const ch = this.buf.shift();
      if (ch === undefined) {
        this.stop();
        this.timer = null;
        return;
      }
      this.send(ch);
      if (this.onTick) {
        this.onTick();
      }
      this._scheduleNext();
    }

    _scheduleNext() {
      this.nextTickAt += TICK_MS;
      const delay = Math.max(0, this.nextTickAt - performance.now());
      this.timer = window.setTimeout(() => this.tick(), delay);
    }

    stop() {
      if (this.timer !== null) {
        window.clearTimeout(this.timer);
        this.timer = null;
      }
    }

    pause() {
      this.stop();
    }

    clear() {
      this.stop();
      this.buf = [];
    }

    resume() {
      this.start();
    }
  }

  class PrintQueue {
    constructor(renderer, audio, onPrintingChange) {
      this.renderer = renderer;
      this.audio = audio;
      this.onPrintingChange = onPrintingChange;
      this.buf = [];
      this.timer = null;
      this.printing = false;
      this.nextTickAt = 0;
      this.holdInputCount = 0;
    }

    setOnPrintingChange(onPrintingChange) {
      this.onPrintingChange = typeof onPrintingChange === "function" ? onPrintingChange : null;
      this._notifyPrintingChange();
    }

    enqueue(ch, options = {}) {
      const holdInput = !!options.holdInput;
      this.buf.push({ ch, holdInput });
      if (holdInput) {
        this.holdInputCount += 1;
      }
      this._notifyPrintingChange(true);
      // Audio look-ahead used to fire here, which made the chars/spaces
      // loop start at enqueue time — i.e. at the keystroke in line mode,
      // 100 ms before the actual print. Look-ahead now happens in tick()
      // right before render so audio and paper land together. Sustained
      // print bursts still get anticipation via the post-render
      // lookAhead(buf[0]) inside tick().
      this.start();
    }

    start() {
      if (this.timer !== null) {
        return;
      }
      this.printing = true;
      // Extra slack on the first tick after idle so the keystroke ->
      // server -> echo -> paper round-trip feels like a Model 33 print
      // head winding up, not an instant remote echo.
      this.nextTickAt = performance.now() + 20;
      this._scheduleNext();
    }

    tick() {
      const item = this.buf.shift();
      if (item === undefined) {
        this.stop();
        this.timer = null;
        return;
      }
      let ch = item.ch;
      // ASR-33 renders backspace as "^H" (no physical mechanism). Spread it
      // across two ticks so it takes 200ms at 10cps, like any other pair of
      // printable characters.
      if (ch === "\b" && this.renderer && this.renderer.caseMode === "33") {
        this.buf.unshift({ ch: "H", holdInput: false });
        ch = "^";
      }
      if (item.holdInput) {
        this.holdInputCount = Math.max(0, this.holdInputCount - 1);
      }
      // Engage the right audio loop at print time, not at enqueue time.
      // For the first char in a burst this aligns the chars/spaces loop
      // start with the visible print; for subsequent chars the previous
      // tick's post-render lookAhead has already anticipated this and
      // the call here is idempotent.
      this.audio.lookAhead(ch);
      const output = this.renderer.outputChar(ch);
      const event = output && typeof output === "object" && "event" in output
        ? output.event
        : output;
      const nextDelay = output && typeof output === "object" && typeof output.delayMs === "number"
        ? Math.max(0, output.delayMs)
        : 0;
      this.audio.onPrintChar(ch, event);
      if (this.buf.length > 0) {
        this.audio.lookAhead(this.buf[0].ch);
      }
      this._notifyPrintingChange(true);
      this._scheduleNext(nextDelay);
    }

    _scheduleNext(extraDelayMs = 0) {
      this.nextTickAt += TICK_MS + extraDelayMs;
      const delay = Math.max(0, this.nextTickAt - performance.now());
      this.timer = window.setTimeout(() => this.tick(), delay);
    }

    stop() {
      if (this.timer !== null) {
        window.clearTimeout(this.timer);
        this.timer = null;
      }
      if (this.printing) {
        this.printing = false;
        this._notifyPrintingChange(false);
        this.audio.fadeToHum();
      }
    }

    clear() {
      this.stop();
      this.buf = [];
      this.holdInputCount = 0;
      this._notifyPrintingChange(false);
      this.audio.fadeToHum();
    }

    _notifyPrintingChange(printing = this.printing) {
      if (this.onPrintingChange) {
        this.onPrintingChange(printing, this.holdInputCount > 0);
      }
    }

    pause() {
      this.stop();
    }

    resume() {
      if (!this.printing && this.buf.length > 0) {
        this.start();
      }
    }
  }

  class AbstractLine {
    constructor() {
      this.cells = [];
    }

    placeChar(column, char) {
      if (char === " ") {
        return;
      }
      const existing = this.cells[column] || [];
      existing.push(char);
      this.cells[column] = existing;
    }
  }

class PaperRoll {
    constructor(canvas, scrollContainer) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.scrollContainer = scrollContainer || null;
      this.drawOffsetY = 0;
      this.rows = [new AbstractLine()];
      this.col = 0;
      this.rowIdx = 0;
      this.lineBellArmed = true;
      this.charWidth = 14;
      this.lineHeight = 20;
      this.fontFamily = "Teletype33, monospace";
      this.fontSize = 18;
      this.bg = "#F5E7D2";
      this.fg = "#000";
      this.paddingX = 8;
      this.paddingY = 10;
      this.caseMode = "33";
      this._dirty = true;
      this._raf = true;
      this._draw();
      this._startRenderLoop();
    }

    setCaseMode(mode) {
      this.caseMode = mode === "37" ? "37" : "33";
    }

    _placePrintable(rendered) {
      const row = this.rows[this.rowIdx];
      row.placeChar(this.col, rendered);
      const next = Math.min(COLUMNS - 1, this.col + 1);
      const event = this.maybeBellForward(this.col, next);
      this.col = next;
      this._dirty = true;
      return event;
    }

    setCanvas(canvas) {
      if (!canvas) {
        return;
      }
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this._dirty = true;
      if (!this._raf) {
        this._raf = true;
        this._startRenderLoop();
      }
    }

    setScrollContainer(scrollContainer) {
      const next = scrollContainer || null;
      if (this.scrollContainer !== next) {
        if (this._resizeObserver) {
          this._resizeObserver.disconnect();
          this._resizeObserver = null;
        }
        this.scrollContainer = next;
      }
      if (next && !this._resizeObserver && typeof window !== "undefined" && typeof window.ResizeObserver === "function") {
        this._resizeObserver = new window.ResizeObserver(() => {
          this._resize();
        });
        this._resizeObserver.observe(next);
      }
      this._dirty = true;
      this._resize();
    }

    ensureRow(idx) {
      while (this.rows.length <= idx) {
        this.rows.push(new AbstractLine());
      }
    }

    _carriageReturnDelay(column) {
      const travel = Math.max(0, Math.min(COLUMNS - 1, column));
      return Math.min(
        CR_RETURN_MAX_DELAY_MS,
        CR_RETURN_MIN_DELAY_MS + Math.floor(travel * CR_RETURN_PER_COLUMN_MS),
      );
    }

    maybeBellForward(fromCol, toCol) {
      const threshold = MARGIN_BELL_COLUMN - 1; // zero-based threshold for from/to columns
      if (!this.lineBellArmed) {
        return null;
      }
      if (fromCol < threshold && toCol >= threshold) {
        this.lineBellArmed = false;
        return "marginBell";
      }
      return null;
    }

    outputChar(ch) {
      this.ensureRow(this.rowIdx);
      let event = null;
      if (ch === "\n") {
        this.rowIdx += 1;
        this.ensureRow(this.rowIdx);
        this.lineBellArmed = true;
        this.col = Math.min(this.col, COLUMNS - 1);
        this._dirty = true;
        this._resize();
        return null;
      }
      if (ch === "\r") {
        const fromColumn = this.col;
        this.col = 0;
        this.lineBellArmed = true;
        this._dirty = true;
        return {
          event: null,
          delayMs: this._carriageReturnDelay(fromColumn),
        };
      }
      if (ch === "\t") {
        const next = ((this.col + 7) >>> 3) * 8;
        const target = Math.min(COLUMNS - 1, next);
        event = this.maybeBellForward(this.col, target);
        this.col = target;
        this._dirty = true;
        return event;
      }
      if (ch === "\b") {
        if (this.caseMode === "37") {
          this.col = Math.max(0, this.col - 1);
          this._dirty = true;
          return null;
        }
        // ASR-33 has no physical backspace mechanism. Render "^H" the way
        // a Unix host typically echoes Ctrl+H to a 33.
        const e1 = this._placePrintable("^");
        const e2 = this._placePrintable("H");
        return e1 || e2;
      }
      if (ch === "\f") {
        this.rows = [new AbstractLine()];
        this.col = 0;
        this.rowIdx = 0;
        this.lineBellArmed = true;
        this._dirty = true;
        this._resize();
        return "platen";
      }
      if (ch === "\x07") {
        return null;
      }
      if (ch >= " ") {
        return this._placePrintable(caseFold(ch, this.caseMode === "37"));
      }
      return null;
    }

    _resize() {
      const width = this.paddingX * 2 + this.charWidth * COLUMNS;
      const contentHeight = this.paddingY * 2 + this.rows.length * this.lineHeight;
      // Canvas pixel buffer is sized to the content, no padding for empty
      // viewport space. Bottom-anchoring is handled by the wrap's flex
      // layout (margin-top: auto on the canvas). drawOffsetY stays 0; the
      // last line sits at the canvas-pixel bottom by construction.
      this.drawOffsetY = 0;
      if (this.canvas.width !== width) {
        this.canvas.width = width;
      }
      if (this.canvas.height !== contentHeight) {
        this.canvas.height = contentHeight;
      }
      this._dirty = true;
    }

    loadTranscript(text) {
      if (typeof text !== "string" || text.length === 0) {
        this.rows = [new AbstractLine()];
        this.col = 0;
        this.rowIdx = 0;
        this.lineBellArmed = true;
        this._dirty = true;
        this._resize();
        return;
      }
      this.rows = [new AbstractLine()];
      this.col = 0;
      this.rowIdx = 0;
      this.lineBellArmed = true;
      for (const ch of text) {
        this.outputChar(ch);
      }
      this._dirty = true;
    }

    _startRenderLoop() {
      const render = (ts) => {
        if (!this._raf) {
          return;
        }
      if (this._dirty) {
        this._draw();
        this._dirty = false;
      }
      window.requestAnimationFrame(render);
      };
      window.requestAnimationFrame(render);
    }

    stop() {
      this._raf = false;
    }

    _draw() {
      const ctx = this.ctx;
      this._resize();
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.save();
      ctx.fillStyle = this.bg;
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.font = `${this.fontSize}px ${this.fontFamily}`;
      ctx.textBaseline = "top";
      for (let row = 0; row < this.rows.length; row++) {
        const extentRow = this.rows[row];
        const y = this.drawOffsetY + this.paddingY + row * this.lineHeight;
        const cells = extentRow.cells;
        const limit = cells.length;
        for (let column = 0; column < limit; column++) {
          const stack = cells[column];
          if (!stack || stack.length === 0) {
            continue;
          }
          const x = this.paddingX + column * this.charWidth;
          ctx.fillStyle = this.fg;
          for (let idx = 0; idx < stack.length; idx++) {
            const glyph = stack[idx];
            ctx.fillText(glyph, x, y + 1);
          }
        }
      }
      this._drawCursor(ctx);
      if (this.scrollContainer) {
        if (this.scrollContainer.scrollHeight > this.scrollContainer.clientHeight) {
          this.scrollContainer.scrollTop = this.scrollContainer.scrollHeight;
        } else {
          this.scrollContainer.scrollTop = 0;
        }
      }
      ctx.restore();
    }

    _drawCursor(ctx) {
      const x = this.paddingX + this.col * this.charWidth;
      const y = this.drawOffsetY + this.paddingY + this.rowIdx * this.lineHeight + this.lineHeight - 3;
      ctx.save();
      ctx.fillStyle = this.fg;
      ctx.globalAlpha = 0.75;
      ctx.fillRect(x + 1, y, Math.max(6, this.charWidth - 3), 2);
      ctx.restore();
    }

    hasPromptAtLineStart() {
      if (this.col !== 0) {
        return false;
      }
      const line = this.rows[this.rowIdx];
      if (!line) {
        return false;
      }
      const first = line.cells[0];
      const second = line.cells[1];
      return Array.isArray(first) && first.includes(">") && Array.isArray(second) && second.includes(" ");
    }
  }

  class AudioEngine {
    constructor() {
      this.ctx = null;
      this.buffers = {};
      this.lid = "up";
      this.started = false;
      this.loading = false;
      this.loadError = false;
      this.humGain = null;
      this.spacesGain = null;
      this.charsGain = null;
      this.humSrc = null;
      this.spacesSrc = null;
      this.charsSrc = null;
      this.loopStopHandle = null;
      this.master = null;
      // Bell ring-out hold: when a typed BEL plays, defer fadeToHum until
      // the bell sample has finished decaying so the hum loop doesn't mask
      // the tail. Cleared by any subsequent print event.
      this.bellHoldUntil = 0;
      this.bellHoldTimer = null;
    }

    async start() {
      if (this.started || this.loading) {
        return this.started;
      }
      this.loading = true;
      try {
        const Context = window.AudioContext || window.webkitAudioContext;
        if (!Context) {
          return false;
        }
        this.ctx = new Context({ sampleRate: 48000 });
        this.master = this.ctx.createGain();
        this.master.connect(this.ctx.destination);
        this.humGain = this.ctx.createGain();
        this.humGain.gain.value = 0;
        this.humGain.connect(this.master);
        this.spacesGain = this.ctx.createGain();
        this.spacesGain.gain.value = 0;
        this.spacesGain.connect(this.master);
        this.charsGain = this.ctx.createGain();
        this.charsGain.gain.value = 0;
        this.charsGain.connect(this.master);
        await this._loadBuffers();
        await this.ctx.resume();
        this._startLoops();
        this._playEffect(this._name("motor-on"));
        window.setTimeout(() => {
          this.syncLoops(0);
          this.fadeToHum();
        }, 1500);
        this.started = true;
        return true;
      } catch (_err) {
        this.loadError = true;
        return false;
      } finally {
        this.loading = false;
      }
    }

    async _loadBuffers() {
      const names = [
        "hum",
        "bell",
        "cr-01",
        "cr-02",
        "cr-03",
        "motor-on",
        "motor-off",
        "print-chars-01",
        "print-chars-02",
        "print-spaces-01",
        "print-spaces-02",
        "key-01",
        "key-02",
        "key-03",
        "key-04",
        "key-05",
        "key-06",
        "key-07",
        "platen",
        "lid",
      ];

      const promises = [];
      for (const lid of ["up", "down"]) {
        for (const name of names) {
          const full = `${lid}-${name}`;
          promises.push(this._loadBuffer(full).catch((err) => {
            console.warn(`failed to load sound '${full}'`, err);
            return null;
          }));
        }
      }
      await Promise.all(promises);
    }

    async _loadBuffer(name) {
      const path = `/dashboard-plugins/teletype/dist/sounds/${name}.wav`;
      const resp = await window.fetch(path);
      if (!resp.ok) {
        return null;
      }
      const array = await resp.arrayBuffer();
      this.buffers[name] = await this.ctx.decodeAudioData(array);
    }

    _name(fileName) {
      return `${this.lid}-${fileName}`;
    }

    _startLoop(bufferName, destNode) {
      const buf = this.buffers[bufferName];
      if (!buf || !this.ctx) {
        return null;
      }
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(destNode);
      src.start();
      return src;
    }

    _startLoops() {
      if (!this.ctx) {
        return;
      }
      this.humSrc = this._startLoop(this._name("hum"), this.humGain);
      this.spacesSrc = this._startLoop(this._name(`print-spaces-0${randInt(1, 2)}`), this.spacesGain);
      this.charsSrc = this._startLoop(this._name(`print-chars-0${randInt(1, 2)}`), this.charsGain);
      // Don't reset the gains here. At initial construction they're already
      // 0 from createGain; on subsequent syncLoops calls (CR thunk, lid
      // swap) the gains hold the desired state and zeroing them would
      // silence whatever should be playing — including the idle hum.
    }

    _stopLoop(source) {
      if (!source) {
        return;
      }
      try {
        source.stop();
      } catch (_err) {
        // Ignore.
      }
    }

    syncLoops(waitMs) {
      if (!this.ctx) {
        return;
      }
      if (this.loopStopHandle) {
        window.clearTimeout(this.loopStopHandle);
        this.loopStopHandle = null;
      }
      this.loopStopHandle = window.setTimeout(() => {
        this._stopLoop(this.humSrc);
        this._stopLoop(this.spacesSrc);
        this._stopLoop(this.charsSrc);
        this._startLoops();
      }, waitMs);
    }

    fade(node, target) {
      if (!this.ctx || !node) {
        return;
      }
      const now = this.ctx.currentTime;
      node.gain.cancelScheduledValues(now);
      node.gain.setValueAtTime(node.gain.value, now);
      node.gain.linearRampToValueAtTime(target, now + 0.009);
    }

    fadeToHum() {
      if (!this.ctx) {
        return;
      }
      const remaining = this.bellHoldUntil - this.ctx.currentTime;
      if (remaining > 0) {
        if (!this.bellHoldTimer) {
          this.bellHoldTimer = window.setTimeout(() => {
            this.bellHoldTimer = null;
            this.bellHoldUntil = 0;
            this._doFadeToHum();
          }, remaining * 1000);
        }
        return;
      }
      this._doFadeToHum();
    }

    _doFadeToHum() {
      this.fade(this.humGain, 1);
      this.fade(this.spacesGain, 0);
      this.fade(this.charsGain, 0);
    }

    _clearBellHold() {
      this.bellHoldUntil = 0;
      if (this.bellHoldTimer) {
        window.clearTimeout(this.bellHoldTimer);
        this.bellHoldTimer = null;
      }
    }

    fadeToSpaces() {
      this.fade(this.humGain, 0);
      this.fade(this.spacesGain, 1);
      this.fade(this.charsGain, 0);
    }

    fadeToChars() {
      this.fade(this.humGain, 0);
      this.fade(this.spacesGain, 0);
      this.fade(this.charsGain, 1);
    }

    lookAhead(nextCh) {
      if (!this.started || !this.ctx) {
        return;
      }
      if (nextCh === "\x07") {
        this._clearBellHold();
        this.fade(this.humGain, 0);
        this.fade(this.spacesGain, 0);
        this.fade(this.charsGain, 0);
        this._playEffect(this._name("bell"));
        const buf = this.buffers[this._name("bell")];
        this.bellHoldUntil = this.ctx.currentTime + (buf ? buf.duration : 0);
        return;
      }
      // Any non-bell upcoming char ends the bell hold; the user has accepted
      // that print events may mute a still-ringing bell.
      this._clearBellHold();
      if (nextCh === "\r") {
        this.fadeToSpaces();
        this._playEffect(this._name(`cr-0${randInt(1, 3)}`));
        this.syncLoops(10);
        return;
      }
      if (nextCh === " " || nextCh < " ") {
        this.fadeToSpaces();
        return;
      }
      this.fadeToChars();
    }

    onPrintChar(_ch, event) {
      if (!this.started || !this.ctx) {
        return;
      }
      if (event === "platen") {
        this._playEffect(this._name("platen"));
      }
      if (event === "marginBell") {
        this._playEffect(this._name("bell"));
      }
    }

    onKeyTick() {
      if (!this.started || !this.ctx) {
        return;
      }
      this._playEffect(this._name(`key-0${randInt(1, 7)}`));
    }

    setLid(lid) {
      if (lid !== "up" && lid !== "down") {
        return;
      }
      if (this.lid === lid) {
        return;
      }
      this._playEffect(this._name("lid"));
      this.lid = lid;
      if (this.started && this.ctx) {
        this.syncLoops(250);
      }
    }

    _playEffect(name) {
      if (!this.ctx || !this.master || !this.buffers[name]) {
        return;
      }
      const source = this.ctx.createBufferSource();
      const gain = this.ctx.createGain();
      gain.gain.value = 1;
      source.buffer = this.buffers[name];
      source.connect(gain);
      gain.connect(this.master);
      source.onended = () => {
        try {
          source.disconnect();
          gain.disconnect();
        } catch (_err) {
          // no-op
        }
      };
      source.start();
      window.setTimeout(() => {
        try {
          source.stop();
        } catch (_err) {
          // no-op
        }
      }, source.buffer.duration * 1000 + 100);
    }

    pause() {
      if (!this.ctx || !this.started) {
        return;
      }
      try {
        this.ctx.suspend();
      } catch (_err) {
        // no-op
      }
    }

    async resume() {
      if (!this.ctx || !this.started) {
        return;
      }
      try {
        await this.ctx.resume();
        this.fadeToHum();
        this.syncLoops(0);
      } catch (_err) {
        // no-op
      }
    }

    async stop() {
      if (!this.ctx || !this.started) {
        return;
      }
      this.fade(this.humGain, 0);
      this.fade(this.spacesGain, 0);
      this.fade(this.charsGain, 0);
      if (this.buffers[`${this.lid}-motor-off`]) {
        this._playEffect(this._name("motor-off"));
      }
      window.setTimeout(() => {
        try {
          this.ctx.suspend();
        } catch (_err) {
          // no-op
        }
      }, 500);
      if (this.loopStopHandle) {
        window.clearTimeout(this.loopStopHandle);
        this.loopStopHandle = null;
      }
      this._stopLoop(this.humSrc);
      this._stopLoop(this.spacesSrc);
      this._stopLoop(this.charsSrc);
      this.started = false;
    }
  }

  class TeletypeSocket {
    constructor({ sessionId, onOut, onStatus, onError }) {
      this.sessionId = sessionId;
      this.onOut = onOut;
      this.onStatus = onStatus;
      this.onError = onError;
      this.hostCandidates = buildHostCandidates();
      this.hostIndex = 0;
      this.ws = null;
      this.pending = [];
      this.backoff = BACKOFF_INITIAL_MS;
      this.closed = false;
      this.connected = false;
      this.connecting = false;
      this.endpoint = teletypeWsUrl(this.sessionId, this.hostCandidates[this.hostIndex]);
      this.connect();
    }

    setHandlers({ onOut, onStatus, onError }) {
      if (typeof onOut === "function") {
        this.onOut = onOut;
      }
      if (typeof onStatus === "function") {
        this.onStatus = onStatus;
      }
      if (typeof onError === "function") {
        this.onError = onError;
      }
    }

    connect() {
      if (this.closed) {
        return;
      }
      if (this.connecting) {
        return;
      }
      if (this.hostIndex >= this.hostCandidates.length) {
        this.hostIndex = 0;
      }
      const host = this.hostCandidates[this.hostIndex];
      this.endpoint = teletypeWsUrl(this.sessionId, host);
      this.connecting = true;
      let ws;
      try {
        ws = new window.WebSocket(this.endpoint);
        this.ws = ws;
      } catch (_err) {
        this.connecting = false;
        this._handleTransientFailure(`WebSocket failed to create socket for ${this.endpoint}`);
        return;
      }

      ws.addEventListener("open", () => {
        this.backoff = BACKOFF_INITIAL_MS;
        this.connected = true;
        this.connecting = false;
        this.onStatus("connected");
        this.flush();
      });

      ws.addEventListener("message", (event) => {
        let msg = null;
        try {
          msg = JSON.parse(event.data);
        } catch (_err) {
          return;
        }
        if (!msg || typeof msg !== "object") {
          return;
        }
        if (msg.t === "out" && typeof msg.c === "string" && msg.c.length === 1) {
          this.onOut(msg.c);
          return;
        }
        if (msg.t === "status" && typeof msg.state === "string") {
          this.onStatus(msg.state);
          return;
        }
        if (msg.t === "gateway_status" && typeof msg.state === "string") {
          this.onStatus(`gateway_${msg.state}`);
          return;
        }
        if (msg.t === "error" && typeof msg.msg === "string") {
          this.onError(msg.msg);
        }
      });

      ws.addEventListener("close", (event) => {
        this.connected = false;
        this.connecting = false;
        this.onStatus("disconnected");
        if (typeof event === "object" && event.code && event.code !== 1000) {
          const reason = `${event.reason || "connection closed"} (${this.endpoint})`;
          this.onError(`WebSocket closed (${event.code || "n/a"}): ${reason}`);
        }
        if (this.closed) {
          return;
        }
        this.scheduleReconnect();
      });
      ws.addEventListener("error", () => {
        this.connected = false;
        this.connecting = false;
        this.onStatus("disconnected");
        this.onError(`WebSocket error: failed to connect to ${this.endpoint}`);
        if (this.closed) {
          return;
        }
        this.scheduleReconnect();
      });
    }

    _handleTransientFailure(msg) {
      this.onError(msg);
      this.scheduleReconnect();
    }

    scheduleReconnect() {
      if (this.closed) {
        return;
      }
      if (this.hostCandidates.length > 1) {
        this.hostIndex = (this.hostIndex + 1) % this.hostCandidates.length;
      }
      const delay = this.backoff;
      this.backoff = Math.min(BACKOFF_MAX_MS, this.backoff * 2);
      window.setTimeout(() => {
        if (this.closed) {
          return;
        }
        this.connect();
      }, delay);
    }

    flush() {
      while (this.pending.length > 0) {
        const ch = this.pending.shift();
        this._sendNow(ch);
      }
    }

    send(ch) {
      if (this.connected && this.ws && this.ws.readyState === window.WebSocket.OPEN) {
        this._sendNow(ch);
      } else {
        this.pending.push(ch);
      }
    }

    requestPrompt() {
      this._sendMessage({ t: "prompt" });
    }

    interrupt() {
      this._sendMessage({ t: "interrupt" });
    }

    _sendNow(ch) {
      if (!this.connected || !this.ws || this.ws.readyState !== window.WebSocket.OPEN) {
        this.pending.push(ch);
        return;
      }
      try {
        this.ws.send(JSON.stringify({ t: "key", c: ch }));
      } catch (_err) {
        this.pending.push(ch);
      }
    }

    _sendMessage(message) {
      if (!this.connected || !this.ws || this.ws.readyState !== window.WebSocket.OPEN) {
        return;
      }
      try {
        this.ws.send(JSON.stringify(message));
      } catch (_err) {
        // The socket reconnect path will recover the session state.
      }
    }

    close() {
      this.closed = true;
      if (this.ws) {
        try {
          this.ws.close();
        } catch (_err) {
          // no-op
        }
      }
    }
  }

  function mapKeyToChar(event) {
    if (event.key === "F7") {
      return { special: "lid" };
    }
    if (event.ctrlKey && event.key.toLowerCase() === "g") {
      return { ch: "\x07" };
    }
    if (event.ctrlKey && event.key.toLowerCase() === "l") {
      return { ch: "\f" };
    }
    if (event.ctrlKey && event.key.toLowerCase() === "j") {
      return { ch: "\n" };
    }
    if (event.ctrlKey && event.key.toLowerCase() === "h") {
      return { ch: "\b" };
    }
    if (event.key === "Enter") {
      return { ch: "\r" };
    }
    if (event.key === "Backspace") {
      return { ch: "\b" };
    }
    if (event.key === "Tab") {
      return { ch: "\t" };
    }
    if (event.key.length !== 1) {
      return {};
    }
    const ch = event.key;
    if (ch >= " " && ch <= "~") {
      return { ch };
    }
    return {};
  }

  function TeletypePage() {
    const containerRef = useRef(null);
    const canvasRef = useRef(null);
    const panelRef = useRef(null);
    const [sessionId, setSessionId] = useState(() => getSessionId());
    const transcriptLoadedRef = useRef(false);
    const pendingOutRef = useRef([]);
    const localFadeTimerRef = useRef(null);
    const engineRef = useRef(null);
    const queueRef = useRef(null);
    const socketRef = useRef(null);
    const keyQueueRef = useRef(null);
    const paperRef = useRef(null);
    const isConnectedRef = useRef(false);
    const expectedEchoRef = useRef(0);
    const [booted, setBooted] = useState(() => !!runtimeState.booted);
    const [backendThinking, setBackendThinking] = useState(false);
    const [connectionState, setConnectionState] = useState(() => {
      return runtimeState.socket && runtimeState.socket.connected ? "connected" : "disconnected";
    });
    const [gatewayState, setGatewayState] = useState("checking");
    const [printing, setPrinting] = useState(() => {
      return runtimeState.queue ? runtimeState.queue.printing : false;
    });
    const [error, setError] = useState("");
    const audioStartInProgressRef = useRef(false);
    const preferredBootRef = useRef(getBooleanStorage(BOOTED_STORAGE_KEY, false));
    const [lid, setLid] = useState(() => {
      const persistedLid = getLidStorage();
      runtimeState.lid = persistedLid;
      return persistedLid;
    });
    const [caseMode, setCaseMode] = useState(() => {
      const persisted = getCaseStorage();
      runtimeState.caseMode = persisted;
      return persisted;
    });
    const [terminalMode, setTerminalMode] = useState(() => getTerminalModeStorage());
    const terminalModeRef = useRef(terminalMode);
    useEffect(() => {
      terminalModeRef.current = terminalMode;
    }, [terminalMode]);

    const gatewayLabel = gatewayState === "connected"
      ? "connected"
      : gatewayState === "missing_key"
        ? "missing key"
        : gatewayState === "checking"
          ? "checking"
          : "disconnected";
    const statusLabel = backendThinking ? "thinking" : printing ? "printing" : gatewayLabel;
    const noop = useCallback(() => {}, []);

    const ensureAudioStarted = useCallback(() => {
      const audio = engineRef.current;
      if (!audio || audioStartInProgressRef.current) {
        return;
      }
      if (audio.started) {
        if (!booted) {
          runtimeState.booted = true;
          setBooted(true);
        }
        return;
      }
      audioStartInProgressRef.current = true;
      audio.start().then((started) => {
        if (started) {
          if (!runtimeState.booted) {
            runtimeState.booted = true;
            setBooted(true);
          }
          browserStorageSet(BOOTED_STORAGE_KEY, "true");
          preferredBootRef.current = true;
        }
      }).catch(() => {
        // no-op
      }).finally(() => {
        audioStartInProgressRef.current = false;
      });
    }, [booted]);

    const bootAudio = useCallback(() => {
      ensureAudioStarted();
    }, [ensureAudioStarted]);

    const setLidPosition = useCallback((nextLid) => {
      if (nextLid !== "up" && nextLid !== "down") {
        return;
      }
      setLid(nextLid);
      runtimeState.lid = nextLid;
      setLidStorage(nextLid);
      if (runtimeState.engine) {
        runtimeState.engine.setLid(nextLid);
      }
    }, []);

    const toggleLid = useCallback(() => {
      const nextLid = lid === "up" ? "down" : "up";
      setLidPosition(nextLid);
    }, [lid, setLidPosition]);

    const setCaseModeValue = useCallback((nextMode) => {
      const normalized = nextMode === "37" ? "37" : "33";
      setCaseMode(normalized);
      runtimeState.caseMode = normalized;
      setCaseStorage(normalized);
      if (paperRef.current) {
        paperRef.current.setCaseMode(normalized);
      }
    }, []);

    const setTerminalModeValue = useCallback((nextMode) => {
      const normalized = nextMode === "local" ? "local" : "line";
      setTerminalMode(normalized);
      setTerminalModeStorage(normalized);
    }, []);

    const ensurePromptAtLineStart = useCallback(() => {
      // Local mode is keyboard-and-printer only; the server prompt is
      // suppressed since there's nothing to talk to.
      if (terminalModeRef.current === "local") {
        return;
      }
      const paper = paperRef.current;
      const queue = queueRef.current;
      const socket = socketRef.current;
      if (!paper || !queue || !socket || !isConnectedRef.current) {
        return;
      }
      if (!paper.hasPromptAtLineStart()) {
        socket.requestPrompt();
      }
    }, []);

    const onStatus = useCallback((state) => {
      isConnectedRef.current = state === "ready" || state === "connected";
      if (state.startsWith("gateway_")) {
        const nextGatewayState = state.slice("gateway_".length) || "disconnected";
        setGatewayState(nextGatewayState);
        if (nextGatewayState === "connected") {
          setError("");
        }
        return;
      }
      if (state === "ready") {
        setError("");
        setBackendThinking(false);
        window.requestAnimationFrame(() => {
          ensurePromptAtLineStart();
        });
        return;
      }
      if (state === "connected" || state === "disconnected") {
        setConnectionState(state);
        if (state === "connected") {
          setError("");
        }
        return;
      }
      setBackendThinking(state === "thinking");
    }, [ensurePromptAtLineStart]);

    const onPrintingChange = useCallback((printing, holdInput) => {
      setPrinting(printing);
      const keyQueue = keyQueueRef.current;
      if (keyQueue) {
        keyQueue.setHold(holdInput);
      }
      if (printing) {
        return;
      }
      window.requestAnimationFrame(() => {
        const queue = queueRef.current;
        if (!queue || queue.printing || queue.buf.length > 0) {
          return;
        }
        ensurePromptAtLineStart();
      });
    }, [ensurePromptAtLineStart]);

    const interruptPrintout = useCallback(() => {
      setError("");
      setBackendThinking(false);
      if (keyQueueRef.current) {
        keyQueueRef.current.clear();
      }
      pendingOutRef.current = [];
      if (queueRef.current) {
        queueRef.current.clear();
      }
      if (socketRef.current) {
        socketRef.current.interrupt();
      }
    }, []);

    const onOut = useCallback((ch) => {
      // In local mode the line is conceptually disconnected; drop server
      // output so nothing prints from the remote side.
      if (terminalModeRef.current === "local") {
        return;
      }
      if (!booted || preferredBootRef.current) {
        ensureAudioStarted();
      }
      if (!transcriptLoadedRef.current) {
        pendingOutRef.current.push(ch);
        return;
      }
      if (!queueRef.current) {
        return;
      }
      const isEcho = expectedEchoRef.current > 0;
      if (isEcho) {
        expectedEchoRef.current -= 1;
      }
      queueRef.current.enqueue(ch, { holdInput: !isEcho });
      ensureAudioStarted();
    }, [booted, ensureAudioStarted]);

    const onError = useCallback((msg) => {
      setError(msg);
    }, []);

    const refreshGatewayStatus = useCallback(async () => {
      try {
        const response = await window.fetch("/api/plugins/teletype/tty/gateway-status");
        if (!response.ok) {
          throw new Error(`gateway status failed: ${response.status}`);
        }
        const payload = await response.json();
        if (payload && typeof payload.state === "string") {
          setGatewayState(payload.state);
          if (payload.state === "connected") {
            setError("");
          }
          return;
        }
      } catch (_err) {
        // The dashboard plugin API itself is unavailable or reloading.
      }
      setGatewayState("disconnected");
    }, []);

    useEffect(() => {
      refreshGatewayStatus();
      const interval = window.setInterval(refreshGatewayStatus, 5000);
      return () => window.clearInterval(interval);
    }, [refreshGatewayStatus]);

    const clearSession = useCallback(async () => {
      setError("");
      setBackendThinking(false);
      setConnectionState("disconnected");
      if (queueRef.current) {
        queueRef.current.clear();
      }
      if (paperRef.current) {
        paperRef.current.loadTranscript("");
      }
      pendingOutRef.current = [];
      transcriptLoadedRef.current = false;
      if (keyQueueRef.current) {
        keyQueueRef.current.clear();
      }
      if (socketRef.current) {
        // Neutralize the old socket's handlers before closing so its async
        // close/error events can't write back to React state and overwrite
        // the successor socket's "connected" status.
        socketRef.current.setHandlers({
          onOut: noop,
          onStatus: noop,
          onError: noop,
        });
        socketRef.current.close();
      }

      try {
        const response = await window.fetch(
          `/api/plugins/teletype/tty/clear?session=${encodeURIComponent(sessionId)}`,
          { method: "POST" },
        );
        if (response.ok) {
          const payload = await response.json();
          if (payload && payload.ok && typeof payload.session === "string") {
            const nextSessionId = payload.session;
            browserStorageSet(SESSION_STORAGE_KEY, nextSessionId);
            setSessionId(nextSessionId);
            return;
          }
        }
      } catch (_err) {
        // fallback below
      }

      const fallbackSessionId = nextSessionId();
      browserStorageSet(SESSION_STORAGE_KEY, fallbackSessionId);
      setSessionId(fallbackSessionId);
    }, [sessionId]);

    const onKeyDown = useCallback(
      (event) => {
        if (event.metaKey || event.altKey || event.key === "Shift" || event.key === "Control" || event.key === "Alt") {
          return;
        }
        if (terminalModeRef.current !== "local" && event.ctrlKey && event.key.toLowerCase() === "c") {
          event.preventDefault();
          interruptPrintout();
          return;
        }
        const mapped = mapKeyToChar(event);
        if (mapped.special === "lid") {
          event.preventDefault();
          toggleLid();
          return;
        }
        if (!mapped.ch) {
          return;
        }
        event.preventDefault();
        if (!booted) {
          bootAudio();
        }
        if (keyQueueRef.current) {
          keyQueueRef.current.enqueue(mapped.ch);
        }
      },
      [bootAudio, booted, interruptPrintout, toggleLid]
    );

    useEffect(() => {
      if (!canvasRef.current) {
        return;
      }

      const previousSessionId = runtimeState.sessionId;
      const sessionChanged = previousSessionId !== sessionId;
      runtimeState.sessionId = sessionId;
      if (sessionChanged) {
        transcriptLoadedRef.current = false;
      }
      let cancelled = false;

      const sendKey = (ch) => {
        if (terminalModeRef.current === "local") {
          // Local mode: render synchronously, bypassing the print queue's
          // 10 cps throttle. On a real Model 33 the keyboard linkage drives
          // the printer mechanism directly — there's no buffered delay,
          // and that's what we want here. CR is *just* CR (no auto-LF);
          // the operator sends LF separately with Ctrl+J.
          const paper = paperRef.current;
          const audio = engineRef.current;
          if (!paper) {
            return;
          }
          if (audio && audio.started) {
            audio.lookAhead(ch);
          }
          const result = paper.outputChar(ch);
          const event = result && typeof result === "object" && "event" in result
            ? result.event
            : result;
          if (audio && audio.started) {
            audio.onPrintChar(ch, event);
            // Without a PrintQueue.stop() to call fadeToHum, the chars /
            // spaces loop set up by lookAhead would run forever. Restore
            // idle hum after one print-tick's worth of mechanism sound,
            // debounced so sustained typing keeps the loop active until
            // the user pauses.
            if (localFadeTimerRef.current) {
              window.clearTimeout(localFadeTimerRef.current);
            }
            localFadeTimerRef.current = window.setTimeout(() => {
              localFadeTimerRef.current = null;
              if (audio.started) {
                audio.fadeToHum();
              }
            }, 120);
          }
          return;
        }
        if (socketRef.current) {
          expectedEchoRef.current += ch === "\r" ? 2 : 1;
          socketRef.current.send(ch);
        }
      };
      const audio = runtimeState.engine || new AudioEngine();
      runtimeState.engine = audio;
      engineRef.current = audio;
      audio.setLid(runtimeState.lid);

      const paper = runtimeState.paper || new PaperRoll(canvasRef.current, containerRef.current);
      if (runtimeState.paper) {
        paper.setCanvas(canvasRef.current);
      }
      paper.setScrollContainer(containerRef.current);
      paper.setCaseMode(runtimeState.caseMode);
      runtimeState.paper = paper;
      paperRef.current = paper;

      const queue = runtimeState.queue || new PrintQueue(paper, audio, onPrintingChange);
      queue.setOnPrintingChange(onPrintingChange);
      queueRef.current = queue;
      runtimeState.queue = queue;

      const hydrateFromServer = async () => {
        if (transcriptLoadedRef.current) {
          while (pendingOutRef.current.length > 0 && queueRef.current) {
            queueRef.current.enqueue(pendingOutRef.current.shift(), { holdInput: true });
          }
          if (queueRef.current && !queueRef.current.printing && queueRef.current.buf.length === 0) {
            window.requestAnimationFrame(() => {
              ensurePromptAtLineStart();
            });
          }
          return;
        }
        try {
          const endpoint = `/api/plugins/teletype/tty/transcript?session=${encodeURIComponent(sessionId)}`;
          const response = await window.fetch(endpoint);
          if (!response.ok) {
            throw new Error(`transcript fetch failed: ${response.status}`);
          }
          const payload = await response.json();
          if (!cancelled && payload && typeof payload.transcript === "string") {
            if (paperRef.current) {
              paperRef.current.loadTranscript(payload.transcript);
            }
          }
        } catch (_err) {
        } finally {
          if (cancelled) {
            return;
          }
          transcriptLoadedRef.current = true;
          if (preferredBootRef.current && !runtimeState.booted) {
            ensureAudioStarted();
          }
          while (pendingOutRef.current.length > 0 && queueRef.current) {
            const ch = pendingOutRef.current.shift();
            queueRef.current.enqueue(ch, { holdInput: true });
          }
          if (queueRef.current && !queueRef.current.printing && queueRef.current.buf.length === 0) {
            window.requestAnimationFrame(() => {
              ensurePromptAtLineStart();
            });
          }
        }
      };
      hydrateFromServer();

      if (sessionChanged && runtimeState.socket) {
        runtimeState.socket.close();
        runtimeState.socket = null;
      }
      const socket = runtimeState.socket || new TeletypeSocket({
        sessionId,
        onOut,
        onStatus,
        onError,
      });
      socket.setHandlers({
        onOut,
        onStatus,
        onError,
      });
      runtimeState.socket = socket;
      socketRef.current = socket;

      const keyQueue = runtimeState.keyQueue || new KeyQueue(sendKey, () => {
        if (audio.started) {
          audio.onKeyTick();
        }
      });
      keyQueue.setSend(sendKey);
      keyQueue.setOnTick(() => {
        if (audio.started) {
          audio.onKeyTick();
        }
      });
      keyQueueRef.current = keyQueue;
      runtimeState.keyQueue = keyQueue;
      keyQueue.setHold(queue.holdInputCount > 0);

      if (runtimeState.booted !== booted) {
        setBooted(runtimeState.booted);
      }
      if (runtimeState.lid !== lid) {
        setLid(runtimeState.lid);
      }
      setLidStorage(runtimeState.lid);

      const focus = panelRef.current;
      if (focus) {
        focus.focus();
      }

      setConnectionState(socket.connected ? "connected" : "disconnected");
      setPrinting(queue.printing);
      setLid(runtimeState.lid);

      // Keep the queue/audio running across tab-visibility changes so the
      // teletype keeps printing and humming in a background tab. setTimeout
      // throttling will slow the print queue, but Web Audio loops continue
      // at the audio sample rate regardless.
      queue.resume();
      keyQueue.resume();
      audio.resume();
      if (preferredBootRef.current) {
        ensureAudioStarted();
      }

      if (preferredBootRef.current && !runtimeState.booted) {
        ensureAudioStarted();
      }

    return () => {
        cancelled = true;
        socket.setHandlers({
          onOut: noop,
          onStatus: noop,
          onError: noop,
        });
        queue.setOnPrintingChange(noop);
        keyQueue.setOnTick(noop);
        queue.pause();
        keyQueue.pause();
        audio.pause();
        if (sessionChanged) {
          socket.close();
          if (socketRef.current === socket) {
            socketRef.current = null;
          }
          if (runtimeState.socket === socket) {
            runtimeState.socket = null;
          }
        }
      };
    }, [booted, ensureAudioStarted, onError, onOut, onStatus, sessionId, noop]);

    useEffect(() => {
      if (!containerRef.current || !canvasRef.current) {
        return;
      }
      const canvas = canvasRef.current;
      const resize = () => {
        if (!containerRef.current) {
          return;
        }
        const width = containerRef.current.clientWidth;
        canvas.style.width = `${width}px`;
        if (paperRef.current) {
          paperRef.current._dirty = true;
        }
      };
      resize();
      const ro = new window.ResizeObserver(resize);
      ro.observe(containerRef.current);
      return () => ro.disconnect();
    }, []);

    return React.createElement(
      "div",
      {
        className: "teletype-plugin",
        onKeyDown,
        tabIndex: 0,
        ref: panelRef,
      },
      React.createElement(
        "div",
        { className: "teletype-frame" },
        React.createElement(
          "div",
          { className: "teletype-toolbar" },
          terminalMode === "local"
            ? React.createElement("div", { className: "teletype-status" }, "")
            : React.createElement("div", { className: "teletype-status" }, `status: ${statusLabel}`),
          React.createElement(
            "div",
            { className: "teletype-toolbar-actions" },
            React.createElement(
              "div",
              {
                className: "teletype-case-toggle",
                role: "group",
                "aria-label": "terminal mode: local echo or line connection",
              },
              React.createElement(
                "button",
                {
                  type: "button",
                  className: `teletype-case-option ${terminalMode === "line" ? "active" : ""}`,
                  "aria-pressed": terminalMode === "line",
                  title: "Line: connected to the dashboard agent",
                  onClick: () => setTerminalModeValue("line"),
                },
                "LINE"
              ),
              React.createElement(
                "button",
                {
                  type: "button",
                  className: `teletype-case-option ${terminalMode === "local" ? "active" : ""}`,
                  "aria-pressed": terminalMode === "local",
                  title: "Local echo: keystrokes print straight to paper, no remote. Enter sends CR only — use Ctrl+J for LF.",
                  onClick: () => setTerminalModeValue("local"),
                },
                "LOCAL"
              )
            ),
            React.createElement(
              "div",
              {
                className: "teletype-case-toggle",
                role: "group",
                "aria-label": "teletype model: uppercase-only (33) or lowercase-capable (37)",
              },
              React.createElement(
                "button",
                {
                  type: "button",
                  className: `teletype-case-option ${caseMode === "33" ? "active" : ""}`,
                  "aria-pressed": caseMode === "33",
                  title: "Model 33: uppercase only",
                  onClick: () => setCaseModeValue("33"),
                },
                "33"
              ),
              React.createElement(
                "button",
                {
                  type: "button",
                  className: `teletype-case-option ${caseMode === "37" ? "active" : ""}`,
                  "aria-pressed": caseMode === "37",
                  title: "Model 37: lowercase allowed",
                  onClick: () => setCaseModeValue("37"),
                },
                "37"
              )
            ),
            React.createElement(
              "div",
              {
                className: "teletype-case-toggle",
                role: "group",
                "aria-label": "teletype lid: open or closed",
              },
              React.createElement(
                "button",
                {
                  type: "button",
                  className: `teletype-case-option ${lid === "up" ? "active" : ""}`,
                  "aria-pressed": lid === "up",
                  title: "Lid open",
                  onClick: () => setLidPosition("up"),
                },
                "OPEN"
              ),
              React.createElement(
                "button",
                {
                  type: "button",
                  className: `teletype-case-option ${lid === "down" ? "active" : ""}`,
                  "aria-pressed": lid === "down",
                  title: "Lid closed",
                  onClick: () => setLidPosition("down"),
                },
                "CLOSED"
              )
            ),
            React.createElement(
              "button",
              {
                type: "button",
                className: "teletype-lid-switch",
                onClick: clearSession,
                title: "Clear session",
              },
              "clear"
            ),
          )
          ),
        React.createElement(
          "div",
          { className: "teletype-canvas-wrap", ref: containerRef },
          React.createElement("canvas", { ref: canvasRef, className: "teletype-canvas", "aria-hidden": "true" }),
        ),
      ),
      !booted && React.createElement(
        "button",
        {
          type: "button",
          className: "teletype-boot",
          onClick: () => bootAudio(),
        },
        "PRESS ANY KEY TO SWITCH ON"
      ),
      error
        ? React.createElement("div", { className: "teletype-error", role: "status" }, error)
        : null,
    );
  }

  window.__HERMES_PLUGINS__.register("teletype", TeletypePage);
})();
