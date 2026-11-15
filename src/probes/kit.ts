// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// In-page helpers shared by the motion, audio, timing and motion-actuation probes (Plan 4 Task 4.4).
// `installKit` runs in the page (serialized, so self-contained) and defines `window.__grntedKit`;
// the probes' other in-page functions use it through `kitOf()`-style casts. Engine core.
import type { PendingTimer } from './types.js';

/** A box in document coordinates (CSS px). */
export interface KitBox { x: number; y: number; w: number; h: number }

export interface KitElement {
  /** Handle for later `page.evaluate` calls (`kit.get(id)`). */
  id: number;
  path: string;
  name?: string;
  tag: string;
}

/** A batch of mutations seen by the kit's observer, with its time (performance.now()). */
export interface KitBatch { t: number; records: MutationRecord[] }

/** Options of `Kit.controls`. */
export interface ControlOptions {
  maxWords?: number;
  lookOnly?: boolean;
  nearOnly?: boolean;
  /**
   * Only with `lookOnly` (never clicked; 2.2.1): a regular expression (source, matched
   * case-insensitively on the name). A button (`button`, `input[type=button|submit]`,
   * `role="button"`; never a plain link, which is a sentence about the limit) whose name it matches
   * counts whatever its length, unless the name is about something other than the limit (alerts,
   * notifications, email, newsletters, messages, reminders, warnings): "Turn off automatic sign-out
   * for this account" counts, "Turn off email alerts" does not. With `phrase`, the verb-led rule is
   * off (a "Stop session recording" button is not a time-limit control), and disabled controls
   * (`disabled`, `aria-disabled="true"`) are not counted.
   */
  phrase?: string;
  /**
   * Toggles count too (a check box, `role="switch"` or `role="checkbox"`, a button with
   * `aria-pressed`) when their name has one of these words, whatever else it says ("Shake to
   * undo", "Tilt to change slides"); other controls still need the vocabulary rule. The caller must
   * prove that a toggle does what it says (motion-actuation: flipping it stops the motion response,
   * flipping it back restores it).
   */
  toggles?: readonly string[];
  /**
   * 2.2.2 (act-watch review r1, F6a): a button in the near element's own container (the element and its two
   * nearest ancestors) named only to close or hide it ("Close", "Dismiss", "×", "Close alert", "Hide banner")
   * is a hide control too. Needs `near`; never with `lookOnly`.
   */
  closers?: boolean;
  /**
   * 2.2.2 (batch 19, precision lane): mechanisms the vocabulary does not name are candidates too, never taken for "no
   * control": WCAG allows "other mechanisms than a button", and a name in other words ("Calm mode", "Hold", "Turn off
   * auto-scroll") or a check box, switch or pressed toggle may be one. Candidates: in the near element's own container
   * (the element and its two nearest ancestors) any shown button or toggle that is not named for previous / next / a
   * slide's number or position (and not for the visitor's account, money or data), and one unnamed button when it is
   * the only one there (several alike are a carousel's dots); anywhere on the page a button or toggle whose name is
   * about motion ("Reduce motion", "Animations", "Autoplay"). Tried like named ones; one that cannot be is listed
   * (`refused`), so the item has no verdict. Needs `near`.
   */
  unknown?: boolean;
}

