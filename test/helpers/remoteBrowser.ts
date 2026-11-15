// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// A Chromium the tests reach the way the hosted checker reaches Browser Rendering: Playwright here,
// the browser behind a network link, every CDP message delayed. A TCP proxy delays every chunk each
// way (`delayMs`, so a round trip costs twice that), which is what makes Playwright's several calls
// per screenshot, or per page call, cost what they cost on a remote browser. No extra dependencies.
import { createServer, connect, type Server, type Socket } from 'node:net';
import { chromium, type Browser } from 'playwright';

export interface RemoteBrowser {
  /** Connected over CDP through the delaying proxy. */
  browser: Browser;
  /** Chunks of bytes forwarded so far, both ways. */
  chunks(): number;
  close(): Promise<void>;
}

/** Forwards bytes between two sockets, each chunk after `delayMs`, in order. */
function pipeLater(from: Socket, to: Socket, delayMs: number, count: () => void): void {
  from.on('data', (chunk) => {
    count();
    setTimeout(() => {
      if (!to.destroyed) to.write(chunk);
    }, delayMs);
  });
  from.on('close', () => setTimeout(() => to.destroy(), delayMs));
  from.on('error', () => to.destroy());
}

async function proxy(targetPort: number, delayMs: number, count: () => void): Promise<Server> {
  const server = createServer((client) => {
    const up = connect(targetPort, '127.0.0.1');
    pipeLater(client, up, delayMs, count);
    pipeLater(up, client, delayMs, count);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

/** A local Chromium behind a link with `delayMs` each way (`delayMs` 40: an 80 ms round trip). */
export async function remoteBrowser(delayMs: number): Promise<RemoteBrowser> {
  let launched: Browser | undefined;
  let port = 0;
  // A free debugging port: Chromium cannot report one it picked itself to a launch over a pipe.
  for (let i = 0; i < 5 && !launched; i++) {
    port = 20_000 + Math.floor(Math.random() * 20_000);
    try {
      launched = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
    } catch {
      launched = undefined;
    }
  }
  if (!launched) throw new Error('could not launch Chromium with a debugging port');
  let info: { webSocketDebuggerUrl?: string } | undefined;
  for (let i = 0; i < 50 && !info?.webSocketDebuggerUrl; i++) {
    info = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json() as Promise<{ webSocketDebuggerUrl?: string }>).catch(() => undefined);
    if (!info?.webSocketDebuggerUrl) await new Promise((r) => setTimeout(r, 100));
  }
  if (!info?.webSocketDebuggerUrl) throw new Error('Chromium did not report its CDP endpoint');
  let chunks = 0;
  const server = await proxy(port, delayMs, () => { chunks++; });
  const address = server.address();
  const proxyPort = typeof address === 'object' && address ? address.port : 0;
  const browser = await chromium.connectOverCDP(info.webSocketDebuggerUrl.replace(/127\.0\.0\.1:\d+|localhost:\d+/, `127.0.0.1:${proxyPort}`));
  return {
    browser,
    chunks: () => chunks,
    async close() {
      await browser.close().catch(() => {});
      await launched!.close().catch(() => {});
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
