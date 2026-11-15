// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The batched typing of the forms test (`typeText`: one round trip on a remote browser) must give the page
// the same key events, in the same order, as Playwright's `keyboard.type`, which waits for each event.
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syntheticValue, TEST_MARK } from '../../src/probes/forms.js';
import { typeText } from '../../src/probes/keys.js';
import type { CDPSessionLike } from '../../src/types.js';
import type { ProbeContext } from '../../src/probes/types.js';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 30_000);
afterAll(async () => { await browser?.close(); });

/** A field that records every keyboard and input event it gets, and its value. */
const PAGE = `<!doctype html><html lang="en"><body><label>Field <input id="f"></label><script>
  window.log = [];
  const f = document.getElementById('f');
  for (const t of ['keydown', 'keypress', 'beforeinput', 'input', 'keyup']) f.addEventListener(t, (e) => {
    log.push([e.type, e.key, e.code, e.keyCode, e.which, e.charCode, e.location, e.repeat, e.shiftKey, e.ctrlKey, e.altKey, e.metaKey, e.isComposing, e.isTrusted, e.inputType, e.data, f.value].join('|'));
  });
</script></body></html>`;

async function typed(how: 'playwright' | 'batched', text: string, cdpOf?: (page: Page) => Promise<CDPSessionLike | undefined>): Promise<{ log: string[]; value: string }> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.setContent(PAGE);
    await page.focus('#f');
    if (how === 'playwright') await page.keyboard.type(text);
    else await typeText({ page } as unknown as ProbeContext, cdpOf ? await cdpOf(page) : ((await context.newCDPSession(page)) as unknown as CDPSessionLike), text);
    return await page.evaluate(() => ({ log: (window as unknown as { log: string[] }).log, value: (document.getElementById('f') as HTMLInputElement).value }));
  } finally {
    await context.close();
  }
}

const ASCII = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('');

describe('forms: batched typing', () => {
  it('every printable ASCII character, and the values the forms test types, reach the page as keyboard.type sends them', async () => {
    const values = [ASCII, syntheticValue({ type: 'email', label: 'Email', placeholder: '', name: 'email', id: '', autocomplete: '', minLength: 0, maxLength: 0, min: '', pattern: '' }), `!!${TEST_MARK}!!`, '31/31/2024', '555-0100'];
    for (const v of values) {
      const want = await typed('playwright', v);
      expect(want.value).toBe(v);
      expect(await typed('batched', v)).toEqual(want);
    }
  }, 60_000);

  it('text outside printable ASCII, or no CDP session, is typed by keyboard.type (nothing sent over CDP)', async () => {
    let sends = 0;
    const counting = async () => ({ send: async () => { sends++; return {}; } }) as unknown as CDPSessionLike;
    expect(await typed('batched', 'café – naïve', counting)).toEqual(await typed('playwright', 'café – naïve'));
    expect(sends).toBe(0);
    expect(await typed('batched', 'café', async () => undefined)).toEqual(await typed('playwright', 'café'));
  }, 60_000);

  it('a session that applies the key events and then drops every answer: one copy of the text, and it throws (never typed again)', async () => {
    // A fake field the session types into, then every send's answer is lost (Grok r1 MEDIUM).
    let value = '';
    const cdp = {
      async send(_: string, e: { type: string; text?: string }) {
        if (e.type === 'keyDown' && e.text) value += e.text;
        throw new Error('Target page, context or browser has been closed');
      },
    } as unknown as CDPSessionLike;
    const page = { keyboard: { type: async (t: string) => { value += t; } } };
    await expect(typeText({ page } as unknown as ProbeContext, cdp, 'grntedtest@example.invalid')).rejects.toThrow();
    expect(value).toBe('grntedtest@example.invalid');
  });

  it('a session that takes only some of the key events throws (part of the text went in), never types it again', async () => {
    let n = 0;
    const page = { keyboard: { type: async () => { throw new Error('typed again'); } } };
    const cdp = { send: async () => { if (++n > 3) throw new Error('gone'); return {}; } } as unknown as CDPSessionLike;
    await expect(typeText({ page } as unknown as ProbeContext, cdp, 'abcd')).rejects.toThrow('gone');
  });
});