/** What `window.__grntedKit` offers to in-page probe code. */
export interface Kit {
  get(id: number): Element | undefined;
  keep(el: Element): number;
  /** Rendered, with a box, not hidden by visibility, display, content-visibility or opacity. */
  visible(el: Element | null | undefined, ignoreOpacity?: boolean): boolean;
  /** Box in document coordinates. */
  box(el: Element): KitBox;
  area(el: Element): number;
  describe(el: Element): KitElement;
  /** Cheap accessible name (aria-label, labelledby, alt, value, text, title, an image's alt; max 100). */
  name(el: Element): string;
  /** Starts recording mutations of the document (idempotent). */
  observe(): void;
  /** Mutations recorded since the last call (pending ones included). */
  take(): KitBatch[];
  /**
   * Stops (true) or resumes (false) recording mutations: what happens in between is dropped. Used
   * around screenshots, because the browser tool briefly restyles text fields to hide their caret.
   */
  mute(on: boolean): void;
  /** Elements that the mutations changed (attribute targets, parents of text and child changes, added elements). */
  changed(records: readonly MutationRecord[]): Element[];
  /** Lowest common ancestor element, or null (body and html do not count). */
  lca(els: readonly Element[]): Element | null;
  /**
   * Controls whose accessible name (or title) is short (`maxWords`, default 3) and made only of the
   * given control words (lower case; e.g. "pause slideshow", "mute"), nearest to `near` first (inside
   * its ancestors, up to a container about four times its size), then anywhere on the page unless
   * `nearOnly`. Rendered controls only (opacity 0 allowed: some appear on hover). Names with account,
   * subscription, membership, trial, profile or order are never controls.
   * Clickable kinds only: <button> (not a form's submit button), <input type=button> and
   * role="button" (an <a role=button> only with href "#" or "#fragment", never javascript:, empty or
   * "#/route"). With `lookOnly` (never clicked; 2.2.1 looks for an extend control) submit buttons and
   * links count too. Word matches of a kind that cannot be clicked are listed by `refused()`.
   * `phrase` (with `lookOnly` only): a name this pattern matches is a control too, however many words
   * it has, and its own time-limit words ("sign-out", "log out") do not make it FORBIDDEN.
   */
  controls(near: Element | null, words: readonly string[], max: number, opts?: ControlOptions): Element[];
  /** Matching controls the last `controls` call left out, and why. */
  refused(): { name: string; why: string }[];
  /** Stops recording mutations and trapping navigations (a probe calls it when it is done). */
  stop(): void;
  /** Pending timers recorded by the listener hook (empty without it). */
  pending(): PendingTimer[];
  /**
   * Runs a pending timer's callback now (the listener hook's __grntedFire), with script navigations
   * trapped (see `navs`). A timeout is cancelled as if it had fired, unless `keep`.
   */
  fire(handle: number, keep?: boolean): { ok: boolean; error?: string; async?: boolean };
  /** Cancels a pending timeout (the hook's __grntedCancel). */
  cancel(handle: number): boolean;
  /** alert/confirm/prompt/open/submit calls recorded by the hook (with the timer that made them). */
  calls(): { api: string; timer?: number; at: number }[];
  /**
   * Script navigations (Navigation API `navigate` events: location changes, reloads) seen while
   * trapping; each was cancelled, so the page stayed. `handle` is the timer being fired, if any.
   */
  navs: { type: string; url: string; t: number; handle?: number; sameDocument?: boolean }[];
  /** Timers run early through `fire` on this page, by any probe (handle and delay). */
  fired: { handle: number; delay: number }[];
  /** Turns trapping on or off (on while `fire` runs, whatever this says). */
  trap(on: boolean): void;
  /** performance.now() at the end of the load event (0 when unknown). */
  loadEnd(): number;
}

