# Third-party notices

Granted is made by Tyrannosaurx LLC; its own licence is in [LICENSE](LICENSE). It includes or depends on the
third-party software, fonts and files below, each under its own licence, which it keeps.

This file is generated from pnpm-lock.yaml (the production dependencies and their patches), the licences
`pnpm licenses list --prod` reports and the list of third-party files those do not show; each release checks
it against them.

## axe-core (bundled, unmodified)

- axe-core 4.14.0, Copyright (c) Deque Systems, Inc.
- Licence: Mozilla Public License 2.0 (MPL-2.0), https://www.mozilla.org/en-US/MPL/2.0/
- Source: https://github.com/dequelabs/axe-core (the exact release: https://github.com/dequelabs/axe-core/tree/v4.14.0)

Granted runs axe-core as published on npm, without changes. Its source code is available at the address
above under the MPL-2.0. Granted's own code uses facts from axe-core's rule metadata (the rule ids, tags and
impact levels generated into `packages/engine/src/ruleImpacts.ts`), and its zoom test (WCAG 1.4.4) reproduces the
pass or fail of axe-core's `meta-viewport` check so that it never reports what axe already reports; neither
contains axe-core source code.

## Quoted documents

- Web Content Accessibility Guidelines (WCAG) 2.2 (https://www.w3.org/TR/WCAG22/), W3C Recommendation 12 December 2024. Source comments, tests, prompts and report text quote short passages of it (success criteria, definitions and exceptions) and name its success criteria and the W3C techniques and failures.
  Copyright © 2020-2024 World Wide Web Consortium. W3C® liability, trademark and document use rules apply (https://www.w3.org/copyright/document-license/).

## Fonts

Latin subsets of fonts from github.com/google/fonts (commit 6c1dbe27dcf7d817d4b62cec033ba77fa8e2a5ec), made with
packages/engine/scripts/subset-fonts.sh except where noted. The engine's test pages and Granted's hosted report embed
them; the web app serves them. Each folder carries the fonts' licence files.

- Archivo (https://github.com/Omnibus-Type/Archivo), Copyright 2020 The Archivo Project Authors; Latin subsets; the italic face (apps/web only) was added on 2026-11-07 without subset-fonts.sh.
  SIL Open Font License 1.1 (`apps/web/public/fonts/Archivo-OFL.txt`, `packages/engine/assets/fonts/Archivo-OFL.txt`).
- IBM Plex Mono (https://github.com/IBM/plex), Copyright 2017 IBM Corp.; Latin subsets, renamed "Granted Mono" ("Plex" is a Reserved Font Name).
  SIL Open Font License 1.1 (`apps/web/public/fonts/IBMPlexMono-OFL.txt`, `packages/engine/assets/fonts/IBMPlexMono-OFL.txt`).

## Test fixtures only

Unmodified copies, as published on npm, in packages/engine/test/fixtures/listener-alone/vendor/ (see its README.md).
The engine's tests load them into local test pages to see what listeners a charting library adds to its chart by
default. They are not dependencies of the engine, the Worker or the web app, and the built package does not include them.

- Chart.js 4.4.7 (https://www.chartjs.org, https://www.npmjs.com/package/chart.js), Copyright (c) 2014-2024 Chart.js Contributors; chart.js@4.4.7 dist/chart.umd.js, unmodified.
  MIT License (`packages/engine/test/fixtures/listener-alone/vendor/chartjs/LICENSE.md`).
- Apache ECharts 5.5.1 (https://echarts.apache.org, https://www.npmjs.com/package/echarts), Copyright 2017-2024 The Apache Software Foundation; echarts@5.5.1 dist/echarts.simple.min.js, unmodified.
  Apache License 2.0 (`packages/engine/test/fixtures/listener-alone/vendor/echarts/LICENSE`, `packages/engine/test/fixtures/listener-alone/vendor/echarts/NOTICE`).

## Dependencies with a patch or with bundled code

- @cloudflare/playwright 1.3.6 (Apache-2.0) is installed with Granted's patch `patches/@cloudflare__playwright@1.3.6.patch` (pnpm
  `patchedDependencies`). Each file the patch changes stays under that package's licence and carries a
  "Modified by Tyrannosaurx LLC" notice saying what was changed.
- unpdf 1.9.0 contains a serverless build of Mozilla PDF.js (https://github.com/mozilla/pdf.js), Copyright Mozilla Foundation, Apache License 2.0 (Apache-2.0).

## Production dependencies

The production dependencies of every package in this workspace (packages/* and apps/*: the engine, the Worker,
the PDF reader and the web app among them), from pnpm-lock.yaml, with the licence `pnpm licenses list --prod`
reports. Each package's licence text is in its published package. Every package is used as published, except as
listed above.

| Package | Version | Licence | Package page |
|---|---|---|---|
| @cloudflare/playwright | 1.3.6 | Apache-2.0 | https://www.npmjs.com/package/@cloudflare/playwright |
| @modelcontextprotocol/client | 2.4.0 | Apache-2.0 | https://www.npmjs.com/package/@modelcontextprotocol/client |
| @modelcontextprotocol/core | 2.4.0 | Apache-2.0 | https://www.npmjs.com/package/@modelcontextprotocol/core |
| @openai/agents | 0.20.0 | MIT | https://www.npmjs.com/package/@openai/agents |
| @openai/agents-core | 0.20.0 | MIT | https://www.npmjs.com/package/@openai/agents-core |
| @openai/agents-openai | 0.20.0 | MIT | https://www.npmjs.com/package/@openai/agents-openai |
| @openai/agents-realtime | 0.20.0 | MIT | https://www.npmjs.com/package/@openai/agents-realtime |
| @pdf-lib/standard-fonts | 1.0.0 | MIT | https://www.npmjs.com/package/@pdf-lib/standard-fonts |
| @pdf-lib/upng | 1.0.1 | MIT | https://www.npmjs.com/package/@pdf-lib/upng |
| @standard-schema/spec | 1.1.0 | MIT | https://www.npmjs.com/package/@standard-schema/spec |
| @stripe/stripe-js | 10.1.0 | MIT | https://www.npmjs.com/package/@stripe/stripe-js |
| @types/node | 22.20.5 | MIT | https://www.npmjs.com/package/@types/node |
| @types/ws | 8.18.2 | MIT | https://www.npmjs.com/package/@types/ws |
| axe-core | 4.14.0 | MPL-2.0 | https://www.npmjs.com/package/axe-core |
| cross-spawn | 7.0.6 | MIT | https://www.npmjs.com/package/cross-spawn |
| date-fns | 4.1.0 | MIT | https://www.npmjs.com/package/date-fns |
| date-fns-tz | 3.2.0 | MIT | https://www.npmjs.com/package/date-fns-tz |
| debug | 4.4.3 | MIT | https://www.npmjs.com/package/debug |
| eventsource | 3.0.7 | MIT | https://www.npmjs.com/package/eventsource |
| eventsource-parser | 3.1.1 | MIT | https://www.npmjs.com/package/eventsource-parser |
| fsevents | 2.3.2 | MIT | https://www.npmjs.com/package/fsevents |
| isexe | 2.0.0 | ISC | https://www.npmjs.com/package/isexe |
| jose | 6.2.14 | MIT | https://www.npmjs.com/package/jose |
| ms | 2.1.3 | MIT | https://www.npmjs.com/package/ms |
| openai | 7.46.0 | Apache-2.0 | https://www.npmjs.com/package/openai |
| pako | 1.0.11 | (MIT AND Zlib) | https://www.npmjs.com/package/pako |
| path-key | 3.1.1 | MIT | https://www.npmjs.com/package/path-key |
| pdf-lib | 1.17.1 | MIT | https://www.npmjs.com/package/pdf-lib |
| pkce-challenge | 5.0.1 | MIT | https://www.npmjs.com/package/pkce-challenge |
| playwright | 1.61.1 | Apache-2.0 | https://www.npmjs.com/package/playwright |
| playwright-core | 1.61.1 | Apache-2.0 | https://www.npmjs.com/package/playwright-core |
| shebang-command | 2.0.0 | MIT | https://www.npmjs.com/package/shebang-command |
| shebang-regex | 3.0.0 | MIT | https://www.npmjs.com/package/shebang-regex |
| tslib | 1.14.1 | 0BSD | https://www.npmjs.com/package/tslib |
| undici | 7.29.1 | MIT | https://www.npmjs.com/package/undici |
| undici-types | 6.21.0 | MIT | https://www.npmjs.com/package/undici-types |
| unpdf | 1.9.0 | MIT | https://www.npmjs.com/package/unpdf |
| which | 2.0.2 | ISC | https://www.npmjs.com/package/which |
| ws | 8.22.0 | MIT | https://www.npmjs.com/package/ws |
| zod | 4.6.7 | MIT | https://www.npmjs.com/package/zod |

## Third-party files in this repository

Files that are not package dependencies, each under its own licence. The public export copies each one unchanged
and never puts Granted's licence header on it.

| File | What | Licence |
|---|---|---|
| `apps/web/public/fonts/Archivo-OFL.txt` | Archivo: licence text | OFL-1.1 |
| `apps/web/public/fonts/IBMPlexMono-OFL.txt` | IBM Plex Mono: licence text | OFL-1.1 |
| `apps/web/public/fonts/archivo-italic-latin.woff2` | Archivo | OFL-1.1 |
| `apps/web/public/fonts/archivo-latin.woff2` | Archivo | OFL-1.1 |
| `apps/web/public/fonts/ibm-plex-mono-400-latin.woff2` | IBM Plex Mono | OFL-1.1 |
| `apps/web/public/fonts/ibm-plex-mono-500-latin.woff2` | IBM Plex Mono | OFL-1.1 |
| `apps/web/public/fonts/ibm-plex-mono-600-latin.woff2` | IBM Plex Mono | OFL-1.1 |
| `packages/engine/assets/fonts/Archivo-OFL.txt` | Archivo: licence text | OFL-1.1 |
| `packages/engine/assets/fonts/IBMPlexMono-OFL.txt` | IBM Plex Mono: licence text | OFL-1.1 |
| `packages/engine/assets/fonts/archivo-latin.woff2` | Archivo | OFL-1.1 |
| `packages/engine/assets/fonts/ibm-plex-mono-400-latin.woff2` | IBM Plex Mono | OFL-1.1 |
| `packages/engine/assets/fonts/ibm-plex-mono-500-latin.woff2` | IBM Plex Mono | OFL-1.1 |
| `packages/engine/assets/fonts/ibm-plex-mono-600-latin.woff2` | IBM Plex Mono | OFL-1.1 |
| `packages/engine/test/fixtures/listener-alone/vendor/chartjs/LICENSE.md` | Chart.js: licence text | MIT |
| `packages/engine/test/fixtures/listener-alone/vendor/chartjs/chart.umd.js` | Chart.js | MIT |
| `packages/engine/test/fixtures/listener-alone/vendor/echarts/LICENSE` | Apache ECharts: licence text | Apache-2.0 |
| `packages/engine/test/fixtures/listener-alone/vendor/echarts/NOTICE` | Apache ECharts: licence text | Apache-2.0 |
| `packages/engine/test/fixtures/listener-alone/vendor/echarts/echarts.simple.min.js` | Apache ECharts | Apache-2.0 |
