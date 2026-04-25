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

Check that `~/play/asr33/bin` is in your PATH

## Images

The `images` directory contains various images using overstrike printing.  In the Teletype hardcopy terminal, a line ending with CR
does not advance the paper, it only returns the carriage to the left.  Print one or more lines with CR separation.  Print with CR+LF separattion to advance to the next line.

Ready-to-print images (text files with CR and CR/LF) are in the `images` direectory:

### Emoji

Yes, emoji, printed with ASCII-63 hardcopy text.

| File | Description |
| --- | --- |
| `duck.txt` | An emoji duck |
| `fish.txt` | An emoji fish (this is very pretty) |
| `shark.txt` | An emoji shark (this is very pretty) |
| `shell.txt` | An emoji shell (this is very pretty) |
| --- | --- |

You can generate any emoji using the `hemoji` tool.
Example: `hemoji wave`.

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