/** Runs in the page: defines window.__grntedKit (idempotent). Returns true when it is there. */
export function installKit(): boolean {
  const w = window as unknown as Record<string, unknown> & { __grntedKit?: Kit };
  if (w.__grntedKit) return true;
  const els: Element[] = [];
  const ids = new Map<Element, number>();
  const clean = (s: string | null | undefined, max = 100) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  let observer: MutationObserver | null = null;
  let batches: KitBatch[] = [];
  let recorded = 0;
  let muted = false;
  let refused: { name: string; why: string }[] = [];
  const MAX_RECORDS = 20000;
  const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'HEAD', 'TITLE', 'NOSCRIPT', 'TEMPLATE', 'HTML', 'BODY']);

  const kit: Kit = {
    get: (id) => els[id],
    keep(el) {
      let id = ids.get(el);
      if (id === undefined) {
        id = els.length;
        els.push(el);
        ids.set(el, id);
      }
      return id;
    },
    visible(el, ignoreOpacity = false) {
      if (!el || !el.isConnected) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const check = (el as Element & { checkVisibility?: (o: Record<string, boolean>) => boolean }).checkVisibility;
      if (typeof check === 'function') return check.call(el, { opacityProperty: !ignoreOpacity, visibilityProperty: true, contentVisibilityAuto: true });
      for (let e: Element | null = el; e; e = e.parentElement) {
        const s = getComputedStyle(e);
        if (s.display === 'none' || (!ignoreOpacity && Number(s.opacity) === 0)) return false;
        if (e === el && s.visibility !== 'visible') return false;
      }
      return true;
    },
    box(el) {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) };
    },
    area(el) {
      const r = el.getBoundingClientRect();
      return Math.round(r.width * r.height);
    },
    describe(el) {
      const id = kit.keep(el);
      const hook = (w.__grntedDescribe as ((e: Element) => { path: string; name?: string } | null) | undefined)?.(el);
      const name = kit.name(el);
      let path = hook?.path ?? '';
      if (!path) {
        const parts: string[] = [];
        for (let e: Element | null = el; e && parts.length < 6; e = e.parentElement) {
          if (e.id) { parts.unshift(`#${CSS.escape(e.id)}`); break; }
          parts.unshift(e.localName);
        }
        path = parts.join(' > ');
      }
      return { id, path, tag: el.localName, ...(name ? { name } : {}) };
    },
    name(el) {
      const a = el.getAttribute('aria-label');
      if (a && a.trim()) return clean(a);
      const lb = el.getAttribute('aria-labelledby');
      if (lb) {
        const s = lb.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
        if (s.trim()) return clean(s);
      }
      if (el instanceof HTMLInputElement) {
        if (el.type === 'image' && el.alt) return clean(el.alt);
        if (/^(button|submit|reset)$/.test(el.type) && el.value) return clean(el.value);
        if (el.labels?.length) return clean([...el.labels].map((l) => l.textContent).join(' '));
      }
      if (el instanceof HTMLImageElement && el.alt) return clean(el.alt);
      const text = clean((el as HTMLElement).innerText ?? el.textContent);
      if (text) return text;
      const title = el.getAttribute('title');
      if (title) return clean(title);
      const img = el.querySelector('img[alt], svg title, [aria-label]');
      if (img) return clean(img.getAttribute('alt') ?? img.getAttribute('aria-label') ?? img.textContent);
      return '';
    },
    observe() {
      if (observer) return;
      observer = new MutationObserver((records) => {
        if (muted || recorded >= MAX_RECORDS) return;
        recorded += records.length;
        batches.push({ t: performance.now(), records });
      });
      observer.observe(document.documentElement, { attributes: true, childList: true, characterData: true, subtree: true });
    },
    take() {
      if (observer) {
        const rest = observer.takeRecords();
        if (rest.length && recorded < MAX_RECORDS) {
          recorded += rest.length;
          batches.push({ t: performance.now(), records: rest });
        }
      }
      const out = batches;
      batches = [];
      // The cap bounds one window between takes, not the page's life: a busy page must not blind
      // later probes on the same page.
      recorded = 0;
      return out;
    },
    mute(on) {
      if (!observer) return;
      const rest = observer.takeRecords();
      if (on && !muted && rest.length && recorded < MAX_RECORDS) {
        recorded += rest.length;
        batches.push({ t: performance.now(), records: rest });
      }
      muted = on;
    },
    changed(records) {
      const out = new Set<Element>();
      const add = (n: Node | null) => {
        const el = n && (n.nodeType === 1 ? (n as Element) : n.parentElement);
        if (el && !SKIP.has(el.tagName)) out.add(el);
      };
      for (const r of records) {
        if (r.type === 'attributes') add(r.target);
        else if (r.type === 'characterData') add(r.target);
        else {
          add(r.target);
          r.addedNodes.forEach((n) => { if (n.nodeType === 1) add(n); });
        }
      }
      return [...out].filter((e) => e.isConnected);
    },
    lca(list) {
      const items = list.filter((e) => e.isConnected).slice(0, 100);
      if (!items.length) return null;
      let a: Element | null = items[0]!;
      while (a && !items.every((e) => a!.contains(e))) a = a.parentElement;
      if (!a || a === document.body || a === document.documentElement) return null;
      return a;
    },
    controls(near, words, max, opts = {}) {
      const vocab = new Set(words);
      const maxWords = opts.maxWords ?? 3;
      // Names that act on the visitor's account, money, messages or data: never clicked, whatever verb leads them.
      const FORBIDDEN = /account|subscri|membership|trial|profile|order|\bpay|billing|donat|purchas|checkout|\bcart\b|cancel|delete|remov|log ?out|sign ?out|password|e-?mails?\b|notification|newsletter|sharing|\bshare\b|alert|delivery|shipment|service/;
      // A control verb leads a name made of ordinary words ("Pause news ticker", "Stop logo carousel",
      // "Pause testimonials"): tried when the name is short and the vocabulary has the verb. The
      // vocabulary's other words ("Sound off", "Turn off animation") are still accepted alone.
      const VERBS = ['pause', 'stop', 'play', 'hide', 'mute', 'freeze', 'resume', '⏸', '⏹', '❚❚', '||', '‖', '🔇'].filter((w) => vocab.has(w));
      const VERB_MAX_WORDS = 4;
      // Vocabulary words that only say what a control is about, never what it does: a plain link named
      // only with these ("Video", "Audio", "Background music", "Slideshow") is navigation, not a control.
      // (Defined here: installKit runs serialized in the page.)
      const CONTROL_NOUNS = new Set([
        'sound', 'audio', 'music', 'volume', 'video', 'animation', 'animations', 'motion', 'slideshow', 'carousel', 'scrolling', 'ticker', 'banner',
        'slides', 'background', 'gif', 'marquee', 'rotation', 'the', 'all', 'time', 'session', 'timer', 'countdown', 'minutes', 'my', 'me', 'in',
        'page', 'item', 'slide', 'sensor', 'sensors', 'gestures', 'tilt', 'tilting', 'shake', 'shaking', 'left', 'right', 'up', 'down', 'here',
      ]);
      // Links and submit buttons are found too: clicking refuses them (listed), looking counts them.
      const BASE_SEL = 'button, input[type="button"], input[type="submit"], [role="button"], a[href]';
      const TOGGLE_SEL = 'input[type="checkbox"], [role="switch"], [role="checkbox"], button[aria-pressed]';
      const toggleWords = opts.toggles ? new Set(opts.toggles) : null;
      const SEL = toggleWords || opts.unknown ? `${BASE_SEL}, ${TOGGLE_SEL}, [role="switch"], [role="checkbox"]` : BASE_SEL;
      // A carousel's own navigation: previous, next, a slide's number or position ("Go to slide 3", "2 of 5", "‹").
      const NAV_NAME = /^(?:(?:go\s+to\s+|show\s+|view\s+)?(?:the\s+)?(?:next|previous|prev|back|forward|first|last)(?:\s+(?:slide|item|story|image|photo|picture|page|one))?|(?:go\s+to\s+|show\s+|view\s+)?(?:slide|item|story|image|photo|picture|page|panel|tab)?\s*\d+(?:\s*(?:of|\/)\s*\d+)?|[‹›«»←→<>❮❯〈〉◀▶●○•·]+)$/i;
      const OPENER_NAME = /\b(?:settings|options|preferences|menu|more|show|open|expand|customi[sz]e|controls)\b/i;
      const MOTION_NAME = /\b(?:motion|animations?|animated|auto[- ]?play(?:ing)?|slide ?shows?|carousels?|scrolling|auto[- ]?scroll(?:ing)?|rotation|auto[- ]?rotat\w*|auto[- ]?advanc\w*|tickers?|movement|moving)\b/i;
      const isToggle = (el: Element) => el.matches(TOGGLE_SEL);
      refused = [];
      // Where `push` is looking now: around `near` (and how far up), or the whole page.
      let nearDepth = -1;
      // A pause verb in a name the rules above leave out (more words, or a topic of the site's own): around `near`
      // it is listed as not tried (the item then has no verdict), never taken for "no control" (act-watch review
      // r1, F6a): "Pause the news ticker on this page", "Pause service alerts", "Hide alert banner". Not when a
      // name about the visitor's account, money or data names nothing that moves ("Stop payments", "Pause
      // membership": still left out, unlisted). Pause verbs only, not play or resume.
      const PAUSE_VERBS = ['pause', 'stop', 'hide', 'freeze', 'mute', '⏸', '⏹', '❚❚', '||', '‖'];
      const MOVING_NOUNS = new Set(['ticker', 'banner', 'carousel', 'slideshow', 'slides', 'slide', 'scrolling', 'marquee', 'animation', 'animations', 'rotation', 'video', 'gif', 'background', 'motion', 'alert', 'alerts', 'news', 'updates', 'feed', 'notice', 'notices', 'announcements', 'headlines']);
      // Close or hide words, and what such a button closes: a closer's whole name (at most 3 words).
      const CLOSE_WORDS = new Set(['close', 'dismiss', 'hide', '×', '✕', '✖', 'x']);
      const CLOSE_NOUNS = new Set(['alert', 'alerts', 'banner', 'notice', 'announcement', 'message', 'bar', 'this', 'the', 'ticker', 'news', 'notification', 'emergency', 'popup']);
      // Accessible name and title only: a class name says nothing a user can see.
      const label = (el: Element) => kit.name(el) || clean(el.getAttribute('title'));
      const phrase = opts.lookOnly && opts.phrase ? new RegExp(opts.phrase, 'i') : null;
      // A time-limit control is a button; a name about something else than the limit is not one.
      const PHRASE_SEL = 'button, input[type="button"], input[type="submit"], [role="button"]';
      const OTHER_THAN_LIMIT = /alert|notification|e-?mails?\b|newsletter|message|reminder|warning/;
      const LIMIT_OWN_WORDS = /\b(?:auto(?:matic)?[\s-]*)?(?:sign|log)[\s-]*(?:out|off)\b/g;
      const ACCOUNT_TAIL = /\bfor (?:this|your|my) account\b/g;
      const named = (el: Element): boolean => {
        const name = label(el).toLowerCase();
        // Looked at, never clicked: a name that says it turns off or extends a time limit counts at any
        // length, and the limit's own words (sign-out, log out) are not a reason to leave it out.
        if (phrase && ((el as HTMLButtonElement).disabled || el.closest('[aria-disabled="true"]'))) return false;
        if (name && phrase && el.matches(PHRASE_SEL) && phrase.test(name) && !OTHER_THAN_LIMIT.test(name)) {
          // The limit's own words (sign-out, log out) and a trailing "for this account" are allowed;
          // any other FORBIDDEN topic ("Stop the order timer") is still not a time-limit control.
          const rest = name.replace(LIMIT_OWN_WORDS, ' ').replace(ACCOUNT_TAIL, ' ');
          return !FORBIDDEN.test(rest);
        }
        const tokens = name.split(/[\s,.:;!?()[\]"/\-–—]+/).filter(Boolean);
        // A closer in the item's own container (`closers`): a button that closes or hides it.
        if (opts.closers && !opts.lookOnly && nearDepth >= 0 && nearDepth <= 2 && tokens.length > 0 && tokens.length <= 3
          && tokens.some((t) => CLOSE_WORDS.has(t)) && tokens.every((t) => CLOSE_WORDS.has(t) || CLOSE_NOUNS.has(t))) return true;
        if (!name || FORBIDDEN.test(name)) return false;
        // A toggle named for what it controls ("Shake to undo"): its state is the off switch.
        if (toggleWords && isToggle(el) && tokens.length <= 10 && tokens.some((t) => toggleWords.has(t))) return true;
        const allVocab = tokens.length > 0 && tokens.length <= maxWords && tokens.every((t) => vocab.has(t));
        const verbLed = !phrase && tokens.length > 0 && tokens.length <= Math.max(maxWords, VERB_MAX_WORDS) && tokens.some((t) => VERBS.includes(t));
        if (!allVocab && !verbLed) return false;
        // A plain link named only with nouns (a menu's "Video") is neither clicked nor counted as untried.
        if (el.localName === 'a' && !el.matches('[role="button"]') && !tokens.some((t) => !CONTROL_NOUNS.has(t))) return false;
        // Looked at only (2.2.1): a plain link is a sentence or a page about the limit, not a control.
        if (phrase && el.localName === 'a' && !el.matches('[role="button"]')) return false;
        return true;
      };
      /** Why a word-matching element is not clicked, or null when it may be. */
      const why = (el: Element): string | null => {
        if (opts.lookOnly) return null;
        if (el.localName === 'a') {
          if (!el.matches('[role="button"]')) return 'it is a link';
          const href = el.getAttribute('href');
          if (href === null) return null;
          const h = href.trim();
          if (/^javascript:/i.test(h)) return 'it is a javascript: link';
          if (h === '#' || /^#[^/]+$/.test(h)) return null;
          return h === '' ? 'it is a link to this page again' : 'it is a link to another address or route';
        }
        if (el instanceof HTMLButtonElement) return el.form && el.type === 'submit' ? 'it would submit a form' : null;
        if (el instanceof HTMLInputElement) return el.type === 'button' || ((toggleWords || opts.unknown) && el.type === 'checkbox') ? null : 'it would submit a form';
        return el.matches('[role="button"]') || ((toggleWords || opts.unknown) && isToggle(el)) ? null : 'it is not a button';
      };
      const out: Element[] = [];
      const seen = new Set<Element>();
      // Matching elements under a root; with `toggles`, inside open shadow roots too (a switch in a
      // custom element).
      const find = (root: Element | Document | ShadowRoot): void => {
        root.querySelectorAll(SEL).forEach(push);
        if (!toggleWords) return;
        root.querySelectorAll('*').forEach((e) => { if (e.shadowRoot) find(e.shadowRoot); });
      };
      const push = (el: Element) => {
        if (out.length >= max || seen.has(el)) return;
        seen.add(el);
        // A check box hidden for a styled switch is used through its label: shown when the label is.
        const shown = kit.visible(el, true) || ((!!toggleWords || !!opts.unknown) && el instanceof HTMLInputElement && el.type === 'checkbox' && [...(el.labels ?? [])].some((l) => kit.visible(l, true)));
        if (!shown) return;
        // Batch 19 (`unknown`): a control the vocabulary does not name may be the mechanism ("other mechanisms than a
        // button can be used"): one in the moving item's own container that is not its previous / next / slide navigation,
        // a toggle there, one unnamed button alone there (several alike are a carousel's dots), or a control anywhere whose
        // name is about motion. It is tried like a named one, under the same rules (never a link, a submit or a name about
        // the visitor's account, money or data); one that cannot be tried is listed, so the item has no verdict.
        let unknownOk = false;
        // A form's submit button sends the form, whatever its name: never a candidate mechanism for the motion.
        const submits = el.matches('input[type="submit" i], input[type="image" i], button[type="submit" i]') || (el.localName === 'button' && !el.hasAttribute('type') && !!(el as HTMLButtonElement).form);
        if (opts.unknown && !opts.lookOnly && !submits && !(el.localName === 'a' && !el.matches('[role="button"]'))) {
          const name = label(el).replace(/\s+/g, ' ').trim();
          const low = name.toLowerCase();
          const near2 = nearDepth >= 0 && nearDepth <= 2;
          // A control that opens something (a settings panel, a menu: its name or its aria-expanded, aria-haspopup,
          // popovertarget, a summary) is how a hidden pause button is reached, never the mechanism itself: the reveal
          // path presses it to look for one (motionShared), as it did before batch 19.
          const opener = !isToggle(el) && (OPENER_NAME.test(low) || el.matches('[aria-expanded], [aria-haspopup]:not([aria-haspopup="false"]), [popovertarget], summary'));
          if (name && !opener && !FORBIDDEN.test(low) && ((near2 && (isToggle(el) || !NAV_NAME.test(name))) || MOTION_NAME.test(low))) unknownOk = true;
          else if (!name && near2 && near && !isToggle(el)) {
            let box: Element | null = near;
            for (let d = 0; d < nearDepth && box?.parentElement; d++) box = box.parentElement;
            const unnamed = box ? [...box.querySelectorAll('button, [role="button"]')].filter((b) => kit.visible(b, true) && !label(b).trim()) : [];
            unknownOk = unnamed.length === 1;
          }
        }
        if (!unknownOk && opts.unknown && isToggle(el) && !toggleWords && !el.matches('button')) return;
        if (!unknownOk && !named(el)) {
          if (nearDepth >= 0 && !opts.lookOnly && refused.length < 10) {
            const name = label(el).toLowerCase();
            const tokens = name.split(/[\s,.:;!?()[\]"/\-–—]+/).filter(Boolean);
            if (tokens.length > 0 && tokens.length <= 8 && tokens.some((t) => PAUSE_VERBS.includes(t) && vocab.has(t)) && (!FORBIDDEN.test(name) || tokens.some((t) => MOVING_NOUNS.has(t)))) {
              refused.push({ name: label(el).slice(0, 60), why: 'its name says more than pausing, stopping or hiding, so it was not clicked' });
            }
          }
          return;
        }
        const no = why(el);
        if (no) {
          if (refused.length < 10) refused.push({ name: label(el).slice(0, 60) || el.localName, why: no });
          return;
        }
        out.push(el);
      };
      if (near) {
        const limit = Math.max(kit.area(near) * 4, innerWidth * innerHeight * 0.6);
        let depth = 0;
        for (let a: Element | null = near; a && a !== document.body && depth < 8; a = a.parentElement, depth++) {
          if (depth > 0 && kit.area(a) > limit) break;
          nearDepth = depth;
          find(a);
          if (a.matches(SEL)) push(a);
        }
      }
      nearDepth = -1;
      if (out.length < max && !opts.nearOnly) find(document);
      return out;
    },
    refused: () => refused.slice(),
    stop() {
      trapping = false;
      observer?.disconnect();
      observer = null;
      batches = [];
      recorded = 0;
    },
    pending() {
      const f = w.__grntedPending as (() => PendingTimer[]) | undefined;
      return typeof f === 'function' ? f() : [];
    },
    fire(handle, keep = false) {
      const f = w.__grntedFire as ((h: number, k: boolean) => { ok: boolean; error?: string; async?: boolean }) | undefined;
      if (typeof f !== 'function') return { ok: false, error: 'no hook' };
      if (kit.fired.length < 500) {
        const p = kit.pending().find((x) => x.handle === handle);
        if (p) kit.fired.push({ handle, delay: p.delay });
      }
      const prev = firing;
      firing = handle;
      try { return f(handle, keep); } finally { firing = prev; }
    },
    cancel(handle) {
      const f = w.__grntedCancel as ((h: number) => boolean) | undefined;
      return typeof f === 'function' ? f(handle) : false;
    },
    calls() {
      const f = w.__grntedCalls as (() => { api: string; timer?: number; at: number }[]) | undefined;
      return typeof f === 'function' ? f() : [];
    },
    navs: [],
    fired: [],
    trap(on) { trapping = on; },
    loadEnd() {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      return nav?.loadEventEnd ?? 0;
    },
  };
  // Script navigations while trapping or firing a timer: recorded and cancelled, so the page stays.
  let trapping = false;
  let firing: number | null = null;
  const nav = (w as unknown as { navigation?: EventTarget }).navigation;
  nav?.addEventListener('navigate', (e: Event) => {
    if (!trapping && firing === null) return;
    const ev = e as Event & { navigationType?: string; destination?: { url: string; sameDocument?: boolean }; cancelable: boolean };
    if (kit.navs.length < 200) {
      kit.navs.push({
        type: ev.navigationType ?? 'push', url: ev.destination?.url ?? '', t: performance.now(),
        ...(firing !== null ? { handle: firing } : {}), ...(ev.destination?.sameDocument ? { sameDocument: true } : {}),
      });
    }
    if (ev.cancelable) ev.preventDefault();
  });
  Object.defineProperty(w, '__grntedKit', { value: kit, configurable: true, enumerable: false, writable: false });
  return true;
}

/**
 * Control-name vocabularies: a control is clicked when its whole name (at most three words) is made of
 * these words, or when its name (at most four words) has one of the vocabulary's control verbs (pause,
 * stop, play, hide, mute, freeze, resume, or their symbols) with ordinary words ("Pause news
 * ticker"). A name about the visitor's account, money, messages or data ("Close account", "Stop
 * subscription", "Stop payments", "Start free trial") never is (kit `controls`, FORBIDDEN).
 */
/** 2.2.2: pausing, stopping or hiding moving content. */
export const PAUSE_VOCAB: readonly string[] = [
  'pause', 'stop', 'play', 'hide', 'freeze', 'mute', 'unmute', 'resume', 'sound', 'audio', 'video', 'animation', 'animations', 'motion', 'slideshow',
  'carousel', 'autoplay', 'off', 'on', 'turn', 'toggle', 'the', 'all', '⏸', '⏹',
  // Neutral nouns for what moves (no action on the site): "Stop scrolling", "Pause background video".
  'scrolling', 'ticker', 'banner', 'slides', 'background', 'gif', 'marquee', 'rotation', '❚❚', '||', '‖',
];
/** 1.4.2: pausing or silencing sound. */
export const AUDIO_VOCAB: readonly string[] = [
  'pause', 'stop', 'play', 'mute', 'unmute', 'resume', 'sound', 'audio', 'music', 'volume', 'video', 'off', 'on', 'turn', 'toggle', 'the', 'all',
  '⏸', '⏹', '🔇', '🔈', '🔉', '🔊',
];
/** 2.2.1: extending, adjusting or turning off a time limit (looked for, never clicked; up to four words). */
export const EXTEND_VOCAB: readonly string[] = [
  'extend', 'more', 'time', 'continue', 'session', 'stay', 'signed', 'logged', 'in', 'keep', 'me', 'turn', 'off', 'disable', 'stop', 'pause',
  'auto', 'automatic', 'refresh', 'reload', 'redirect', 'timer', 'countdown', 'the', 'my', 'yes', "i'm", 'here', 'still', 'add', 'minutes',
];
/** 2.5.4: doing what a gesture did (moving through content, undoing). */
export const GESTURE_VOCAB: readonly string[] = [
  'next', 'previous', 'prev', 'back', 'forward', 'undo', 'redo', 'shuffle', 'random', 'rotate', 'left', 'right', 'up', 'down', 'slide', 'item',
  'page', 'the', '‹', '›', '«', '»', '←', '→', '↑', '↓',
  // Stepping a value, as tilting a slider does (2026-11-09): "Increase level", "Decrease value", "+", "−".
  'increase', 'decrease', 'value', 'level', 'raise', 'lower', 'plus', 'minus', '+', '−',
];
/** 2.5.4: words that name a motion response; a toggle named with one may be its off switch (`toggles`). */
export const MOTION_TOGGLE_WORDS: readonly string[] = [
  'motion', 'tilt', 'tilting', 'shake', 'shaking', 'gesture', 'gestures', 'sensor', 'sensors',
];
/** 2.5.4: turning the response to motion off. */
export const MOTION_OFF_VOCAB: readonly string[] = [
  'motion', 'tilt', 'tilting', 'shake', 'shaking', 'gestures', 'sensor', 'sensors', 'off', 'on', 'turn', 'toggle', 'disable', 'the', 'all',
];
