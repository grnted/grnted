// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Key presses for the tab walks (overlays, keyboard): Tab and Shift+Tab as one batch of CDP key
// events, one round trip on a remote browser instead of Playwright's two to four. Engine core: no
// Node-only imports.
import type { CDPSessionLike } from '../types.js';
import type { ProbeContext } from './types.js';

/**
 * Tab, or Shift+Tab, as one batch of CDP key events (one round trip; Playwright's `keyboard.press`
 * waits for each event, two to four round trips on a remote browser). Without a CDP session, or
 * when the session refused every event (nothing reached the page), `keyboard.press`. When only some
 * events failed, the key may already have moved focus: it is not pressed again (that would skip a
 * stop); a Shift left down is released.
 */
export async function pressTab(ctx: Pick<ProbeContext, 'page'>, cdp: CDPSessionLike | undefined, back: boolean): Promise<void> {
  if (cdp) {
    const tab = { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers: back ? 8 : 0 };
    const shift = { key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16, location: 1 };
    const events = back
      ? [{ type: 'rawKeyDown', ...shift, modifiers: 8 }, { type: 'rawKeyDown', ...tab }, { type: 'keyUp', ...tab }, { type: 'keyUp', ...shift, modifiers: 0 }]
      : [{ type: 'rawKeyDown', ...tab }, { type: 'keyUp', ...tab }];
    // Sent together: the browser handles a session's commands in order.
    const sent = await Promise.allSettled(events.map((e) => cdp.send('Input.dispatchKeyEvent', e)));
    const failed = sent.filter((r) => r.status === 'rejected').length;
    if (!failed) return;
    if (failed < sent.length) {
      if (back) await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...shift, modifiers: 0 }).catch(() => {});
      return;
    }
  }
  await ctx.page.keyboard!.press(back ? 'Shift+Tab' : 'Tab');
}

/**
 * The US layout's code and key code for each printable ASCII character, as Playwright's
 * `keyboard.type` presses it (its `usKeyboardLayout`: shifted characters are sent with their own key
 * and text and no Shift, as Playwright does).
 */
const ASCII_KEYS: Record<string, readonly [code: string, keyCode: number]> = (() => {
  const out: Record<string, readonly [string, number]> = { ' ': ['Space', 32] };
  for (let i = 0; i < 26; i++) {
    const code = `Key${String.fromCharCode(65 + i)}`;
    out[String.fromCharCode(97 + i)] = [code, 65 + i];
    out[String.fromCharCode(65 + i)] = [code, 65 + i];
  }
  const digitShift = ')!@#$%^&*(';
  for (let i = 0; i < 10; i++) {
    out[String(i)] = [`Digit${i}`, 48 + i];
    out[digitShift[i]!] = [`Digit${i}`, 48 + i];
  }
  const symbols: [string, string, string, number][] = [
    [';', ':', 'Semicolon', 186], ['=', '+', 'Equal', 187], [',', '<', 'Comma', 188], ['-', '_', 'Minus', 189],
    ['.', '>', 'Period', 190], ['/', '?', 'Slash', 191], ['`', '~', 'Backquote', 192], ['[', '{', 'BracketLeft', 219],
    ['\\', '|', 'Backslash', 220], [']', '}', 'BracketRight', 221], ["'", '"', 'Quote', 222],
  ];
  for (const [plain, shifted, code, keyCode] of symbols) {
    out[plain] = [code, keyCode];
    out[shifted] = [code, keyCode];
  }
  return out;
})();

/**
 * Types `text` into the focused element as `keyboard.type` does (each character's keydown and keyup,
 * the same events), as one batch of CDP key events: one round trip on a remote browser instead of two
 * per character (Playwright waits for each event). The browser handles a session's commands in order.
 * Without a CDP session, or with a character outside printable ASCII, `keyboard.type` (nothing is sent
 * over CDP). Once the batch is sent, any event that fails throws, as `keyboard.type` does on a session
 * that dies: a failed answer does not say the event never reached the page (the browser may have typed
 * it and lost the answer), so the text is never typed again.
 */
export async function typeText(ctx: Pick<ProbeContext, 'page'>, cdp: CDPSessionLike | undefined, text: string): Promise<void> {
  const chars = [...text];
  if (cdp && chars.every((c) => ASCII_KEYS[c])) {
    const events = chars.flatMap((key) => {
      const [code, windowsVirtualKeyCode] = ASCII_KEYS[key]!;
      return [
        { type: 'keyDown', modifiers: 0, windowsVirtualKeyCode, code, commands: [], key, text: key, unmodifiedText: key, autoRepeat: false, location: 0, isKeypad: false },
        { type: 'keyUp', modifiers: 0, key, windowsVirtualKeyCode, code, location: 0 },
      ];
    });
    // Every send is settled before this returns or throws, so no key event is still on its way after.
    const sent = await Promise.allSettled(events.map((e) => cdp.send('Input.dispatchKeyEvent', e)));
    const failed = sent.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason instanceof Error ? failed.reason : new Error('the browser stopped taking key presses while typing');
    return;
  }
  await ctx.page.keyboard!.type(text);
}
