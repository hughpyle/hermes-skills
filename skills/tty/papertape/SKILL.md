---
name: papertape
description: >
  Reading and writing punched paper tape
  using a Teletype mechanical terminal
version: 1.0.0
author: hugh
license: MIT
metadata:
  hermes:
    tags: [teletype, asr33, papertape, punchtape, ASCII, art]
    category: tty
---

The `asr33` repo contains a selection of patterns and programs for working with punched paper tape.

Paper tape is 8-bit binary data, punched with holes, one byte per row.

Read the python script `bin/pattern` for details.  Its output is binary data.

The `bin/patterns` directory contains pattern definitions.  List them with `pattern --list`.

Do NOT try to print the long ones (4kbasic, pdp11*, etc).  10 characters per second means less than 1kilobyte per minute.  That's a long time to wait for a printout.

Good small ones are:

| File | Description |
| --- | --- |
| `ribbon` | An arty ribbon |
| `sequences` | Some interesting bit-sequences |
| `skulls` | Very pretty skulls |
| `invaders` | Various space invaders |
| `hearts` | Cute hearts |
| `bubbles` | Bubbles, kinda |
| --- | --- |

The `pattern` script can also print **text** on tape,
using bitmap fonts.  Use `pattern text --font mod6x13` for example.  Fonts in BDF format are in the `bin/fonts` directory.

Use `pattern --text` to generate text output, as a preview.

Use `pattern --svg` to generate SVG.
