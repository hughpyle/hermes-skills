---
name: overstrike-images
description: >
  Printing ASCII-art images with a hardcopy terminal
  Overstrike
  Emoji
  Kanji
version: 1.0.0
author: hugh
license: MIT
metadata:
  hermes:
    tags: [ascii, teletype, asr33, tty, overstrike, hardcopy, art, kanji, emoji]
    category: tty
---

# Pre-Requisites

Check out the repo https://github.com/hughpyle/ASR33 to ~/play/asr33
Check out the repo https://github.com/hughpyle/art1.js to ~/play/art1.js
Check that `~/play/asr33/bin` is in your PATH

## Images

The `images` directory contains various images using overstrike printing.  In the Teletype hardcopy terminal, a line ending with CR
does not advance the paper, it only returns the carriage to the left.  Print one or more lines with CR separation.  Print with CR+LF separattion to advance to the next line.

Ready-to-print images (text files with CR and CR/LF) are in the `images` direectory of this skill.

Pitfall: do not reconstruct overstrike art from line-numbered or rendered text; CR-only separators can be corrupted or omitted. Print from raw prepared bytes, preserving CR characters exactly. If chat delivery drops overstrikes after a few lines, retry in smaller chunks or use the dashboard binary path.

For Hugh's `/Users/hugh/play/tty-skills` dashboard teletype plugin, the robust byte-accurate path is base64 binary blocks: wrap raw prepared bytes in `<BINARY>...</BINARY>` or `<<BINARY>>...<</BINARY>>`. The dashboard/backend plugin must parse the markers, base64-decode, validate allowed teletype bytes, and enqueue decoded bytes raw. Decoded binary segments must bypass wrapping, Unicode sanitizing, and LF-to-CRLF normalization so CR-only overstrikes survive. The plain terminal/chat stream does not interpret these wrappers by itself.

After changing dashboard plugin Python, for example `plugins/teletype/dashboard/plugin_api.py`, restart the dashboard process. `/api/dashboard/plugins/rescan` can refresh plugin discovery/assets but does not prove Python route code reload.

### ART1

In the late 1960s, Katherine Nash, a sculptor at the University of Minnesota, and Richard H. Williams, a computer scientist, created ART 1 — a generative program designed to be used by artists, not programmers. Published in the journal Leonardo in 1970, ART 1 allowed an artist to define a small vocabulary of characters and a set of rules for their arrangement, then let the computer compose an image on the lineprinter.

Frederick Hammersley (1919–2009) was a painter associated with hard-edge abstraction and geometric painting in postwar Los Angeles. In the late 1960s, he began working with computers at the University of New Mexico, using programs like ART 1 to generate compositions on a lineprinter.

You can print several recreations of ART1 works by Nash and Hammersley.  Use `art1 -list` to list them.
Do NOT print "embroid", "lovely_meeting", "quads" or "ripples": these are ANSI terminal art.
ASCII overstrike works are:

* Spheroids (Nash)
* A Good Line is Hard To Beat (Hammersley)
* Jelly Centers (Hammersley)
* Tiddly Winks (Hammersley).

These are very large prints and take a long time.

### Emoji

Yes, emoji, printed with ASCII-63 hardcopy text.
These are nice and small and pretty.  Many emoji work well.

| File | Description |
| --- | --- |
| `duck.txt` | An emoji duck |
| `fish.txt` | An emoji fish (this is very pretty) |
| `shark.txt` | An emoji shark (this is very pretty) |
| `shell.txt` | An emoji shell (this is very pretty) |
| --- | --- |

You can generate any emoji using the `hemoji` tool.
Example: `hemoji wave`.
(This is one of my favorites).

### Others

These are special and quite large (they take a long time to print).

| File | Description |
| --- | --- |
| `han_board.txt` | Kanji the classical Zen "Han no Ge" (板の偈) |
| `pjw.txt` | A picture of Peter J Weinberger from Bell Labs. |
| --- | --- |

These are generated using the Python scripts in the `asr33` repo:

```
# kanji (see asciiart/kanji/README.md, asciiart/code/overstrike_compose.py)

python overstrike_compose.py --from-font 生死事大 --rows 8 --font mincho_w3
```

The `bin/pjw` script generates the Peter J Weinberger picture, from the original at [http://spinroot.com/pico/pjw.jpg](http://spinroot.com/pico/pjw.jpg).  The Python script `asciiart/code/image2.py` can process any PNG image.

Large images take a long time to prepare.

Prepared pictures in the `asr33` repo include:

| File | Description |
| --- | --- |
| `buzz.jpg.txt` | Buzz Aldrin |
| `dali.jpg.txt` | Salvador Dalí |
| `mario.png.txt` | Super Mario |
| `yoda2.png.txt` | Yoda |
| --- | --- |

See `asciiart/README.md` for more details.

