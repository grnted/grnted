# Screen-reader transcript format (`grnted-sr-transcript/1`)

The one JSON shape for what a screen reader says on a page, shared by the simulated screen reader
(`src/probes/screenReader/`, read from Chromium's accessibility tree over CDP) and the real-VoiceOver
calibration harness on the Mac mini (builder `vo-calibration`, `tools/voiceover/`). Both sides write
the same shape for the same pages, so a script can compare them line by line. Agreed 2026-11-05.
This file is the contract: when a message and this file differ, this file wins.

## One file per page

```jsonc
{
  "format": "grnted-sr-transcript/1",
  "source": "simulated-chromium-ax",        // or "voiceover-macos", "nvda"
  "sourceVersion": "grnted-sr 0.1.0, Chromium 140", // VO: "macOS <ver> (<build>), VoiceOver <ver>, Safari <ver>"
  "page": "sr/unnamed-button",              // stable page id <suite>/<slug>: gold/about, gold/news__board-approves-the-budget,
                                            // sample/events, sr/<fixture file stem>. The diff keys on this, else on the URL path.
  "url": "http://127.0.0.1:4173/unnamed-button.html",
  "capturedAt": "2026-11-05T21:04:00.000Z",
  "viewport": { "width": 1280, "height": 900 },
  "readThrough": [ /* Utterance… */ ],     // reading top to bottom (VO+Right / NVDA browse-mode down arrow)
  "lists": {                                // the elements list (NVDA) / rotor (VO), document order
    "headings": [], "landmarks": [], "links": [], "formControls": [], "tables": []
  },
  "tabStops": [ /* Utterance… */ ],         // optional: what is said at each Tab stop from the page start
  "truncated": false,                       // true when a cap stopped the capture
  "notes": "optional free text (VO: how the read-through was driven)"
}
```

## Utterance

```jsonc
{
  "text": "Email, required, invalid data, edit text", // REQUIRED. VO: the exact spoken line (caption panel);
                                            // simulated: the phrase the announcement rules render. Never compared.
  "role": "textbox",                        // lowercase ARIA role; plain text = "statictext"; "unknown" when unmappable
  "name": "Email",                          // accessible name only (no role or state words), whitespace collapsed, trimmed
  "nodeRef": "#signup > input:nth-of-type(1)", // optional CSS path (simulated always sets it; VO may omit). Never compared.
  "level": 2,                               // optional: heading level
  "states": ["invalid", "required"],        // optional, sorted, from the vocabulary below
  "landmark": "main",                       // optional: the innermost landmark role the item is in
  "event": "item"                           // optional: "enter" | "exit" | "item" (default "item")
}
```

- **States vocabulary** (lowercase, fixed): `visited`, `required`, `invalid`, `expanded`, `collapsed`,
  `checked`, `unchecked`, `mixed`, `disabled`, `current`, `selected`, `pressed`, `readonly`. VO's
  "not checked"/"unchecked" map to `unchecked`, "current page" (any aria-current) to `current`,
  "dimmed" to `disabled`, "read-only" to `readonly`.
- **Enter and exit lines:** entering a landmark, list or table is an `enter` line (role = the landmark,
  `list` or `table`; name = its label or ""), with the count in `text` ("list, 3 items"). Leaving it is
  an `exit` line ("end of navigation", "out of list").
- **Roles** are ARIA role names, not Chromium's internal ones: `img` (not `image`), `statictext`
  (Chromium `StaticText`). Layout tables (Chromium `LayoutTable`) are not announced as tables.

## How the two sides are compared

1. Drop `exit` lines and `list`/`listitem`/`group` container lines on both sides.
2. Normalize names: case-insensitive, whitespace collapsed, trailing punctuation trimmed.
3. Align the two sequences by (`role`, `name`) with a longest common subsequence.
4. Per matched pair compare `level`, `states` and `landmark`. A state one side cannot produce is left
   out of the per-state agreement instead of failing the pair (Chromium's tree never says `visited`, for
   privacy).
5. `text` is for people and for tuning the announcement rules (`rules.ts`); it is never compared.

## Producing simulated transcripts

`node packages/engine/scripts/sr-transcript.mjs --out <dir> <page id>=<url> [<page id>=<url> …]`
(run `pnpm -C packages/engine build` first) writes `<dir>/<page id with "/" replaced by "__">.json` for
each page, against any running server. Real VoiceOver baselines go to `tools/voiceover/baselines/`.
