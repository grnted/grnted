// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The in-page half of the forms probe (src/probes/forms.ts). `installFormsAgent` runs inside the
// page and must stay self-contained (no imports, no module-level helpers): it is serialized by
// `page.evaluate`. It finds the forms, keeps element references between calls, changes controls,
// fills fields, submits forms and observes what the page does. Engine core: no Node-only imports.
//
// Safety (Plan 4 rule 1), on top of the request guard (which runs in strict mode for both form
// probes, see `PageProbe.sendsNothing`):
// - The read-only part (`scan`, `paste`) changes nothing it does not put back and records nothing.
// - Once `record` is called (the interaction probe only), `HTMLFormElement.prototype.submit` is
//   recorded and never runs, `requestSubmit` checks the fields and fires the submit event but never
//   sends, `window.open` is recorded and opens nothing, and `fetch`,
//   XMLHttpRequest and `navigator.sendBeacon` are recorded and send nothing, GET requests included,
//   for as long as the page lives.
// - It only clicks buttons inside the form under test.

/** Caps on what one page's scan returns. */
export interface FormsAgentCaps {
  maxForms: number;
  maxFields: number;
  /** `LIVE_REGION_SELECTOR` (src/probes/liveRegion.ts): one definition with the controls kit. */
  live?: string;
}

export interface ScannedField {
  /** Page-wide reference, valid while the agent is installed. */
  ref: number;
  /** Index into `ScannedPage.forms`; the last entry holds the fields outside any form. */
  form: number;
  tag: 'input' | 'select' | 'textarea';
  /** Input type, or 'select', 'select-multiple', 'textarea'. */
  type: string;
  name: string;
  id: string;
  /** Accessible name without the placeholder ('' when it has none). */
  label: string;
  /** Legend of the fieldset or name of the group around a radio button or checkbox. */
  legend: string;
  placeholder: string;
  /** The attribute as written; null when absent. */
  autocomplete: string | null;
  required: boolean;
  pattern: string;
  title: string;
  minLength: number;
  maxLength: number;
  min: string;
  max: string;
  inputMode: string;
  /** Shown now; false when it sits in a hidden part of the form (a later step, a collapsed section). */
  shown: boolean;
  disabled: boolean;
  readOnly: boolean;
  /** Radio group name. */
  group: string;
  /** Text of its aria-describedby targets (max 200). */
  hint: string;
  /** aria-describedby or aria-errormessage points at an element that exists (a place for error text). */
  errorArea: boolean;
  /** A visible label names it: a shown <label> or aria-labelledby text (not a placeholder, aria-label or title). */
  visibleLabel: boolean;
  /** Visible text just before it (or just after, for a check box or radio button) that is not tied to it (max 80). */
  nearby: string;
  /**
   * Batch 18: visible text right after it in its container (max 120), for what the page says a change of the
   * field does ("opens the department's page"). Absent when none.
   */
  after?: string;
  /** Something visible says it is required: an asterisk or "required" in its label, nearby text or hint. */
  requiredMark: boolean;
  checked: boolean;
  /** Options of a select. */
  options: number;
  /**
   * Judged for 3.3.2: in sight now (not transparent, not entirely off the page, not cut away by a container
   * that clips it), or out of sight but in the Tab order or inside a region a collapsed disclosure shows
   * (a closed slide-in panel whose fields still take focus: judged as it looks when open). Absent: as `shown`.
   */
  seen?: boolean;
  /** It already holds a value people need not change (a prefilled date or time, a chosen option). */
  filled?: boolean;
  /**
   * A select that says what it is for by what it shows: a prompt option ("Select Language", an empty
   * value) or a list of languages (a language picker showing "English").
   */
  selfLabelled?: boolean;
  /** Removed from assistive technology (aria-hidden or inert on it or above it): an anti-spam decoy or a widget's own. */
  hiddenFromAll?: boolean;
  /**
   * Labelled by a Search button next to it (G167: a visible button, submit or link whose accessible name is
   * Search, in the field's container holding at most two text fields): for a field outside any form, where
   * the form's `search` cannot say so (2026-11-07 audit: thprd's header search). Its name alone says nothing.
   */
  search?: boolean;
  /** aria-disabled="true": announced as unavailable, but people can still focus and fill it in (ACT 73f2c2 leaves it out of 1.3.5 only). */
  ariaDisabled?: boolean;
  /**
   * No visible label, a name for screen readers, and its own button right beside or below it (`buttonLabelledOf`): the
   * button may label it (G167). An AI-review case: never failed nor exempted by rule (Sol round 3). Search fields are
   * `search`.
   */
  buttonLabelled?: boolean;
  /** Batch 18: the accessible name of that button (`buttonLabelled`), for the G167 word tiers. */
  buttonName?: string;
  /**
   * Batch 18: the field has no visible text of its own and sits in a run of fields that one visible text right
   * before the run introduces (a heading over two fields, "Phone" over three parts): the run's key (the same for every
   * field of the run, including the first, whose `nearby` is that text), whether that text is a heading, and the
   * number of fields in the run. Absent for a field alone after its text.
   */
  run?: { key: number; heading: boolean; size: number; text: string };
  /**
   * For a radio button whose group has two or more members in its form: the group has a visible question, a
   * legend or group label, or visible text right before the group's first member (max 80). '' when none.
   * Absent for other fields.
   */
  groupText?: string;
  /** For a radio button: the visible label texts of its group's members, in order (at most 8, max 40 each). */
  groupOptions?: string[];
}

export interface ScannedForm {
  index: number;
  /** 'loose': the fields outside any form, gathered in one group. */
  kind: 'form' | 'role' | 'loose';
  /** aria-label, legend or the heading above it ('' when none). */
  name: string;
  /** Text just before the form (max 300). */
  context: string;
  /** Precision fix: the text right before the form, the nearest 300 characters of it (absent when none). */
  lead?: string;
  /** Visible text inside the form: instructions, legal text, labels (max 800). */
  text: string;
  method: string;
  /** The explicit action, resolved; '' when the form has no action attribute. */
  action: string;
  /** The form's or its submit button's target ('' for the same window). */
  target: string;
  noValidate: boolean;
  /** A site search (role=search, or a GET form with one search-like field). */
  search: boolean;
  /**
   * Batch 19: a site search of one text field inside a search landmark (role="search" or a search element): its
   * purpose is exposed whatever the field shows. Absent otherwise.
   */
  searchLandmark?: true;
  /** Refs of its fields (capped). */
  fields: number[];
  /** Fields before the cap. */
  fieldCount: number;
  /** The button the probe would press to submit; null when none. */
  submitter: { ref: number; label: string; kind: 'submit' | 'button' } | null;
  buttons: string[];
  /** A visible "Next"/"Continue" button while some of the form's fields are hidden. */
  next: { ref: number; label: string } | null;
  /** Fields of the form that are hidden now. */
  hiddenFields: number;
  captcha: { kind: 'widget' | 'puzzle' | 'text' | 'math'; provider: string; detail: string }[];
  /** Its visible text says every field is required ("All fields are required"). */
  allRequired: boolean;
  /** A group of fields the page's plan named (src/probes/plan.ts), with the control that sends it. */
  planned?: true;
  /**
   * Batch 18 (3.3.4): a frame inside the form that takes card details for it (a payment provider's hosted field: its
   * title, name or address says card or payment).
   */
  cardFrame?: true;
  /** Batch 18 (3.3.4): its send button or the form asks for a confirmation inline (`data-confirm`, `return confirm(…)`). */
  confirmsInline?: true;
  /**
   * Fix round (3.3.4, Sol S4): evidence, never a verdict. The page holds a review or confirmation it has not shown yet
   * (a closed dialog, or a hidden box with a button, whose words say review, confirm, check or summary): its heading or
   * first words (max 80). A script may open it when the form is sent; the test never presses a pay button to see.
   */
  reviewHeld?: string;
}

export interface ScannedPage {
  forms: ScannedForm[];
  fields: ScannedField[];
  /** Forms on the page before the cap. */
  formCount: number;
  /** Visible links and buttons that offer another way to sign in ("Sign in with …", "Email me a link"). */
  altLogin: string[];
  /** Fields inside web components (open shadow roots), which the test does not reach. */
  shadowFields: number;
  /** Fields left out because of `maxFields`. */
  cappedFields: number;
}

export interface ActiveInfo {
  /** 'field' in the form under test, 'message' (an error text), 'body' (nothing), 'other'. */
  to: 'field' | 'message' | 'body' | 'other';
  ref: number;
  /** In which form the focused element is (-1 none). */
  form: number;
  label: string;
  /** Batch 18: the focused element is inside an open dialog (a dialog element or role dialog/alertdialog). */
  dialog?: true;
}

export interface ObserveResult {
  gone?: false;
  /** submit events since the last observe(), with the form they were for and whether the page stopped them. */
  submits: { form: number; prevented: boolean }[];
  /** form.submit() calls (recorded, never run), by form index. */
  protoSubmits: number[];
  /** window.open calls (recorded, nothing opened). */
  opens: number;
  /** fetch/XHR/beacon calls the shield stopped. */
  net: { api: string; method: string; url: string }[];
  url: string;
  active: ActiveInfo;
}

export interface CollectedMessage {
  text: string;
  /** How it appeared: inserted, revealed, its text changed, or in a live region outside the form's area. */
  kind: 'added' | 'shown' | 'text' | 'live';
  /** The nearest field of the form (-1 none). */
  near: number;
  /** Fields it is tied to (aria-describedby, aria-errormessage, label or aria-labelledby). */
  assoc: number[];
  /** Fields whose label it names. */
  names: number[];
  /** Fields it links to (`href="#id"` of the field or of an element around it: an error summary's links). */
  links?: number[];
  /** Inside, or holding, a live region or alert. */
  live: boolean;
  /** Has focus or holds the focused element. */
  focus: boolean;
  /**
   * Found outside the form's area by the words the caller asked for (`collect`'s `outside`): a toast or a
   * notice elsewhere on the page that the submit changed.
   */
  outside?: true;
  /** It holds headings, controls, lists or a table (or is a heading): a section of content, not a short message. */
  parts?: true;
  /** Inside the form element (review r1 F4). */
  inForm?: true;
  /** Scripts changed it while the submit's own events were dispatched (review r1 F3b). */
  direct?: true;
  /** It, or something around it of a message's size, also changed while no attempt was armed (review r1 F3b). */
  churned?: true;
  /** It is rendered through a shadow tree that holds a live region: announced or not cannot be told (review r1 F2). */
  unsure?: true;
  /**
   * A timer of 1 s or more that the page had set before the attempt was armed wrote it, in its own callback, while
   * the attempt was watched (the listener hook's `__grntedTimerWrote`): what the page keeps writing by itself (a
   * live arrival time, a clock, a rotating notice), never the form's answer (batch 17, 2026-11-12).
   */
  timer?: true;
}

export interface CollectResult {
  gone?: false;
  submits: { form: number; prevented: boolean }[];
  protoSubmits: number[];
  opens: number;
  net: { api: string; method: string; url: string }[];
  /** `invalid` events (constraint validation) with the browser's message; `prevented`: the page stopped the browser's own message. */
  invalid: { ref: number; message: string; prevented: boolean }[];
  /**
   * The page called `reportValidity()` (which shows the browser's messages). `invalid` events from
   * `checkValidity()` alone show nothing.
   */
  reported: boolean;
  /** The form is no longer in the page (removed, or the document was rewritten). */
  formGone: boolean;
  messages: CollectedMessage[];
  /**
   * Fields marked as wrong: aria-invalid, a colour or style change, an error class, an added icon. `kept`: the
   * mark was there before this submit (from an earlier one) and stayed, while the same submit took the marks of
   * other fields away: the page judged the fields again and still finds this one wrong.
   */
  /** `symbol`: the icon is a text symbol with no words ("*", "!"; batch 18, D9). */
  marks: { ref: number; aria: boolean; style: boolean; cls: boolean; icon: boolean; symbol?: true; kept?: true }[];
  /** Text of live regions and alerts that changed. */
  announcements: string[];
  /**
   * The armed form's fields: whether the words around each (`rowWords`) are those of the first attempt (`quiet`:
   * nothing shows about it that did not before), and those words (review r1 F1).
   */
  rows?: { ref: number; quiet: boolean; text: string }[];
  active: ActiveInfo;
  activeBefore: ActiveInfo;
  focusMoved: boolean;
}

/**
 * Installs the agent (once per document) and returns true. Call the agent with `callFormsAgent`.
 * Runs inside the page; self-contained.
 */
export function installFormsAgent(caps: FormsAgentCaps): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Any = any;
  const W = window as unknown as Record<string, Any>;
  if (W.__grntedForms) return true;
  // Batch 19 (precision lane): what the page announces through the accessibility API itself (`ariaNotify`, WCAG's
  // ARIA27; Understanding 4.1.3: "programmatically determinable ways ... including direct access to accessibility APIs
  // that result in assistive technology alerts/announcements"). Each call's text and time, from here on; the call
  // itself goes on as the page made it.
  const notified: { t: number; text: string }[] = (W.__grntedNotified ??= []);
  for (const proto of [typeof Document !== 'undefined' ? Document.prototype : null, typeof Element !== 'undefined' ? Element.prototype : null]) {
    const own = proto as unknown as Record<string, Any> | null;
    const orig = own?.ariaNotify;
    if (!own || typeof orig !== 'function' || orig.__grntedNotify) continue;
    const wrapped = function (this: unknown, ...a: Any[]) { if (notified.length < 200) notified.push({ t: performance.now(), text: String(a[0] ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) }); return orig.apply(this, a); };
    (wrapped as Any).__grntedNotify = true;
    try { Object.defineProperty(own, 'ariaNotify', { value: wrapped, configurable: true, writable: true }); } catch { /* left as it was */ }
  }

  /**
   * What changes on the page while no submit attempt is armed (a ticker, a clock, a rotating notice, a class or
   * `hidden` toggled by a script, and what the test's own typing changed), watched from the moment the agent is
   * installed, on the whole document (a page that swaps `body` is still watched). A message of a submit that
   * churned is not judged by the act-watch rules (review r1 F3b).
   */
  const churn = new Set<Element>();
  let churnKnown = false;
  let churnFull = false;
  try {
    new MutationObserver((records) => {
      if (armed) return;
      for (const r of records) {
        if (churn.size >= 3000) { churnFull = true; break; }
        const t = r.target.nodeType === 1 ? (r.target as Element) : r.target.parentElement;
        if (t && t !== document.body && t !== document.documentElement) churn.add(t);
        r.addedNodes.forEach((n) => { if (n.nodeType === 1) churn.add(n as Element); });
      }
    }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'open'] });
    churnKnown = true;
  } catch { /* not known: the act-watch rules judge nothing */ }

  const FIELD_SEL = 'input, select, textarea';
  const SKIP_TYPES = /^(hidden|submit|button|reset|image|file)$/i;
  // One live-region definition with the controls kit (`LIVE_REGION_SELECTOR`; act-watch review r1 F2: `output` too).
  const LIVE_SEL = caps.live || '[role="alert"], [role="status"], [role="log"], [aria-live="polite"], [aria-live="assertive"]';
  /**
   * Batch 18 (forms lane): one meaning of "announced" with the controls test. Text is announced when a live region
   * around it was in the page (live) when the attempt was armed (`liveAtArm`), or is an alert (an alert announces what
   * it is added with); never when it, or the region, is hidden from assistive technology (aria-hidden, inert). A
   * region created together with its text is not announced (screen readers hear changes to a region they already
   * know), and neither is `aria-live="off"` (not in `LIVE_SEL`). Without an armed attempt every region counts.
   */
  let liveAtArm: Set<Element> | null = null;
  /**
   * Fix round (Sol S9): live regions that appeared after the attempt was armed, by what they held when the page's own
   * task that added them ended (`noteBirths`, from the observer's records): created empty (a region the page then
   * fills in a later task, which screen readers may well announce: not known) or created with their text (not
   * announced: screen readers hear changes to a region they already know).
   */
  const bornEmpty = new Set<Element>();
  const bornFull = new Map<Element, string>();
  const noteBirths = (records: readonly MutationRecord[]): void => {
    if (!liveAtArm) return;
    for (const r of records) {
      r.addedNodes.forEach((n) => {
        if (n.nodeType !== 1) return;
        const el = n as Element;
        const regions = [...(el.matches(LIVE_SEL) ? [el] : []), ...Array.from(el.querySelectorAll(LIVE_SEL)).slice(0, 20)];
        for (const x of regions) {
          if (liveAtArm!.has(x) || bornEmpty.has(x) || bornFull.has(x)) continue;
          const t = (x.textContent ?? '').replace(/\s+/g, ' ').trim();
          if (t) bornFull.set(x, t);
          else bornEmpty.add(x);
        }
      });
    }
  };
  /** A region that says it is not live (`aria-live="off"` overrides a role's own politeness; Sol S18). */
  const liveOff = (r: Element): boolean => (r.getAttribute('aria-live') ?? '').trim().toLowerCase() === 'off';
  const announcedEl = (el: Element): boolean => {
    if (el.closest('[aria-hidden="true"], [inert]')) return false;
    const known = (r: Element) => !liveOff(r) && (!liveAtArm || liveAtArm.has(r) || (r.getAttribute('role') ?? '').trim().toLowerCase() === 'alert');
    for (let a: Element | null = el.closest(LIVE_SEL); a; a = a.parentElement ? a.parentElement.closest(LIVE_SEL) : null) if (known(a)) return true;
    const inner = Array.from(el.querySelectorAll(LIVE_SEL)).slice(0, 20);
    return inner.some((r) => known(r) && !r.closest('[aria-hidden="true"], [inert]'));
  };
  /**
   * Not known whether announced (Sol S9; the lead's ruling: a region not known at arm is unsure unless proven created
   * with its text): the text is in (or holds) a live region that appeared after arming, empty, and is not hidden or off.
   */
  const announceUnsure = (el: Element): boolean => {
    if (!liveAtArm || el.closest('[aria-hidden="true"], [inert]')) return false;
    // Created with its text and changed since (a region born with "Saving…" that then says "Saved"): not known either.
    const open = (r: Element) => !liveOff(r) && !liveAtArm!.has(r)
      && (!bornFull.has(r) || bornFull.get(r) !== (r.textContent ?? '').replace(/\s+/g, ' ').trim());
    for (let a: Element | null = el.closest(LIVE_SEL); a; a = a.parentElement ? a.parentElement.closest(LIVE_SEL) : null) if (open(a)) return true;
    return Array.from(el.querySelectorAll(LIVE_SEL)).slice(0, 20).some((r) => open(r) && !r.closest('[aria-hidden="true"], [inert]'));
  };
  const SUBMITISH = /\b(submit|send|sign ?up|register|log ?in|sign ?in|continue|next|apply|save|search|go|subscribe|request|book|join|enviar|registrar(se)?|entrar|iniciar sesi[oó]n|continuar|siguiente|guardar|buscar|suscribir(se)?)\b/i;
  const NEXT = /^\s*(next|continue|next step|siguiente|continuar|proceed|forward|go to step \d+)\b/i;
  const STEPISH = /\b(continue|next|proceed|save and continue|save & continue|review|step \d+|go to|start|begin|siguiente|continuar)\b/i;
  const SEARCH_NAMES = /^(q|s|query|search|searchterm|search_query|keywords?|k|term|terms|buscar|busqueda)$/i;
  const ALT_LOGIN = /\b((sign|log) ?in with|continue with|(email|send|text) me a (sign[- ]?in |log[- ]?in |magic |one[- ]time )?(link|code)|magic link|passkey|security key|inicia(r)? sesi[oó]n con|acceder con|contin[uú]a con)\b/i;
  const CAPTCHA_WIDGETS: [string, string, 'widget' | 'puzzle'][] = [
    ['reCAPTCHA', 'iframe[src*="recaptcha"], .g-recaptcha', 'widget'],
    ['hCaptcha', 'iframe[src*="hcaptcha.com"], .h-captcha', 'widget'],
    ['Cloudflare Turnstile', 'iframe[src*="challenges.cloudflare.com"], .cf-turnstile', 'widget'],
    ['Friendly Captcha', '.frc-captcha', 'widget'],
    ['Arkose Labs', 'iframe[src*="arkoselabs"], iframe[src*="funcaptcha"]', 'puzzle'],
    ['GeeTest', '[class*="geetest_"]', 'puzzle'],
  ];
  const CAPTCHA_INPUT = /captcha|enter the (characters|code|text|letters|word)|type the (characters|code|text|letters|word)|characters (you see|shown)|code (you see|shown)/i;
  const REQUIRED_MARK = /\*|\b(required|mandatory|obligatori[oa]s?|requerid[oa]s?|necesari[oa]s?)\b/i;
  const ALL_REQUIRED = /\b(all (the )?(fields|questions|boxes) (are )?(required|mandatory)|every (field|question) is required|todos los campos son (obligatorios|requeridos))\b/i;
  // A number as digits or as an English word up to twenty ("What is seventeen minus nine?", 2026-11-10).
  const NUM = '(?:\\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)';
  const MATH = new RegExp(`\\b(what is|what's|how much is|cu[aá]nto es|calcula|solve)\\s*:?\\s*${NUM}\\s*(\\+|-|x|×|\\*|plus|minus|times|m[aá]s|menos)\\s*${NUM}\\b|\\b\\d+\\s*(\\+|×|\\*)\\s*\\d+\\s*=\\s*\\??`, 'i');

  const clean = (s: unknown, n: number): string => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };
  const rectOf = (el: Element) => el.getBoundingClientRect();
  const cssVisible = (el: Element): boolean => {
    const e = el as Any;
    if (typeof e.checkVisibility === 'function') return e.checkVisibility({ checkVisibilityCSS: true });
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden';
  };
  /** Rendered with a box (an sr-only 1 px element counts). */
  const shown = (el: Element): boolean => {
    const r = rectOf(el);
    return r.width > 0 && r.height > 0 && cssVisible(el);
  };
  /** Text a sighted person can see: at least 2×2 px, not transparent. */
  const seen = (el: Element): boolean => {
    const r = rectOf(el);
    if (r.width < 2 || r.height < 2) return false;
    const e = el as Any;
    if (typeof e.checkVisibility === 'function') return e.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true });
    return cssVisible(el);
  };
  /**
   * The element whose box positions `el` (its containing block): for a fixed box the nearest ancestor that
   * makes one for it (a transform, filter, perspective, paint or layout containment), else null (the
   * viewport); for an absolute box the nearest positioned ancestor (or one of those); else the parent.
   */
  const containerOf = (el: Element): Element | null => {
    const pos = getComputedStyle(el).position;
    const makesFixedBlock = (st: CSSStyleDeclaration) =>
      st.transform !== 'none' || st.filter !== 'none' || st.perspective !== 'none' || /paint|layout|strict|content/.test(st.contain) || /transform|perspective|filter/.test(st.willChange);
    if (pos !== 'fixed' && pos !== 'absolute') return el.parentElement;
    for (let p = el.parentElement, depth = 0; p && depth < 60; p = p.parentElement, depth++) {
      const st = getComputedStyle(p);
      if (makesFixedBlock(st)) return p;
      if (pos === 'absolute' && st.position !== 'static') return p;
    }
    return null;
  };
  /**
   * Rendered but out of every sighted person's view: transparent, entirely off the page (where it
   * cannot be scrolled to), or cut away by a clipping container that shows none of it. A container clips
   * the field only when the field's chain of containing blocks goes through it (a fixed field inside a
   * 0-height `overflow: hidden` box escapes it), and only when the field's box lies outside the
   * container's box on a clipped axis.
   */
  const outOfSight = (el: Element): boolean => {
    const e = el as Any;
    if (typeof e.checkVisibility === 'function' && !e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return true;
    const r = rectOf(el);
    const sw = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0);
    if (r.right + window.scrollX <= 0 || r.bottom + window.scrollY <= 0 || r.left + window.scrollX >= sw) return true;
    // Only a container that hides its overflow cuts a field away: a scrolling one (auto, scroll; the page's own
    // root above all) lets people scroll to it (2026-11-07: albany's footer field below the first screen).
    const hides = (o: string) => o === 'hidden' || o === 'clip';
    const chain = new Set<Element>();
    for (let c: Element | null = el, n = 0; c && n < 60; c = containerOf(c), n++) chain.add(c);
    for (let p = el.parentElement, depth = 0; p && depth < 30; p = p.parentElement, depth++) {
      if (p === document.documentElement || p === document.body) break;
      if (!chain.has(p)) continue;
      const st = getComputedStyle(p);
      const hx = hides(st.overflowX);
      const hy = hides(st.overflowY);
      if (!hx && !hy) continue;
      const c = rectOf(p);
      if (hx && Math.min(r.right, c.right) - Math.max(r.left, c.left) < 1) return true;
      if (hy && Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top) < 1) return true;
    }
    return false;
  };
  const isField = (el: Element): boolean => {
    const t = el.tagName;
    if (t === 'SELECT' || t === 'TEXTAREA') return true;
    return t === 'INPUT' && !SKIP_TYPES.test((el as HTMLInputElement).type);
  };
  const fieldShown = (el: Element): boolean => {
    if (shown(el)) return true;
    const inp = el as HTMLInputElement;
    // Styled check boxes and radio buttons hide the input and show the label.
    if (inp.type === 'checkbox' || inp.type === 'radio') return Array.from(inp.labels ?? []).some((l) => shown(l));
    return false;
  };
  /**
   * Seen by nobody and reached by nobody, although it is rendered: an anti-spam trap field or a
   * widget's internal box (not a field anyone fills in). Hidden from sight (transparent, entirely off
   * the page, or cut away by a container that shows none of it) AND kept from the keyboard and
   * screen readers (aria-hidden, inert, or a negative tabindex). A field that is only out of sight
   * (a styled control under a custom look) or only aria-hidden (still on screen) stays a field. Not
   * rendered at all is `!shown` (a later step of the form), not a decoy.
   */
  const decoy = (el: Element): boolean => {
    if (!shown(el)) return false;
    const h = el as HTMLElement;
    const unreachable = !!el.closest('[aria-hidden="true"], [inert]') || (h.hasAttribute('tabindex') && h.tabIndex < 0);
    if (!unreachable) return false;
    const inp = el as HTMLInputElement;
    if ((inp.type === 'checkbox' || inp.type === 'radio') && Array.from(inp.labels ?? []).some(seen)) return false;
    return outOfSight(el);
  };
  /** In the Tab order: keyboard users reach it, so people meet it even while it is out of sight now. */
  const inTabOrder = (el: Element): boolean => (el as HTMLElement).tabIndex >= 0 && !el.matches(':disabled') && !el.closest('[inert]');
  /**
   * Inside a region that a collapsed disclosure on the page shows: the target of `aria-controls` on a
   * control with aria-expanded="false" (a slide-in panel opened by its tab). Closed <details> are opened
   * for the scan instead (`scan`'s `disclose`).
   */
  const disclosedBy = (el: Element): boolean => {
    const toggles = document.querySelectorAll('[aria-expanded="false"][aria-controls]');
    for (let i = 0; i < toggles.length && i < 200; i++) {
      for (const region of byIds(toggles[i]!.getAttribute('aria-controls'))) if (region.contains(el)) return true;
    }
    return false;
  };
  /**
   * Judged for 3.3.2 (`ScannedField.seen`): in sight now, or out of sight but in the Tab order (people reach
   * it: a closed slide-in panel whose fields still take focus) or inside a region a disclosure shows. A
   * styled check box or radio button by its label.
   */
  const fieldSeen = (el: Element): boolean => {
    if (!fieldShown(el)) return false;
    const inp = el as HTMLInputElement;
    if ((inp.type === 'checkbox' || inp.type === 'radio') && !shown(el)) return Array.from(inp.labels ?? []).some((l) => seen(l));
    return !outOfSight(el) || inTabOrder(el) || disclosedBy(el);
  };
  /**
   * Text that is seen as the field is: a field out of sight (a closed panel, judged as it looks when open)
   * has labels out of sight with it, so they count when they are rendered with a size, whatever their
   * opacity or place. A field in sight needs labels a sighted person sees (`seen`).
   */
  const seenWith = (f: Element): ((el: Element) => boolean) => {
    if (!outOfSight(f)) return seen;
    return (el: Element) => {
      const r = rectOf(el);
      return r.width >= 2 && r.height >= 2 && cssVisible(el);
    };
  };
  /**
   * A select's shown option says what to choose: a prompt ("Select Language", "-- Choose --", "Please
   * select"). "Pick up at Main Street" is a choice, not a prompt.
   */
  const PROMPT_OPTION = /^[\s\-–—*.:(]*(please |kindly )?(select|choose|pick(?![\s-]*up\b)|seleccion[ae]|elij[ae]|escoj[ae])\b/i;
  /** Language names (in English and in their own language) for a language picker: generic, every language. */
  const LANGUAGES = new Set(['english', 'spanish', 'español', 'french', 'français', 'german', 'deutsch', 'chinese', '中文', '简体中文', '繁體中文', 'chinese (simplified)', 'chinese (traditional)',
    'vietnamese', 'tiếng việt', 'russian', 'русский', 'korean', '한국어', 'japanese', '日本語', 'arabic', 'العربية', 'portuguese', 'português', 'italian', 'italiano',
    'ukrainian', 'українська', 'tagalog', 'filipino', 'hindi', 'हिन्दी', 'somali', 'soomaali', 'amharic', 'polish', 'polski', 'romanian', 'română', 'persian', 'فارسی',
    'farsi', 'dutch', 'nederlands', 'turkish', 'türkçe', 'greek', 'ελληνικά', 'hebrew', 'עברית', 'thai', 'ไทย', 'swahili', 'kiswahili', 'afrikaans', 'albanian', 'hmong',
    'khmer', 'lao', 'punjabi', 'urdu', 'bengali', 'gujarati', 'nepali', 'burmese', 'chuukese', 'marshallese', 'samoan', 'tongan', 'haitian creole', 'indonesian', 'malay']);
  /**
   * The text a select shows says what it is for: a prompt (`PROMPT_OPTION`), or it is a language picker on its
   * own (most options are language names, it shows a language, and it is in a search landmark or the only field
   * of its form or container). Its value (empty or not) and a disabled option say
   * nothing a sighted person sees: "California" with value "" is a state, not a label.
   */
  const selfLabelledSelect = (el: Element): boolean => {
    if (el.tagName !== 'SELECT') return false;
    const sel = el as HTMLSelectElement;
    const opt = sel.options[sel.selectedIndex];
    const shownText = clean(opt?.text, 120);
    if (!shownText) return false;
    if (PROMPT_OPTION.test(shownText)) return true;
    const names = Array.from(sel.options).map((o) => clean(o.text, 60).toLowerCase());
    const langs = names.filter((n) => LANGUAGES.has(n)).length;
    if (!(langs >= 3 && langs >= 0.5 * names.length && LANGUAGES.has(shownText.toLowerCase()))) return false;
    // A language list labels only a language picker on its own (Grok round 2): in a search landmark, or the one field
    // of its form (or of its container, outside any form). In a form with other fields it is a question still unnamed.
    if (el.closest('[role="search"], search')) return true;
    const form = sel.form ?? el.closest('form, [role="form"]');
    const fieldsIn = (root: Element) => Array.from(root.querySelectorAll(FIELD_SEL)).filter((x) => isField(x) && fieldShown(x)).length;
    if (form) return fieldsIn(form) === 1;
    for (let node = el.parentElement, depth = 0; node && depth < 3 && node !== document.body; node = node.parentElement, depth++) if (fieldsIn(node) > 1) return false;
    return true;
  };
  /** Types whose prefilled value is a real one the browser has checked: a date or time picked from its own control. */
  const PICKED_TYPES = /^(date|time|datetime-local|month|week)$/i;
  /** Types with their own constraint (`validity`) that a value can pass. */
  const CHECKED_TYPES = /^(number|email|url|range|color)$/i;
  /**
   * Already holds a value nobody has to supply: a prefilled date or time, a number, e-mail or URL value that
   * passes the field's own constraints, or a chosen option that is not a prompt. Text such as "MM/DD/YYYY"
   * in a text field is an example, not a value: the field still needs its required mark.
   */
  const filledNow = (el: Element): boolean => {
    if (el.tagName === 'SELECT') {
      const sel = el as HTMLSelectElement;
      const opt = sel.options[sel.selectedIndex];
      return !!opt && opt.value !== '' && !opt.disabled && !PROMPT_OPTION.test(clean(opt.text, 120));
    }
    if (el.tagName !== 'INPUT') return false;
    const inp = el as HTMLInputElement;
    if ((inp.value ?? '').trim() === '') return false;
    if (PICKED_TYPES.test(inp.type)) return true;
    return CHECKED_TYPES.test(inp.type) && !!inp.validity && inp.validity.valid;
  };
  /**
   * The accessible name of a control (aria-labelledby, aria-label, its text with image alt text, an input's
   * value or alt, its title), for a search button (`searchButtonOf`).
   */
  const controlName = (b: Element): string => {
    const lb = byIds(b.getAttribute('aria-labelledby'));
    if (lb.length) { const t = clean(lb.map((x) => x.textContent).join(' '), 80); if (t) return t; }
    const al = clean(b.getAttribute('aria-label'), 80);
    if (al) return al;
    if (b.tagName === 'INPUT') { const t = clean((b as HTMLInputElement).value || b.getAttribute('alt'), 80); if (t) return t; }
    const c = b.cloneNode(true) as Element;
    c.querySelectorAll('img[alt]').forEach((i) => i.replaceWith(document.createTextNode(` ${i.getAttribute('alt')} `)));
    const t = clean(c.textContent, 80);
    return t || clean(b.getAttribute('title'), 80);
  };
  /** A button that names a search (G167): its accessible name says Search (or Buscar), alone or first. */
  const SEARCH_BUTTON = /^[^a-z0-9áéíóúñ]*(search|buscar|b[uú]squeda)\b/i;
  const isText = (x: Element) => isField(x) && x.tagName !== 'SELECT' && !/^(checkbox|radio)$/i.test((x as HTMLInputElement).type);
  /** A visible, enabled control named Search (G167). */
  const searchNamed = (b: Element) => shown(b) && !outOfSight(b) && !(b as HTMLButtonElement).disabled && SEARCH_BUTTON.test(controlName(b));
  /**
   * A form's own visible action that is not a search (Send, Submit, Next): a contact form with a Search button
   * beside it is still a contact form, and the Search button labels none of its fields.
   */
  const otherAction = (btns: Element[]) => btns.some((b) => shown(b) && !outOfSight(b) && !(b as HTMLButtonElement).disabled &&
    SUBMITISH.test(controlName(b)) && !SEARCH_BUTTON.test(controlName(b)));
  /**
   * A hint that a field is the one a Search button labels (never enough on its own): type search, a search
   * name such as q, a search landmark around it, or the word in its label or placeholder.
   */
  const searchHint = (f: Element) => (f as HTMLInputElement).type === 'search' || SEARCH_NAMES.test((f as HTMLInputElement).name || '') ||
    !!f.closest('[role="search"], search') || /\b(search|buscar)\b/i.test(`${labelOf(f)} ${f.getAttribute('placeholder') ?? ''}`);
  /**
   * G167 (an adjacent button labels a field's purpose), for one field (`ScannedField.search`): a visible button,
   * submit or link whose accessible name is Search: in a form (or role=form group), one of the form's own
   * controls; outside any form, one in the field's container up to three levels up. The container may hold
   * at most two text fields: one alone is the field the button names; of two, only one with a search hint
   * (`searchHint`). "Go", an unnamed icon or a magnifier glyph says nothing, and a hint without the button
   * (a search landmark, a field named q) labels nothing.
   */
  const searchButtonOf = (f: Element): boolean => {
    if (!isText(f)) return false;
    const own = (texts: Element[]) => texts.length === 1 || (texts.length === 2 && searchHint(f));
    const form = (f as HTMLInputElement).form ?? f.closest('form, [role="form"]');
    if (form) {
      const texts = (form.tagName === 'FORM' ? Array.from((form as HTMLFormElement).elements) : Array.from(form.querySelectorAll(FIELD_SEL))).filter((x) => isText(x) && fieldShown(x));
      if (texts.length > 2 || !own(texts)) return false;
      if (otherAction(buttonsOf(form))) return false;
      return buttonsOf(form).some(searchNamed) || Array.from(form.querySelectorAll('a[href]')).slice(0, 20).some(searchNamed);
    }
    let node: Element | null = f.parentElement;
    for (let depth = 0; node && depth < 3; depth++, node = node.parentElement) {
      if (node === document.body || node === document.documentElement) break;
      const texts = Array.from(node.querySelectorAll('input, textarea')).filter((x) => isText(x) && fieldShown(x));
      if (texts.length > 2) break;
      const ctrls = Array.from(node.querySelectorAll('button, input[type="submit"], input[type="button"], input[type="image"], [role="button"], a[href]')).slice(0, 20);
      if (ctrls.some(searchNamed)) return own(texts);
    }
    return false;
  };
  const byIds = (ids: string | null): Element[] =>
    (ids ?? '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)).filter((x): x is HTMLElement => !!x);
  const textOf = (el: Element, n = 300) => clean((el as HTMLElement).innerText ?? el.textContent, n);
  /** A label's text without the fields inside it (a wrapping label holds a select's options). */
  const labelText = (l: Element): string => {
    const c = l.cloneNode(true) as Element;
    c.querySelectorAll('select, textarea, input, option, button, script, style').forEach((x) => x.remove());
    return clean(c.textContent, 200);
  };
  const labelOf = (f: Element): string => {
    const lb = byIds(f.getAttribute('aria-labelledby'));
    if (lb.length) {
      const t = clean(lb.map(labelText).join(' '), 200);
      if (t) return t;
    }
    const al = clean(f.getAttribute('aria-label'), 200);
    if (al) return al;
    const labels = Array.from((f as HTMLInputElement).labels ?? []);
    if (labels.length) {
      const t = clean(labels.map(labelText).join(' '), 200);
      if (t) return t;
    }
    return clean(f.getAttribute('title'), 200);
  };
  /** The shown legend (or aria-labelledby name) of the fieldset or group around a field. */
  const GROUP_SEL = 'fieldset, [role="radiogroup"], [role="group"]';
  /**
   * The group whose legend or name labels a field: the nearest fieldset, radio group or group around it that has one
   * (an unnamed role=group or wrapper in between is looked through, Sol round 1); else the nearest group.
   */
  const namedGroup = (f: Element): Element | null => {
    const first = f.closest(GROUP_SEL);
    for (let g: Element | null = first, i = 0; g && i < 6; g = g.parentElement ? g.parentElement.closest(GROUP_SEL) : null, i++) {
      if (g.tagName === 'FIELDSET' && g.querySelector(':scope > legend')) return g;
      if ((g.getAttribute('aria-label') ?? '').trim() || (g.getAttribute('aria-labelledby') ?? '').trim()) return g;
    }
    return first;
  };
  const groupLegends = (f: Element): Element[] => {
    const g = namedGroup(f);
    if (!g) return [];
    const lg = g.tagName === 'FIELDSET' ? g.querySelector(':scope > legend') : null;
    return (lg ? [lg] : byIds(g.getAttribute('aria-labelledby'))).filter(seen);
  };
  const legendOf = (f: Element): string => {
    const g = namedGroup(f);
    if (!g) return '';
    if (g.tagName === 'FIELDSET') {
      const lg = g.querySelector(':scope > legend');
      if (lg) return labelText(lg);
    }
    return clean(g.getAttribute('aria-label') || byIds(g.getAttribute('aria-labelledby')).map(labelText).join(' '), 200);
  };
  const buttonLabel = (b: Element): string => {
    const t = b.tagName === 'INPUT' ? (b as HTMLInputElement).value || (b as HTMLInputElement).alt : textOf(b, 80);
    return clean(t || b.getAttribute('aria-label') || b.getAttribute('title'), 80);
  };
  const isSubmitButton = (b: Element): boolean =>
    (b.tagName === 'BUTTON' && (b.getAttribute('type') || 'submit').toLowerCase() === 'submit') ||
    (b.tagName === 'INPUT' && /^(submit|image)$/i.test((b as HTMLInputElement).type));
  const setNative = (el: Element, v: string): void => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const d = Object.getOwnPropertyDescriptor(proto, 'value');
    if (d?.set) d.set.call(el, v);
    else (el as HTMLInputElement).value = v;
  };

  // --- State ------------------------------------------------------------------------------------
  const roots: (Element | null)[] = [];
  /** <details> the F111 check opened (`disclose`), closed again by `undisclose`. */
  const disclosed: HTMLDetailsElement[] = [];
  const formFields: number[][] = [];
  const fields: Element[] = [];
  const fieldForm: number[] = [];
  const buttons: Element[] = [];
  /** The planned groups' send controls (by form index): the only control such a group is ever sent with. */
  const plannedSubmit = new Map<number, Element>();
  const original: { value: string; checked: boolean; index: number }[] = [];

  // --- Recorders (installed for as long as the agent lives) ---------------------------------------
  const rec = {
    submits: [] as { form: Element | null; ev: Event }[],
    protoSubmits: [] as (Element | null)[],
    opens: 0,
    net: [] as { api: string; method: string; url: string }[],
    reported: 0,
    shield: false,
    recording: false,
    cursor: { submits: 0, protoSubmits: 0, opens: 0, net: 0 },
  };
  /** Elements whose content changed while no submit attempt was armed (`record` watches from its first call). */
  /**
   * Installs the recorders (once): from now on nothing the page sends with fetch, XMLHttpRequest or
   * sendBeacon leaves it, form.submit() and window.open do nothing, and submit events are recorded.
   */
  const record = (): boolean => {
    if (rec.recording) return true;
    rec.recording = true;
    rec.shield = true;
    window.addEventListener('submit', (e) => { rec.submits.push({ form: e.target as Element, ev: e }); }, true);
    for (const P of [HTMLFormElement, HTMLInputElement, HTMLSelectElement, HTMLTextAreaElement]) {
      try {
        const proto = P.prototype as unknown as { reportValidity: () => boolean };
        const orig = proto.reportValidity;
        Object.defineProperty(proto, 'reportValidity', {
          configurable: true, writable: true,
          value: function reportValidity(this: unknown) { rec.reported++; return orig.call(this); },
        });
      } catch { /* ignore */ }
    }
    try {
      const FP = HTMLFormElement.prototype;
      const origSubmit = FP.submit;
      Object.defineProperty(FP, 'submit', {
        configurable: true, writable: true,
        // Recorded, never run: a programmatic submit would send the form (the guard would stop it too).
        value: function submit(this: HTMLFormElement) { if (rec.protoSubmits.length < 100) rec.protoSubmits.push(this); void origSubmit; },
      });
    } catch { /* keep the page's own */ }
    try {
      // requestSubmit as the browser runs it, without the sending: check the fields (the browser shows
      // its messages), then fire the submit event; one no handler stops is recorded as a submit.
      Object.defineProperty(HTMLFormElement.prototype, 'requestSubmit', {
        configurable: true, writable: true,
        value: function requestSubmit(this: HTMLFormElement, submitter?: HTMLElement | null) {
          const skipChecks = this.noValidate || !!(submitter as HTMLButtonElement | null | undefined)?.formNoValidate;
          if (!skipChecks && !this.reportValidity()) return;
          let ev: Event;
          try {
            ev = new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: submitter ?? null });
          } catch {
            ev = new Event('submit', { bubbles: true, cancelable: true });
          }
          this.dispatchEvent(ev);
        },
      });
    } catch { /* the guard still stops what it would send */ }
    try {
      Object.defineProperty(window, 'open', { configurable: true, writable: true, value: function open() { rec.opens++; return null; } });
    } catch { /* the guard still closes popups */ }
    const netRecord = (api: string, method: string, url: string) => {
      if (rec.net.length < 100) rec.net.push({ api, method: String(method || 'GET').toUpperCase(), url: clean(url, 200) });
    };
    try {
      const origFetch = W.fetch;
      if (typeof origFetch === 'function') {
        W.fetch = function fetch(this: unknown, input: Any, init?: Any) {
          if (rec.shield) {
            netRecord('fetch', (init && init.method) || (input && input.method) || 'GET', String((input && input.url) || input));
            return Promise.reject(new TypeError('Failed to fetch'));
          }
          // eslint-disable-next-line prefer-rest-params
          return origFetch.apply(this, arguments as Any);
        };
      }
    } catch { /* ignore */ }
    try {
      const XP = XMLHttpRequest.prototype;
      const opened = new WeakMap<object, { method: string; url: string }>();
      const origOpen = XP.open;
      const origSend = XP.send;
      XP.open = function open(this: XMLHttpRequest, method: string, url: string | URL) {
        opened.set(this, { method, url: String(url) });
        // eslint-disable-next-line prefer-rest-params
        return (origOpen as Any).apply(this, arguments);
      } as Any;
      XP.send = function send(this: XMLHttpRequest) {
        if (rec.shield) {
          const o = opened.get(this);
          netRecord('xhr', o?.method ?? 'GET', o?.url ?? '');
          const x = this;
          setTimeout(() => {
            try { x.dispatchEvent(new ProgressEvent('error')); x.dispatchEvent(new ProgressEvent('loadend')); } catch { /* ignore */ }
          }, 0);
          return;
        }
        // eslint-disable-next-line prefer-rest-params
        return (origSend as Any).apply(this, arguments);
      };
    } catch { /* ignore */ }
    try {
      const nav = navigator as Any;
      const origBeacon = nav.sendBeacon;
      if (typeof origBeacon === 'function') {
        nav.sendBeacon = function sendBeacon(url: string) {
          if (rec.shield) { netRecord('beacon', 'POST', String(url)); return false; }
          // eslint-disable-next-line prefer-rest-params
          return origBeacon.apply(nav, arguments as Any);
        };
      }
    } catch { /* ignore */ }
    return true;
  };

  const formIndexOf = (el: Element | null): number => {
    if (!el) return -1;
    for (let i = 0; i < roots.length; i++) {
      const r = roots[i];
      if (r && (r === el || r.contains(el))) return i;
    }
    const f = (el as HTMLInputElement).form;
    return f ? roots.indexOf(f) : -1;
  };
  const sinceCursor = () => {
    const c = rec.cursor;
    const out = {
      // The listener hook cancels every trusted submit event (a form is never sent): whether the page
      // itself stopped it is what it kept (`__grntedSubmitStopped`).
      submits: rec.submits.slice(c.submits).map((s) => {
        const byPage = (window as unknown as { __grntedSubmitStopped?: (e: Event) => boolean | null }).__grntedSubmitStopped?.(s.ev);
        return { form: formIndexOf(s.form), prevented: typeof byPage === 'boolean' ? byPage : s.ev.defaultPrevented };
      }),
      protoSubmits: rec.protoSubmits.slice(c.protoSubmits).map(formIndexOf),
      opens: rec.opens - c.opens,
      net: rec.net.slice(c.net),
    };
    rec.cursor = { submits: rec.submits.length, protoSubmits: rec.protoSubmits.length, opens: rec.opens, net: rec.net.length };
    return out;
  };
  const describeActive = (formIndex: number, msgEls: Element[] = []): ActiveInfo => {
    const a = document.activeElement;
    if (!a || a === document.body || a === document.documentElement) return { to: 'body', ref: -1, form: -1, label: '' };
    const ref = fields.indexOf(a);
    const form = ref >= 0 ? (fieldForm[ref] ?? -1) : formIndexOf(a);
    // A field read again belongs to every read of its form (stable refs, fix round): in the form when that read lists it.
    if (ref >= 0 && (formIndex < 0 || form === formIndex || (formFields[formIndex] ?? []).includes(ref))) return { to: 'field', ref, form: formIndex < 0 ? form : formIndex, label: labelOf(a) };
    if (msgEls.some((m) => m === a || m.contains(a) || a.contains(m))) return { to: 'message', ref: -1, form, label: textOf(a, 80) };
    return { to: 'other', ref, form, label: clean(a.tagName.toLowerCase() + ' ' + textOf(a, 60), 80), ...(a.closest('dialog[open], [role="dialog"], [role="alertdialog"]') ? { dialog: true as const } : {}) };
  };

  // --- Scan --------------------------------------------------------------------------------------
  const nameOfForm = (root: Element): string => {
    const own = clean(root.getAttribute('aria-label'), 120) || clean(byIds(root.getAttribute('aria-labelledby')).map(labelText).join(' '), 120);
    if (own) return own;
    const inner = root.querySelector('legend, h1, h2, h3, h4, h5, h6, [role="heading"]');
    if (inner) return textOf(inner, 120);
    let node: Element | null = root;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      for (let s = node.previousElementSibling; s; s = s.previousElementSibling) {
        const h = s.matches('h1, h2, h3, h4, h5, h6, [role="heading"]') ? s : s.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]:last-of-type');
        if (h && shown(h)) return textOf(h, 120);
      }
    }
    return '';
  };
  /**
   * Precision fix: the text right before the form, the nearest kept (up to 300 characters, walking out of up to two
   * wrappers when the form is their first child): where an instruction about the whole form sits. `contextOf` keeps the
   * earliest text when it is long, which can cut the sentence just before the form.
   */
  const leadOf = (root: Element): string => {
    const parts: string[] = [];
    let len = 0;
    let node: Element | null = root;
    for (let up = 0; node && up < 3 && len < 300; up++) {
      for (let s = node.previousElementSibling; s && len < 300; s = s.previousElementSibling) {
        if (!shown(s) || s.matches('script, style, template, noscript')) continue;
        if (s.querySelector(FIELD_SEL)) { len = 300; break; }
        const t = textOf(s, 300);
        if (t) { parts.unshift(t); len += t.length; }
      }
      node = node.parentElement;
      if (!node || node.matches('body, main, [role="main"]')) break;
    }
    const all = clean(parts.join(' '), 2000);
    return all.length > 300 ? all.slice(all.length - 300) : all;
  };
  const contextOf = (root: Element): string => {
    const parts: string[] = [];
    let len = 0;
    for (let s = root.previousElementSibling; s && len < 300; s = s.previousElementSibling) {
      if (!shown(s)) continue;
      const t = textOf(s, 300);
      if (t) { parts.unshift(t); len += t.length; }
    }
    return clean(parts.join(' '), 300);
  };
  const visibleText = (root: Element, n: number): string => {
    const out: string[] = [];
    let len = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t && len < n; t = walker.nextNode()) {
      const p = t.parentElement;
      if (!p || p.closest('select, option, script, style, textarea, noscript, template')) continue;
      const s = (t.nodeValue ?? '').replace(/\s+/g, ' ').trim();
      if (!s || !shown(p)) continue;
      out.push(s);
      len += s.length + 1;
    }
    return clean(out.join(' '), n);
  };
  const buttonsOf = (root: Element): Element[] => {
    const list = Array.from(root.querySelectorAll('button, input[type="submit"], input[type="button"], input[type="image"], [role="button"]'));
    if (root.tagName === 'FORM' && root.id) {
      for (const b of Array.from(document.querySelectorAll(`[form="${CSS.escape(root.id)}"]`))) {
        if (b.matches('button, input[type="submit"], input[type="image"]') && !list.includes(b)) list.push(b);
      }
    }
    return list.filter((b) => shown(b) && !(b as HTMLButtonElement).disabled);
  };
  const captchaOf = (root: Element, rootFields: Element[]): ScannedForm['captcha'] => {
    const out: ScannedForm['captcha'] = [];
    const scope = [root, root.parentElement].filter((x): x is Element => !!x);
    for (const [provider, sel, kind] of CAPTCHA_WIDGETS) {
      if (scope.some((s) => s.querySelector(sel))) out.push({ kind, provider, detail: provider });
    }
    const img = Array.from(root.querySelectorAll('img, canvas, svg')).find((el) =>
      /captcha/i.test([el.getAttribute('src'), el.getAttribute('alt'), el.id, el.getAttribute('class'), el.getAttribute('title'), el.getAttribute('name')].join(' ')) && shown(el));
    const input = rootFields.find((f) => fieldShown(f) && CAPTCHA_INPUT.test([(f as HTMLInputElement).name, f.id, labelOf(f), f.getAttribute('placeholder')].join(' ')));
    if (input) {
      const what = labelOf(input) || f2(input);
      out.push({ kind: 'text', provider: '', detail: clean(img ? `an image of characters to copy into "${what}"` : `a field asking to type characters: "${what}"`, 160) });
    } else if (img && !out.length) {
      out.push({ kind: 'text', provider: '', detail: 'an image of characters to copy' });
    }
    const text = visibleText(root, 2000);
    const m = MATH.exec(text);
    if (m && rootFields.some((f) => fieldShown(f) && (f as HTMLInputElement).type !== 'password')) out.push({ kind: 'math', provider: '', detail: clean(`a sum to solve: "${m[0]}"`, 120) });
    return out;
  };
  const f2 = (f: Element) => clean((f as HTMLInputElement).name || f.id || f.getAttribute('placeholder'), 60);
  /** A shown <label> or aria-labelledby element with text (WCAG 3.3.2: a label people can see). */
  const visibleLabelOf = (f: Element): boolean => {
    const named = [...byIds(f.getAttribute('aria-labelledby')), ...Array.from((f as HTMLInputElement).labels ?? [])];
    const see = seenWith(f);
    return named.some((l) => see(l) && !!labelText(l));
  };
  /**
   * Visible text right before the field in its container (a caption in a table cell, a span, plain
   * text), or right after it for a check box or radio button; stops at another field.
   */
  /** Text a stylesheet draws before or after an element (`content: "Email"` or `content: attr(data-label)`). */
  const pseudoText = (el: Element): string => {
    let out = '';
    for (const pseudo of ['::before', '::after']) {
      let c = '';
      try { c = getComputedStyle(el, pseudo).content || ''; } catch { c = ''; }
      if (!c || c === 'none' || c === 'normal') continue;
      const attr = /^attr\(([\w-]+)\)$/.exec(c.trim());
      if (attr) out += ` ${el.getAttribute(attr[1]!) ?? ''}`;
      else out += ` ${(c.match(/"((?:[^"\\]|\\.)*)"/g) ?? []).map((q) => q.slice(1, -1)).join(' ')}`;
    }
    return clean(out, 80);
  };
  const HEADING = 'h1, h2, h3, h4, h5, h6, [role="heading"]';
  /** A review or confirmation the page holds but has not shown (`ScannedForm.reviewHeld`), read once per scan. */
  const REVIEW_WORDS = /\b(review|confirm|confirmation|check (your|the|these)|verify|summary|are you sure|before (you|we) (pay|submit|send))\b/i;
  let reviewCache: string | null = null;
  const reviewHeldOf = (): string => {
    if (reviewCache !== null) return reviewCache;
    reviewCache = '';
    const boxes = Array.from(document.querySelectorAll('dialog:not([open]), [role="dialog"], [role="alertdialog"], [hidden], [aria-hidden="true"]')).slice(0, 60);
    for (const b of boxes) {
      if (seen(b) || !b.querySelector('button, [role="button"], input[type="submit"], input[type="button"]')) continue;
      const head = b.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"], legend');
      const words = clean((head ?? b).textContent, 80);
      if (words && REVIEW_WORDS.test(clean(b.textContent, 400))) { reviewCache = words; break; }
    }
    return reviewCache;
  };
  /** Runs of fields that one text introduces (`ScannedField.run`), by the text's element. */
  const runKeys = new Map<Element, number>();
  const runOf = (f: Element): ScannedField['run'] => {
    // The field's own container: walk back over the fields (and text without letters: "(", "-", "/") before it.
    const see = seenWith(f);
    let node: Element | null = f;
    for (let depth = 0; node && depth < 3; depth++) {
      let fieldsBefore = 0;
      for (let n: Node | null = node.previousSibling; n; n = n.previousSibling) {
        if (n.nodeType === 3) {
          const t = clean(n.nodeValue, 80);
          if (!t || !/[\p{L}\p{N}]/u.test(t)) continue;
          if (!fieldsBefore) return undefined;
          return mkRun(n.parentElement!, f, t, false);
        }
        if (n.nodeType !== 1) continue;
        const el = n as Element;
        if (el.matches('script, style, template, noscript, br')) continue;
        const holds = isField(el) ? [el] : Array.from(el.querySelectorAll(FIELD_SEL)).filter(isField);
        if (holds.length) {
          // A field with its own visible label ends the run.
          if (holds.some((x) => visibleLabelOf(x))) return undefined;
          fieldsBefore += holds.length;
          continue;
        }
        if (!see(el)) continue;
        const t = textOf(el, 80) || pseudoText(el);
        if (!t) continue;
        if (!fieldsBefore) {
          // The text right before this field: a run starts here only if more fields follow it with no text between.
          return mkRun(el, f, t, el.matches(HEADING) || !!el.querySelector(HEADING));
        }
        return mkRun(el, f, t, el.matches(HEADING) || !!el.querySelector(HEADING));
      }
      const parent: Element | null = node.parentElement;
      if (!parent || parent.matches('form, [role="form"], fieldset, body')) break;
      node = parent;
    }
    return undefined;
  };
  /** The run the text `head` introduces: the fields after it, up to the next visible text, in its container. */
  const mkRun = (head: Element, f: Element, text: string, heading: boolean): ScannedField['run'] => {
    const box = head.parentElement;
    if (!box) return undefined;
    const members: Element[] = [];
    let started = false;
    for (let n: Node | null = head.nextSibling; n && members.length < 12; n = n.nextSibling) {
      if (n.nodeType === 3) {
        const t = clean(n.nodeValue, 80);
        if (t && /[\p{L}]/u.test(t) && started) break;
        continue;
      }
      if (n.nodeType !== 1) continue;
      const el = n as Element;
      if (el.matches('script, style, template, noscript, br')) continue;
      const holds = isField(el) ? [el] : Array.from(el.querySelectorAll(FIELD_SEL)).filter(isField);
      if (holds.length) {
        // A field in a box with its own visible text (a label inside a wrapper) is not part of a run.
        if (!isField(el) && textOf(el, 80).replace(/[^\p{L}]/gu, '').length > 0 && !holds.some((x) => (x as HTMLInputElement).type === 'checkbox' || (x as HTMLInputElement).type === 'radio')) {
          const own = textOf(el, 200);
          const fieldText = holds.map((x) => (x as HTMLInputElement).value ?? '').join(' ');
          if (own.replace(fieldText, '').replace(/[^\p{L}]/gu, '').length > 0) break;
        }
        members.push(...holds.filter((x) => fieldShown(x)));
        started = true;
        continue;
      }
      if (fieldShown(el) && textOf(el, 80)) break;
    }
    if (members.length < 2 || !members.includes(f)) return undefined;
    if (!runKeys.has(head)) runKeys.set(head, runKeys.size + 1);
    return { key: runKeys.get(head)!, heading, size: members.length, text };
  };
  /** Visible text right after the field (its next siblings, up to two levels up), stopping at another field or button. */
  const afterOf = (f: Element): string => {
    const see = seenWith(f);
    let node: Element | null = f;
    for (let depth = 0; node && depth < 3; depth++) {
      for (let n: Node | null = node.nextSibling; n; n = n.nextSibling) {
        if (n.nodeType === 3) {
          const t = clean(n.nodeValue, 120);
          if (t && /[\p{L}]/u.test(t) && n.parentElement && see(n.parentElement)) return t;
          continue;
        }
        if (n.nodeType !== 1) continue;
        const el = n as Element;
        if (el.matches('script, style, template, noscript, br')) continue;
        if (isField(el) || el.matches('button, [role="button"], input') || el.querySelector(FIELD_SEL + ', button')) return '';
        // Another field's label ends it too (precision fix: the next row's "Street address" is not this field's note).
        if (el.matches('label, legend') || el.querySelector('label, legend')) return '';
        if (!see(el)) continue;
        const t = textOf(el, 120);
        if (t) return t;
      }
      const parent: Element | null = node.parentElement;
      if (!parent || parent.matches('form, [role="form"], fieldset, body')) break;
      node = parent;
    }
    return '';
  };
  const nearbyOf = (f: Element): { text: string; el: Element | null } => {
    const see = seenWith(f);
    const check = /^(checkbox|radio)$/i.test((f as HTMLInputElement).type);
    const look = (start: Node, dir: 'previousSibling' | 'nextSibling'): { text: string; el: Element | null } | null => {
      for (let n: Node | null = start[dir]; n; n = n[dir]) {
        if (n.nodeType === 3) {
          const t = clean(n.nodeValue, 80);
          if (t && n.parentElement && see(n.parentElement)) return { text: t, el: n.parentElement };
          continue;
        }
        if (n.nodeType !== 1) continue;
        const el = n as Element;
        if (el.matches('script, style, template, noscript')) continue;
        if (isField(el) || Array.from(el.querySelectorAll(FIELD_SEL)).some(isField)) return { text: '', el: null };
        if (!see(el)) continue;
        // Batch 18: text a stylesheet draws (`content:`) is seen text too (L-LB-17).
        const t = textOf(el, 80) || pseudoText(el);
        if (t) return { text: t, el };
      }
      return null;
    };
    let node: Element | null = f;
    for (let depth = 0; node && depth < 3; depth++) {
      const hit = look(node, check ? 'nextSibling' : 'previousSibling');
      if (hit) return hit;
      const parent: Element | null = node.parentElement;
      if (!parent || parent.matches('form, [role="form"], fieldset, body')) break;
      node = parent;
    }
    return { text: '', el: null };
  };
  /**
   * G167 never decides a score (lead's ruling, Sol round 3): a field with no visible label whose own button sits next to
   * it may be labelled by that button (G167), or not; only judgement can tell. `ScannedField.buttonLabelled` marks such a
   * field as an AI-review case: it is neither failed nor exempted by rule. Its own button: a button associated with the
   * field's form (its `elements`, which follows the `form` attribute), or outside any form one in its container, right
   * beside the field (same row, at most 48 px away) or directly below it (at most 48 px). Any name. Search buttons are
   * `search`.
   */
  const ADJACENT_PX = 48;
  const BUTTONISH = 'button, input[type="submit"], input[type="button"], input[type="image"], input[type="reset"], [role="button"]';
  const buttonLabelledOf = (f: Element): boolean => !!buttonNextTo(f);
  /** The button beside or below the field that may label it (G167), or null. */
  const buttonNextTo = (f: Element): Element | null => {
    if (!labelOf(f)) return null;
    const form = (f as HTMLInputElement).form;
    let btns: Element[];
    if (form) {
      btns = Array.from(form.elements).filter((x) => x.matches(BUTTONISH)).slice(0, 20);
    } else {
      let scope: Element | null = f.closest('[role="form"]') ?? f.parentElement;
      for (let d = 0; scope && d < 2 && !scope.querySelector(BUTTONISH); d++) scope = scope.parentElement;
      if (!scope || scope === document.body) return null;
      btns = Array.from(scope.querySelectorAll(BUTTONISH)).filter((x) => !(x as HTMLButtonElement).form).slice(0, 20);
    }
    const fr = f.getBoundingClientRect();
    return btns.find((n) => {
      if (!shown(n) || outOfSight(n) || (n as HTMLButtonElement).disabled) return false;
      const r = n.getBoundingClientRect();
      const rowOverlap = Math.min(fr.bottom, r.bottom) - Math.max(fr.top, r.top);
      const sameRow = rowOverlap >= 0.5 * Math.min(fr.height, r.height) && (r.left - fr.right <= ADJACENT_PX && fr.left - r.right <= ADJACENT_PX);
      const below = r.top >= fr.bottom - 1 && r.top - fr.bottom <= ADJACENT_PX && Math.min(fr.right, r.right) - Math.max(fr.left, r.left) > 0;
      return sameRow || below;
    }) ?? null;
  };
  /** Radio groups already read in this scan (`groupTextOf`), by form and name. */
  const groupCache = new Map<string, { text: string; options: string[] } | undefined>();
  /**
   * For a radio button: the visible text that asks its group's question, or '' when there is none: a shown legend
   * or group label (`legendOf`), else visible text right before the group's first member (skipping the members'
   * own labels), up to three levels up, stopping at another field.
   */
  const groupTextOf = (f: Element): { text: string; options: string[] } | undefined => {
    const inp = f as HTMLInputElement;
    if (inp.type !== 'radio' || !inp.name) return undefined;
    const scope: ParentNode = inp.form ?? f.closest('form, [role="form"]') ?? document;
    const formKey = scope === document ? -1 : roots.indexOf(scope as Element);
    const key = `${formKey}\u0000${inp.name}`;
    if (groupCache.has(key)) return groupCache.get(key);
    const result = readGroup(f, scope);
    groupCache.set(key, result);
    return result;
  };
  /** One radio group's question and options (`groupTextOf`); at most 50 same-name members are looked at. */
  const readGroup = (f: Element, scope: ParentNode): { text: string; options: string[] } | undefined => {
    const inp = f as HTMLInputElement;
    const named = Array.from(scope.querySelectorAll('input[type="radio"]')).filter((x) => (x as HTMLInputElement).name === inp.name).slice(0, 50);
    const members = named.filter((x) => fieldShown(x));
    if (members.length < 2) return undefined;
    const options = members.slice(0, 8).map((m) => clean(Array.from((m as HTMLInputElement).labels ?? []).map(labelText).join(' ') || (nearbyOf(m).text), 40));
    const legend = groupLegends(f).map(labelText).join(' ').trim() || legendOf(f);
    if (legend) return { text: clean(legend, 80), options };
    const first = members[0]!;
    const own = new Set<Element>([...members, ...members.flatMap((m) => Array.from((m as HTMLInputElement).labels ?? []))]);
    const see = seenWith(first);
    let node: Element | null = first;
    for (let depth = 0; node && depth < 3; depth++) {
      for (let n: Node | null = node.previousSibling; n; n = n.previousSibling) {
        if (n.nodeType === 3) {
          const t = clean(n.nodeValue, 80);
          if (t && /[\p{L}\p{N}]/u.test(t) && n.parentElement && see(n.parentElement)) return { text: t, options };
          continue;
        }
        if (n.nodeType !== 1) continue;
        const el = n as Element;
        if (own.has(el) || el.matches('script, style, template, noscript, br')) continue;
        if (isField(el) || Array.from(el.querySelectorAll(FIELD_SEL)).some((x) => isField(x) && !own.has(x))) return { text: '', options };
        if (!see(el)) continue;
        const t = textOf(el, 80);
        if (t && /[\p{L}\p{N}]/u.test(t)) return { text: t, options };
      }
      const parent: Element | null = node.parentElement;
      if (!parent || parent.matches('form, [role="form"], body')) break;
      node = parent;
    }
    return { text: '', options };
  };
  /** An element whose text, alt text or ::before/::after content marks a field as required. */
  const marked = (el: Element): boolean => {
    if (REQUIRED_MARK.test(el.textContent ?? '')) return true;
    if (Array.from(el.querySelectorAll('[alt], [aria-label], [title]')).some((x) =>
      REQUIRED_MARK.test(`${x.getAttribute('alt') ?? ''} ${x.getAttribute('aria-label') ?? ''} ${x.getAttribute('title') ?? ''}`))) return true;
    for (const x of [el, ...Array.from(el.querySelectorAll('*')).slice(0, 20)]) {
      for (const pseudo of ['::before', '::after']) {
        const cs = getComputedStyle(x, pseudo);
        const c = cs.content;
        if (c && c !== 'none' && c !== 'normal' && REQUIRED_MARK.test(c)) return true;
        // Batch 18 (L-LB-08): a marker the stylesheet draws as a picture (an asterisk image or mask), of a visible size.
        const pic = (v: string | undefined) => !!v && v !== 'none' && /url\(|gradient\(/.test(v);
        const sized = (parseFloat(cs.width) || 0) >= 4 || (parseFloat(cs.height) || 0) >= 4 || (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) >= 4;
        if (c && c !== 'none' && c !== 'normal' && cs.display !== 'none' && sized
          && (pic(cs.backgroundImage) || pic(cs.maskImage) || pic((cs as CSSStyleDeclaration & { webkitMaskImage?: string }).webkitMaskImage))) return true;
      }
    }
    return false;
  };

  const pushButton = (b: Element) => { const r = buttons.indexOf(b); if (r >= 0) return r; buttons.push(b); return buttons.length - 1; };
  /** The button that submits the form as it is shown now: its submit button, else one whose text says so. */
  const submitterOf = (root: Element, btns: Element[]): ScannedForm['submitter'] => {
    const sub = root.tagName === 'FORM' ? btns.find(isSubmitButton) : undefined;
    if (sub) return { ref: pushButton(sub), label: buttonLabel(sub), kind: 'submit' };
    const alt = btns.find((b) => !isSubmitButton(b) && SUBMITISH.test(buttonLabel(b)));
    return alt ? { ref: pushButton(alt), label: buttonLabel(alt), kind: 'button' } : null;
  };

  /**
   * The page's forms. With `plannedOnly`, only the planned groups of fields (src/probes/plan.ts): an element
   * outside any form that holds fields, sent by the planned control inside it.
   */
  /**
   * The page's forms (`scanNow`). With `disclose`, closed <details> that hold fields are opened while it
   * looks (and closed again): what a disclosure shows is judged as it looks when shown (the read-only
   * form-fields test; the deep test, which types, leaves them as they are).
   */
  const scan = (a: { planned?: { root: string; submit: string }[]; plannedOnly?: boolean; disclose?: boolean } = {}): ScannedPage => {
    groupCache.clear();
    const opened: HTMLDetailsElement[] = [];
    if (a.disclose) {
      const closed = document.querySelectorAll('details:not([open])');
      for (let i = 0; i < closed.length && opened.length < 50; i++) {
        const d = closed[i] as HTMLDetailsElement;
        if (d.querySelector(FIELD_SEL)) { d.open = true; opened.push(d); }
      }
    }
    try {
      return scanNow(a);
    } finally {
      for (const d of opened) d.open = false;
    }
  };
  const scanNow = (a: { planned?: { root: string; submit: string }[]; plannedOnly?: boolean } = {}): ScannedPage => {
    const candidates = Array.from(document.querySelectorAll('form, [role="form"]')).filter((r) => !r.parentElement?.closest('form, [role="form"]'));
    const pageForms: ScannedForm[] = [];
    const out: ScannedField[] = [];
    let cappedFields = 0;
    const take = (root: Element | null, kind: ScannedForm['kind'], list: Element[]) => {
      const index = roots.length;
      roots.push(root);
      const refs: number[] = [];
      let hidden = 0;
      for (const f of list) {
        const isShown = fieldShown(f);
        if (!isShown) hidden++;
        if (!isShown && kind === 'loose') continue;
        // Fix round (Sol S11): a field read again (a later step, the phone-width read) keeps its ref and its values as
        // first scanned; the cap counts each field once, so a rescan never uses it up. Its form is the latest read's.
        const known = fields.indexOf(f);
        if (known < 0 && fields.length >= caps.maxFields) { cappedFields++; continue; }
        const ref = known >= 0 ? known : fields.length;
        const inp = f as HTMLInputElement;
        const tag = f.tagName.toLowerCase() as ScannedField['tag'];
        if (known < 0) {
          fields.push(f);
          original[ref] = { value: inp.value ?? '', checked: !!inp.checked, index: tag === 'select' ? (f as HTMLSelectElement).selectedIndex : -1 };
        }
        fieldForm[ref] = index;
        refs.push(ref);
        const described = [...byIds(f.getAttribute('aria-describedby')), ...byIds(f.getAttribute('aria-errormessage'))];
        const near = isShown ? nearbyOf(f) : { text: '', el: null };
        // The group's legend ("Name *" over First and Last name) marks every field in the group.
        const markEls = [...Array.from(inp.labels ?? []), ...byIds(f.getAttribute('aria-labelledby')), ...described, ...(near.el ? [near.el] : []), ...groupLegends(f)];
        out.push({
          ref, form: index, tag,
          type: tag === 'select' ? ((f as HTMLSelectElement).multiple ? 'select-multiple' : 'select') : tag === 'textarea' ? 'textarea' : (inp.type || 'text').toLowerCase(),
          name: clean(inp.name, 100), id: clean(f.id, 100), label: labelOf(f), legend: legendOf(f),
          placeholder: clean(f.getAttribute('placeholder'), 150), autocomplete: f.getAttribute('autocomplete'),
          required: !!inp.required || f.getAttribute('aria-required') === 'true',
          pattern: clean(f.getAttribute('pattern'), 100), title: clean(f.getAttribute('title'), 150),
          minLength: Number(f.getAttribute('minlength') ?? -1), maxLength: Number(f.getAttribute('maxlength') ?? -1),
          min: clean(f.getAttribute('min'), 40), max: clean(f.getAttribute('max'), 40), inputMode: clean(f.getAttribute('inputmode'), 20),
          // HTML's disabled state (its own, a disabled fieldset's, inert): nobody can fill it in. aria-disabled only says so (`ariaDisabled`).
          shown: isShown, disabled: f.matches(':disabled') || !!f.closest('[inert]'), ariaDisabled: f.getAttribute('aria-disabled') === 'true', readOnly: !!inp.readOnly, group: inp.type === 'radio' ? clean(inp.name, 100) : '',
          hint: clean(described.map((d) => d.textContent).join(' '), 200), errorArea: described.length > 0,
          visibleLabel: isShown && visibleLabelOf(f), nearby: near.text,
          ...((): Partial<ScannedField> => { const t = isShown ? afterOf(f) : ''; return t ? { after: t } : {}; })(),
          requiredMark: REQUIRED_MARK.test(near.text) || markEls.some(marked),
          checked: !!inp.checked, options: tag === 'select' ? (f as HTMLSelectElement).options.length : 0,
          seen: isShown && fieldSeen(f), filled: filledNow(f), selfLabelled: selfLabelledSelect(f),
          hiddenFromAll: !!f.closest('[aria-hidden="true"], [inert]'),
          search: isShown && searchButtonOf(f),
          ...((): Partial<ScannedField> => {
            const b = isShown && !visibleLabelOf(f) ? buttonNextTo(f) : null;
            return b ? { buttonLabelled: true, buttonName: clean(controlName(b), 120) } : {};
          })(),
          ...((): Partial<ScannedField> => { const r = isShown ? runOf(f) : undefined; return r ? { run: r } : {}; })(),
          ...((): Partial<ScannedField> => { const g = isShown ? groupTextOf(f) : undefined; return g ? { groupText: g.text, groupOptions: g.options } : {}; })(),
        });
      }
      formFields[index] = refs;
      const btns = root ? buttonsOf(root) : [];
      const submitter = root ? submitterOf(root, btns) : null;
      let next: ScannedForm['next'] = null;
      if (root && hidden > 0) {
        // Batch 18 (V-RE-04): a step button is called anything ("Save and continue", "Review request", an arrow). A
        // Next-like name first; else a shown button that does not send the form and is no Back, reset, add, remove,
        // show or help control; else the form's own submit button (a page that shows the next step when it is sent).
        const label = (b: Element) => buttonLabel(b);
        const NOT_STEP = /\b(back|previous|prev|cancel|reset|clear|remove|delete|add|show|hide|help|close|print|search|atr[aá]s|anterior)\b/i;
        const n = btns.find((b) => NEXT.test(label(b)))
          ?? btns.find((b) => !isSubmitButton(b) && shown(b) && !NOT_STEP.test(label(b)) && (STEPISH.test(label(b)) || !label(b) || /[→›»]/.test(label(b))))
          ?? btns.find((b) => isSubmitButton(b) && shown(b) && !NOT_STEP.test(label(b)));
        if (n) next = { ref: pushButton(n), label: buttonLabel(n) };
      }
      const form = root as HTMLFormElement | null;
      const isForm = root?.tagName === 'FORM';
      const shownFields = list.filter(fieldShown);
      const textLike = shownFields.filter((f) => f.tagName !== 'SELECT' && !/^(checkbox|radio)$/i.test((f as HTMLInputElement).type));
      const method = isForm ? (form!.getAttribute('method') || 'get').toLowerCase() : '';
      const oneOrTwo = textLike.length >= 1 && textLike.length <= 2 && !shownFields.some((f) => (f as HTMLInputElement).type === 'password');
      // A search form: in a search landmark; or a GET form (or role=form group) of one or two text fields one of which
      // says search (type, a search name such as q, or the word in its label or placeholder); or any form of one or two
      // text fields next to a button named Search (G167, `searchButtonOf`: a site search posted to the server) and
      // no action of its own that is not a search (a contact form's Send).
      const search = !!root && (
        !!root.closest('[role="search"], search') ||
        (oneOrTwo && (method === 'get' || !isForm) &&
          textLike.some((f) => (f as HTMLInputElement).type === 'search' || SEARCH_NAMES.test((f as HTMLInputElement).name || '') ||
            /\b(search|buscar)\b/i.test(`${labelOf(f)} ${f.getAttribute('placeholder') ?? ''}`))) ||
        (oneOrTwo && !otherAction(btns) && (textLike.some(searchButtonOf) || btns.some((b) => !outOfSight(b) && SEARCH_BUTTON.test(controlName(b))))));
      const subEl = submitter ? buttons[submitter.ref] : undefined;
      pageForms.push({
        index, kind,
        name: root ? nameOfForm(root) : '',
        context: root ? contextOf(root) : '',
        ...((): Partial<ScannedForm> => { const t = root ? leadOf(root) : ''; return t ? { lead: t } : {}; })(),
        text: root ? visibleText(root, 800) : '',
        method,
        action: isForm && form!.hasAttribute('action') ? clean(form!.action, 300) : '',
        target: clean((subEl as HTMLButtonElement | undefined)?.getAttribute?.('formtarget') || (isForm ? form!.target : ''), 60),
        noValidate: isForm ? form!.noValidate : true,
        search,
        ...(search && textLike.length === 1 && !!root!.closest('[role="search"], search') ? { searchLandmark: true as const } : {}),
        fields: refs,
        fieldCount: list.length,
        submitter,
        buttons: btns.map(buttonLabel).filter(Boolean).slice(0, 12),
        next,
        hiddenFields: hidden,
        captcha: root ? captchaOf(root, list) : [],
        allRequired: !!root && ALL_REQUIRED.test(visibleText(root, 2000)),
        ...(root && Array.from(root.querySelectorAll('iframe')).some((fr) => /\b(card|payment|pay|checkout|cvc|cvv)\b|stripe|braintree|adyen|square|paypal|authorize\.net/i.test(`${fr.getAttribute('title') ?? ''} ${fr.getAttribute('name') ?? ''} ${fr.getAttribute('src') ?? ''}`)) ? { cardFrame: true as const } : {}),
        ...((): Partial<ScannedForm> => { const r = root ? reviewHeldOf() : ''; return r ? { reviewHeld: r } : {}; })(),
        ...((subEl && (subEl.matches('[data-confirm], [data-confirm-message], [data-turbo-confirm]') || /\bconfirm\s*\(/.test(subEl.getAttribute('onclick') ?? ''))) || (isForm && /\bconfirm\s*\(/.test(form!.getAttribute('onsubmit') ?? '')) ? { confirmsInline: true as const } : {}),
      });
    };
    if (a.plannedOnly) {
      const q = (sel: string): Element | null => { try { return document.querySelector(sel); } catch { return null; } };
      for (const p of (a.planned ?? []).slice(0, caps.maxForms)) {
        const root = q(p.root);
        const sub = q(p.submit);
        if (!root || !sub || !root.contains(sub) || root.closest('form, [role="form"]') || roots.includes(root) || !shown(sub)) continue;
        const list = Array.from(root.querySelectorAll(FIELD_SEL)).filter((f) => isField(f) && !(f as HTMLInputElement).form && !decoy(f));
        if (!list.some(fieldShown)) continue;
        take(root, 'role', list);
        const form = pageForms[pageForms.length - 1]!;
        // Sent with the planned control only (never another submit-like button in the group: a "Search" or
        // "Subscribe" next to it would send something else).
        form.submitter = { ref: pushButton(sub), label: buttonLabel(sub), kind: 'button' };
        form.planned = true;
        plannedSubmit.set(form.index, sub);
      }
      return { forms: pageForms, fields: out, formCount: pageForms.length, altLogin: [], shadowFields: 0, cappedFields };
    }
    let count = 0;
    for (const root of candidates) {
      const list = (root.tagName === 'FORM'
        ? Array.from((root as HTMLFormElement).elements).filter(isField)
        : Array.from(root.querySelectorAll(FIELD_SEL)).filter(isField)).filter((f) => !decoy(f));
      if (!list.length) continue;
      count++;
      if (pageForms.length >= caps.maxForms) continue;
      take(root, root.tagName === 'FORM' ? 'form' : 'role', list);
    }
    const loose = Array.from(document.querySelectorAll(FIELD_SEL)).filter((f) =>
      isField(f) && !(f as HTMLInputElement).form && !f.closest('form, [role="form"]') && fieldShown(f) && !decoy(f));
    if (loose.length) take(null, 'loose', loose);
    const altLogin = Array.from(document.querySelectorAll('a[href], button, [role="button"], input[type="submit"], input[type="button"]'))
      .filter((b) => shown(b) && ALT_LOGIN.test(buttonLabel(b)))
      .map(buttonLabel).slice(0, 5);
    let shadowFields = 0;
    const all = document.getElementsByTagName('*');
    for (let i = 0; i < all.length && i < 5000; i++) {
      const root = (all[i] as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (root) shadowFields += Array.from(root.querySelectorAll(FIELD_SEL)).filter(isField).length;
    }
    return { forms: pageForms, fields: out, formCount: count + (loose.length ? 1 : 0), altLogin, shadowFields, cappedFields };
  };

  // --- Interaction -------------------------------------------------------------------------------
  const observe = (a: { form?: number }): ObserveResult => ({ ...sinceCursor(), url: location.href, active: describeActive(a.form ?? -1) });

  const focusField = (a: { ref: number; clear?: boolean }): boolean => {
    const f = fields[a.ref] as HTMLInputElement | undefined;
    if (!f || !f.isConnected) return false;
    if (a.clear) setNative(f, '');
    f.focus();
    return document.activeElement === f;
  };
  const blurField = (a: { ref: number }): boolean => {
    const f = fields[a.ref] as HTMLElement | undefined;
    if (!f || !f.isConnected) return false;
    f.blur();
    return true;
  };
  /** Changes a select, radio button or check box the way a person would (one step). */
  /** Batch 18: what the page's scripts changed while a change was dispatched (an armed attempt's `direct`), taken at once. */
  const recordDirect = (): void => {
    const A = armed;
    if (!A) return;
    try {
      const recs = A.observer.takeRecords();
      noteBirths(recs);
      for (const r of recs) {
        A.mutated.add(r.target);
        A.direct.add(r.target);
        r.addedNodes.forEach((n) => { A.mutated.add(n); A.direct.add(n); });
      }
    } catch { /* ignore */ }
  };
  const change = (a: { ref: number }): { ok: boolean; to: string } => {
    try { return changeNow(a); } finally {
      recordDirect();
      // What the test's own choice wrote into what describes a field ("30 days" becomes "90 days" for another permit
      // type) is that field's content, not an answer to a later attempt (fix round, Sol S7: `collect` takes text that
      // was not there when the form was first tried, in an element that describes a field, as a message).
      const form = fieldForm[a.ref];
      for (const ref of typeof form === 'number' ? (formFields[form] ?? []) : []) {
        const p = pristineWords.get(ref);
        const f = fields[ref];
        if (!p || !f || !f.isConnected) continue;
        const now = wordsOf(f);
        if (now.desc && !p.desc.includes(now.desc)) p.desc = `${p.desc} | ${now.desc}`;
      }
    }
  };
  const changeNow = (a: { ref: number }): { ok: boolean; to: string } => {
    const f = fields[a.ref];
    if (!f || !f.isConnected) return { ok: false, to: '' };
    if (f.tagName === 'SELECT') {
      const s = f as HTMLSelectElement;
      const opts = Array.from(s.options);
      const start = s.selectedIndex;
      for (let step = 1; step < opts.length; step++) {
        const i = (start + step) % opts.length;
        const o = opts[i]!;
        if (o.disabled || o.value === s.value) continue;
        s.selectedIndex = i;
        s.dispatchEvent(new Event('input', { bubbles: true }));
        s.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, to: clean(o.text, 60) };
      }
      return { ok: false, to: '' };
    }
    const inp = f as HTMLInputElement;
    if (inp.type === 'radio') {
      const group = inp.name
        ? Array.from((inp.form ?? document).querySelectorAll(`input[type="radio"][name="${CSS.escape(inp.name)}"]`)) as HTMLInputElement[]
        : [inp];
      const pick = group.find((r) => !r.checked && !r.disabled && fieldShown(r));
      if (!pick) return { ok: false, to: '' };
      pick.click();
      return { ok: true, to: labelOf(pick) };
    }
    if (inp.type === 'checkbox') {
      if (inp.disabled) return { ok: false, to: '' };
      inp.click();
      return { ok: true, to: inp.checked ? 'checked' : 'unchecked' };
    }
    return { ok: false, to: '' };
  };
  /** Puts the form's fields (or only `refs`) back as they were when scanned, without events. */
  const restore = (a: { form: number; refs?: number[] }): void => {
    for (const ref of a.refs ?? formFields[a.form] ?? []) {
      // The form's own refs, or the refs asked for (a read of the form after its steps): stable across reads.
      if (fieldForm[ref] !== a.form && !(formFields[a.form] ?? []).includes(ref) && !a.refs) continue;
      const f = fields[ref] as HTMLInputElement;
      const o = original[ref];
      if (!f || !o || !f.isConnected) continue;
      try {
        if (f.tagName === 'SELECT') (f as unknown as HTMLSelectElement).selectedIndex = o.index;
        else if (f.type === 'checkbox' || f.type === 'radio') f.checked = o.checked;
        else setNative(f, o.value);
      } catch { /* ignore */ }
    }
  };
  /** Fills fields quickly (value setter plus input, change and blur), the way frameworks expect. */
  const fill = (a: { values: { ref: number; value: string }[] }): number => {
    let n = 0;
    for (const { ref, value } of a.values) {
      const f = fields[ref] as HTMLInputElement | undefined;
      if (!f || !f.isConnected || f.disabled) continue;
      try {
        if (f.tagName === 'SELECT') {
          const s = f as unknown as HTMLSelectElement;
          // `FIRST_CHOICE`: a list that has nothing chosen yet gets its first real choice; one with a choice keeps it.
          if (value === 'grnted:first-choice' && s.value !== '') continue;
          const i = value === 'grnted:first-choice' ? Array.from(s.options).findIndex((o) => o.value !== '' && !o.disabled) : Array.from(s.options).findIndex((o) => o.value === value);
          if (i < 0) continue;
          s.selectedIndex = i;
          s.dispatchEvent(new Event('input', { bubbles: true }));
          s.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (f.type === 'checkbox' || f.type === 'radio') {
          if (!f.checked) f.click();
        } else {
          f.focus();
          setNative(f, value);
          f.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
          f.dispatchEvent(new Event('change', { bubbles: true }));
          f.blur();
        }
        n++;
      } catch { /* ignore */ }
    }
    return n;
  };
  const shield = (a: { on: boolean }): boolean => { rec.shield = a.on || rec.recording; return true; };
  const click = (a: { button: number }): boolean => {
    const b = buttons[a.button] as HTMLElement | undefined;
    if (!b || !b.isConnected) return false;
    b.focus();
    b.click();
    return true;
  };
  /**
   * Batch 18 (V-LB-08): whether the field still has visible text of its own (a seen label or text right before it).
   * When it has none, what else may label it, for the same judgement as the scan's (fix round, Sol S2): the button
   * beside it (G167, by its name) and whether one text introduces it with other fields (a run).
   */
  const labelSeen = (a: { ref: number }): { seen: boolean; button?: string; run?: true } | null => {
    const f = fields[a.ref];
    if (!f || !f.isConnected || !fieldShown(f)) return null;
    if (visibleLabelOf(f) || !!nearbyOf(f).text) return { seen: true };
    const b = buttonNextTo(f);
    return { seen: false, ...(b ? { button: clean(controlName(b), 120) } : {}), ...(runOf(f) ? { run: true as const } : {}) };
  };
  const shownFields = (a: { form: number }): { ref: number; value: string; checked: boolean }[] =>
    (formFields[a.form] ?? []).filter((ref) => fields[ref]?.isConnected && fieldShown(fields[ref]!)).map((ref) => {
      const f = fields[ref] as HTMLInputElement;
      return { ref, value: clean(f.value, 100), checked: !!f.checked };
    });
  /** The form's submit button as shown now (after its steps were followed). */
  const submitterNow = (a: { form: number }): ScannedForm['submitter'] => {
    const root = roots[a.form];
    if (!root || !root.isConnected) return null;
    // A planned group is sent with its planned control, after the steps too (never the first "Next",
    // "Search" or "Continue" that submitterOf would take); none once it is gone or hidden.
    const planned = plannedSubmit.get(a.form);
    if (planned) return planned.isConnected && shown(planned) ? { ref: pushButton(planned), label: buttonLabel(planned), kind: 'button' } : null;
    return submitterOf(root, buttonsOf(root));
  };
  /** A checkbox in the form's visible part whose label offers to copy earlier answers ("Same as above"). */
  const REUSE = /\b(same as|use (the )?(same|above|previous|my|saved|earlier)|copy (from|above|my)|fill (in )?from|as above|igual que|mismo|misma|usar (mi|el|la|los) )/i;
  const sameAsOffered = (a: { form: number; refs?: number[] }): string => {
    for (const ref of [...(formFields[a.form] ?? []), ...(a.refs ?? [])]) {
      const f = fields[ref] as HTMLInputElement;
      if (f?.type === 'checkbox' && fieldShown(f) && REUSE.test(labelOf(f))) return labelOf(f);
    }
    // Batch 18 (L-RE-10): a button or link in the shown part of the step that offers the earlier answers.
    const scope = new Set<Element>();
    for (const ref of a.refs ?? []) { const box = fields[ref]?.closest('form, [role="form"], fieldset, section, div'); if (box) scope.add(box); }
    if (roots[a.form]) scope.add(roots[a.form]!);
    for (const box of scope) {
      for (const b of Array.from(box.querySelectorAll('button, [role="button"], a[href^="#"], input[type="button"]')).slice(0, 60)) {
        if (!shown(b)) continue;
        const name = controlName(b);
        if (REUSE.test(name)) return clean(name, 80);
      }
    }
    return '';
  };

  /**
   * Where each earlier answer is on the page now (3.3.7: "available to select" means on the same page, and "it
   * could be elsewhere on a page, including within a show/hide component"). 'shown': a field or text that is seen
   * holds it. 'disclosure': it is inside something a control on the page shows (a closed details element, the
   * target of a seen control's aria-controls, the hidden block right after a seen button). 'maybe': it is not
   * there for the taking, but a control on the page may bring it back. 'none': a person cannot get at it
   * (it is gone from the page, or kept hidden) and no control that could bring it back is on the page.
   * 'unknown': a value too short to look for. `except`: the fields being judged; `next`: the button the test
   * pressed to get here.
   *
   * "No control could bring it back" is not a search for words (a Back button is called anything, in any
   * language). A possible way back is: any button in the judged step's own form beside the one that sends
   * it; a second sending button; any other button on the page outside its header and footer (step buttons
   * above a form, in a list or in a navigation of their own); a link that goes nowhere ("#"); a marker of the
   * current step or a tab list.
   */
  const whereValues = (a: { items: { ref: number; value: string }[]; except: number[]; next?: number }): string[] => {
    const except = new Set(a.except.map((r) => fields[r]).filter(Boolean));
    const seenEl = (el: Element): boolean => {
      const c = el as Element & { checkVisibility?: (o: object) => boolean };
      if (typeof c.checkVisibility === 'function' && !c.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return false;
      const r = el.getBoundingClientRect();
      return r.width >= 1 && r.height >= 1;
    };
    const controls = new Set(Array.from(document.querySelectorAll('button, summary, a[href], [role="button"], input[type="button"]')).slice(0, 3000).filter(seenEl));
    const controlled = new Set<Element>();
    let back = false;
    const BACK = /\b(?:back|previous|prev|edit|change|review|earlier|summary|your answers|atr[aá]s|anterior|volver|editar|revisar)\b/i;
    // Fix round (Sol S12, ruling Q1): a way back to the earlier step ("Back", "Previous") that names what it controls
    // replaces the current step; what it shows is not available at this step, so it discloses nothing.
    const STEP_BACK = /\b(?:back|previous|prev|go back|return|atr[aá]s|anterior|volver|regresar)\b/i;
    for (const c of controls) {
      const said = `${c.getAttribute('aria-label') ?? ''} ${(c.textContent ?? '').slice(0, 80)} ${(c as HTMLInputElement).value ?? ''}`;
      if (!STEP_BACK.test(said)) for (const id of (c.getAttribute('aria-controls') ?? '').split(/\s+/)) { const t = id ? document.getElementById(id) : null; if (t) controlled.add(t); }
      if (!back && BACK.test(said)) back = true;
    }
    /** Hidden, and a control on the page shows it. */
    const revealable = (el: Element): boolean => {
      for (let x: Element | null = el; x && x !== document.body; x = x.parentElement) {
        if (x.localName === 'details' && !(x as HTMLDetailsElement).open) return true;
        if (controlled.has(x)) return true;
        if (!seenEl(x) && x.previousElementSibling && controls.has(x.previousElementSibling)) return true;
      }
      return false;
    };
    // A way back the test cannot name: buttons of the judged step's form, and buttons anywhere outside the
    // page's header and footer.
    const first = [...except][0] as Element | undefined;
    const region = first?.closest('form, [role="form"]') ?? first?.closest('main, [role="main"]') ?? document.body;
    const pressed = typeof a.next === 'number' ? buttons[a.next] : undefined;
    const sends = (c: Element): boolean => c.matches('input[type="submit"], input[type="image"]') || (c.localName === 'button' && (c.getAttribute('type') ?? 'submit').toLowerCase() === 'submit' && !!c.closest('form'));
    // A link that goes nowhere a person can see by itself: "#", a script address, a fragment with no such place
    // on the page, or one whose place is not shown now (a hidden step: a script may show it).
    const idle = (c: Element): boolean => {
      const href = c.getAttribute('href') ?? '';
      if (/^javascript:/i.test(href) || href === '#') return true;
      if (!href.startsWith('#')) return false;
      let id = href.slice(1);
      try { id = decodeURIComponent(id); } catch { /* as written */ }
      const place = document.getElementById(id);
      return !place || !seenEl(place);
    };
    let senders = 0;
    const pressable = document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], input[type="image"], input[type="reset"], a[href^="#"], a[href^="javascript:"]');
    for (let k = 0; k < pressable.length && k < 3000 && !back; k++) {
      const c = pressable[k]!;
      if (c === pressed || !seenEl(c)) continue;
      if (c.localName === 'a' && !idle(c)) continue;
      const inside = !!region && region.contains(c);
      if (sends(c)) {
        if (inside && ++senders > 1) back = true;
        continue;
      }
      // The page's own header and footer hold its menus and search, never a form's steps (unless the form is in one).
      const chrome = c.closest('header, footer, [role="banner"], [role="contentinfo"]');
      if (inside || !chrome || (region && chrome.contains(region))) back = true;
    }
    if (!back && document.querySelector('[aria-current="step"], [role="tablist"]')) back = true;
    // Batch 18 (L-RE-04): an option of a shown select, or of a datalist a shown field offers, is there to choose.
    const offered = (el: Element): boolean => {
      const sel = el.closest('select');
      if (sel) return seenEl(sel);
      const dl = el.closest('datalist');
      if (dl && dl.id) return Array.from(document.querySelectorAll('input[list]')).some((i) => i.getAttribute('list') === dl.id && seenEl(i));
      return false;
    };
    const rankOf = (el: Element): number => (seenEl(el) || offered(el) ? 3 : revealable(el) ? 2 : 0);
    const NAMES = ['none', 'maybe', 'disclosure', 'shown'];
    // Batch 18 (ruling Q1): the earlier answer may come back with the current step still shown only through something
    // that discloses content (a closed details, a collapsed control); a way back to the earlier step (a Back button, a
    // step list) replaces the current step, which is not "available to select" at this step ('back').
    const laterBox = first?.closest('form, [role="form"], fieldset, section, [role="group"]') ?? null;
    // A disclosure whose target is known counts only when that target could hold an earlier answer (one of the earlier
    // fields, or text with an answer); one whose target is unknown might.
    const earlierEls = a.items.map((x) => fields[x.ref]).filter((x): x is Element => !!x);
    const values = a.items.map((x) => x.value.trim()).filter((v) => v.length >= 3);
    const toggles = Array.from(document.querySelectorAll('details:not([open]) > summary, [aria-expanded="false"]')).slice(0, 200)
      .some((c) => {
        if (!seenEl(c) || c.closest('header, footer, nav, [role="banner"], [role="contentinfo"], [role="navigation"]')) return false;
        const t = c.getAttribute('aria-controls');
        const target = t ? document.getElementById(t) : c.localName === 'summary' ? c.parentElement : null;
        if (!target) return true;
        if (laterBox && target.contains(laterBox)) return false;
        return earlierEls.some((e) => target.contains(e)) || values.some((v) => (target.textContent ?? '').includes(v));
      });
    const wanted = a.items.map((x) => x.value.trim());
    const ranks = wanted.map(() => 0);
    const live = (i: number) => wanted[i]!.length >= 3 && ranks[i]! < 3;
    // Fields anywhere in the document that hold the value (never a hidden input: nobody can read one).
    const all = document.querySelectorAll('input, textarea, select');
    for (let k = 0; k < all.length && k < 3000; k++) {
      const f = all[k] as HTMLInputElement;
      if (except.has(f) || f.type === 'hidden' || f.type === 'password') continue;
      const value = String(f.value ?? '');
      if (value.length < 3) continue;
      for (let i = 0; i < wanted.length; i++) if (live(i) && value.includes(wanted[i]!)) ranks[i] = Math.max(ranks[i]!, rankOf(f));
    }
    // Options whose value (not their text) holds it: a datalist's suggestions.
    const opts = document.querySelectorAll('option');
    for (let k = 0; k < opts.length && k < 3000; k++) {
      const o = opts[k] as HTMLOptionElement;
      for (let i = 0; i < wanted.length; i++) if (live(i) && (o.value ?? '').includes(wanted[i]!)) ranks[i] = Math.max(ranks[i]!, rankOf(o));
    }
    // Text anywhere in the document that holds it (text that is seen can be selected and copied).
    if (wanted.some((_, i) => live(i)) && document.body) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(), k = 0; n && k < 30000; n = walker.nextNode(), k++) {
        if ((n as Text).length < 3) continue;
        const data = (n as Text).length > 20000 ? (n as Text).substringData(0, 20000) : (n as Text).data;
        const parent = n.parentElement;
        if (!parent || parent.closest('script, style, noscript, template')) continue;
        for (let i = 0; i < wanted.length; i++) if (live(i) && data.includes(wanted[i]!)) ranks[i] = Math.max(ranks[i]!, rankOf(parent));
      }
    }
    // The page's text as it is shown, across element boundaries (review round 2, finding 1: an address shown as
    // "<span>name</span>@<span>host</span>" is on the page, to read, select and copy). Word for word (white space
    // as one space): shown. The same letters with other spacing or case (pieces on lines of their own, a style
    // that puts them in capitals): it may be there, so it is undecided, never "nowhere".
    const unsure = new Set<number>();
    if (wanted.some((_, i) => live(i)) && document.body) {
      let page = '';
      try { page = String((document.body as HTMLElement).innerText ?? '').slice(0, 400_000); } catch { page = ''; }
      const flat = page.replace(/\s+/g, ' ');
      const tight = flat.replace(/\s+/g, '').toLowerCase();
      for (let i = 0; i < wanted.length; i++) {
        if (!live(i)) continue;
        const v = wanted[i]!.replace(/\s+/g, ' ');
        if (flat.includes(v)) ranks[i] = 3;
        else if (tight.includes(v.replace(/\s+/g, '').toLowerCase())) unsure.add(i);
      }
    }
    return wanted.map((v, i) => (v.length < 3 ? 'unknown' : ranks[i] === 0 && (toggles || unsure.has(i)) ? 'maybe' : ranks[i] === 0 && back ? 'back' : NAMES[ranks[i]!]!));
  };

  // --- Steps that open anywhere on the page (batch 18, 3.3.7) ---------------------------------------
  /** The fields shown now, anywhere in the document (`markShown`), for telling what a press or a send revealed. */
  let shownMark: Set<Element> = new Set();
  const allFields = (): Element[] => Array.from(document.querySelectorAll(FIELD_SEL)).filter((f) => isField(f) && !decoy(f)).slice(0, 3000);
  const markShown = (): number => {
    shownMark = new Set(allFields().filter((f) => fieldShown(f)));
    return shownMark.size;
  };
  /**
   * The page read again (`scanNow`, new refs for every field) and the refs of the fields shown now that were not shown
   * at `markShown` (revealed or created since), with the text of the smallest box that holds them all (its headings,
   * legends and paragraphs, not the fields' own labels): the step's own words. Whether the fields marked then are still
   * shown (`markedShown`: the form that was sent went away, or stayed).
   */
  const freshScan = (a: { form?: number } = {}): { page: ScannedPage; fresh: number[]; values: string[]; stepText: string; markedShown: number } => {
    const page = scanNow({});
    const fresh = page.fields.filter((f) => f.shown && !shownMark.has(fields[f.ref]!)).map((f) => f.ref).slice(0, 30);
    const els = fresh.map((r) => fields[r]!).filter(Boolean);
    let box: Element | null = els[0]?.parentElement ?? null;
    while (box && !els.every((e) => box!.contains(e))) box = box.parentElement;
    // Up to the step's own box: a form, section, fieldset, group, dialog or article, or one that holds a heading.
    for (let up = 0; box && up < 4 && !box.matches('form, [role="form"], section, fieldset, [role="group"], dialog, [role="dialog"], article, main, body') && !box.querySelector('h1, h2, h3, h4, h5, h6, legend, [role="heading"]'); up++) box = box.parentElement;
    if (box && box.matches('form, [role="form"]') && box.parentElement && !box.parentElement.matches('body, main')) box = box.parentElement;
    let stepText = '';
    if (box) {
      const parts = Array.from(box.querySelectorAll('h1, h2, h3, h4, h5, h6, legend, p, [role="heading"]')).filter((x) => seen(x) && !x.closest('label') && !x.querySelector(FIELD_SEL)).slice(0, 8);
      stepText = clean(parts.map((x) => textOf(x, 200)).join(' | '), 400);
    }
    const markedShown = [...shownMark].filter((f) => f.isConnected && fieldShown(f)).length;
    void a;
    return { page, fresh, values: fresh.map((r) => clean((fields[r] as HTMLInputElement).value, 100)), stepText, markedShown };
  };

  // --- Paste (3.3.8) -----------------------------------------------------------------------------
  const paste = async (a: { ref: number; text: string }): Promise<{ blocked: boolean; via: string }> => {
    const f = fields[a.ref] as HTMLInputElement | undefined;
    if (!f || !f.isConnected) return { blocked: false, via: 'gone' };
    const group = (formFields[fieldForm[a.ref] ?? -1] ?? []).map((r) => fields[r] as HTMLInputElement).filter(Boolean);
    const values = () => group.map((g) => g.value).join('\u0000');
    const before = f.value;
    const beforeAll = values();
    f.focus();
    let via = '';
    const dt = new DataTransfer();
    dt.setData('text/plain', a.text);
    let ev: Event;
    try {
      ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true, composed: true });
    } catch {
      ev = new Event('paste', { bubbles: true, cancelable: true, composed: true });
    }
    // A page that handles the paste itself (e.g. spreads a code over several boxes) stops the event but uses the text.
    if (!f.dispatchEvent(ev) && values() === beforeAll) via = 'paste';
    if (!via) {
      const bi = new InputEvent('beforeinput', { inputType: 'insertFromPaste', data: a.text, bubbles: true, cancelable: true, composed: true });
      if (!f.dispatchEvent(bi) && values() === beforeAll) via = 'beforeinput';
    }
    if (!via) {
      // As if the paste went through: does the page empty the field straight away?
      setNative(f, a.text);
      f.dispatchEvent(new InputEvent('input', { inputType: 'insertFromPaste', data: a.text, bubbles: true, composed: true }));
      await new Promise((r) => setTimeout(r, 60));
      if (f.value === '') via = 'cleared';
    }
    setNative(f, before);
    f.blur();
    return { blocked: !!via, via };
  };

  // --- Submit attempts (3.3.1, 3.3.3, 4.1.3) ------------------------------------------------------
  interface Snap { vis: boolean; own: string }
  interface Armed {
    form: number;
    region: Element;
    before: Map<Element, Snap>;
    styles: Map<number, { aria: string | null; cls: string; look: string; ring: string }>;
    invalid: { ref: number; message: string; ev: Event }[];
    onInvalid: (e: Event) => void;
    mutated: Set<Node>;
    observer: MutationObserver;
    activeBefore: Element | null;
    /** `rec.reported` when armed. */
    reported: number;
    /** What scripts changed while the submit's own events were dispatched (`submit`): the submit's direct doing. */
    direct: Set<Node>;
    /** When it was armed (the page's performance.now()), for what timers set before it wrote after it (`timer`). */
    at: number;
    /** The element the invalid listener is on (the form's root, or for fields outside a form the changed field's box). */
    root: Element;
  }
  let armed: Armed | null = null;
  /** When the first attempt of the page was armed: timers set before it are the page's own, whatever a submit starts. */
  let firstArmAt: number | null = null;
  /** Each field's style as the first submit attempt of its form found it (before any attempt marked it). */
  const pristine = new Map<number, { aria: string | null; cls: string; look: string; ring: string }>();
  /**
   * Each field's words as the first submit attempt of its form found them: the text of what describes it
   * (aria-describedby, aria-errormessage) and the text of its box (its parent, without field values).
   */
  const pristineWords = new Map<number, { desc: string; box: string }>();
  const descOf = (f: Element): Element[] => [...byIds(f.getAttribute('aria-describedby')), ...byIds(f.getAttribute('aria-errormessage'))];
  const wordsOf = (f: Element): { desc: string; box: string } => ({
    desc: descOf(f).filter((d) => seen(d)).map((d) => textOf(d, 300)).join(' | '),
    box: f.parentElement ? textOf(f.parentElement, 600) : '',
  });
  /**
   * The visible words around a field (review r1 F1): its row (the highest ancestor below the form that holds no
   * other field), the row's neighbours back to the previous field and on to the next one, a label that wraps it, and
   * what describes it. Each element's own text, of the elements seen now (an error revealed by opacity or height
   * counts once it shows). `rowSig` equal to the first attempt's = nothing about the field shows that did not before.
   */
  const rowOf = (ref: number): Element[] => {
    const f = fields[ref];
    if (!f || !f.isConnected) return [];
    const form = fieldForm[ref];
    const root = form === undefined ? null : roots[form];
    const others = (form === undefined ? [] : formFields[form] ?? []).filter((r) => r !== ref).map((r) => fields[r]).filter((x): x is Element => !!x && x.isConnected);
    const holdsOther = (el: Element) => (el !== f && el.matches(FIELD_SEL)) || others.some((o) => el.contains(o));
    let row: Element = f;
    for (let a = f.parentElement; a && a !== root && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      if (holdsOther(a)) break;
      row = a;
    }
    const parts = new Set<Element>([row]);
    for (let n = row.nextElementSibling, k = 0; n && k < 8 && !holdsOther(n); n = n.nextElementSibling, k++) parts.add(n);
    for (let n = row.previousElementSibling, k = 0; n && k < 8 && !holdsOther(n); n = n.previousElementSibling, k++) parts.add(n);
    for (const l of Array.from((f as HTMLInputElement).labels ?? [])) parts.add(l);
    for (const d of descOf(f)) parts.add(d);
    return [...parts];
  };
  const rowWords = (ref: number): { sig: string; text: string } => {
    const sig: string[] = [];
    let n = 0;
    for (const p of rowOf(ref)) {
      for (const el of [p, ...Array.from(p.getElementsByTagName('*'))]) {
        if (++n > 400) return { sig: `${sig.join('|')}|…`, text: clean(sig.join(' '), 400) };
        if (el.matches(FIELD_SEL) || !seen(el)) continue;
        const t = ownText(el);
        if (t) sig.push(t);
      }
    }
    return { sig: sig.join('|'), text: clean(sig.join(' '), 400) };
  };
  /** Each field's row words (`rowWords`) as the first submit attempt of its form found them. */
  const pristineRows = new Map<number, string>();
  /** The elements of the last collected messages, in the order `collect` returned them (for `steady`). */
  let lastMessages: { el: Element; own: string }[] = [];
  const ownText = (el: Element) => {
    let s = '';
    for (const n of Array.from(el.childNodes)) if (n.nodeType === 3) s += n.nodeValue;
    return s.replace(/\s+/g, ' ').trim();
  };
  const regionOf = (root: Element): Element => {
    let r: Element = root;
    for (let i = 0; i < 3; i++) {
      const p = r.parentElement;
      if (!p || p === document.documentElement || p === document.body) break;
      if (p.getElementsByTagName('*').length > 1500) break;
      r = p;
    }
    return r;
  };
  const elementsOf = (region: Element) => [region, ...Array.from(region.getElementsByTagName('*')).slice(0, 3000)];
  const styleOf = (f: Element) => {
    const s = getComputedStyle(f);
    return {
      aria: f.getAttribute('aria-invalid'),
      cls: f.getAttribute('class') ?? '',
      look: [s.borderTopColor, s.borderRightColor, s.borderBottomColor, s.borderLeftColor, s.backgroundColor, s.color].join('|'),
      ring: [s.boxShadow, s.outlineColor].join('|'),
    };
  };
  /** A colour that turned red or orange (error styling; "valid" styling is usually green). */
  const turnedRed = (before: string, after: string): boolean => {
    const colours = (x: string) => (x.match(/rgba?\([^)]*\)/g) ?? []);
    const old = new Set(colours(before));
    return colours(after).some((c) => {
      if (old.has(c)) return false;
      const [r = 0, g = 0, b = 0, alpha = 1] = (c.match(/[\d.]+/g) ?? []).map(Number);
      return alpha > 0.3 && r >= 120 && r >= 1.4 * g && r >= 1.4 * b;
    });
  };
  const arm = (a: { form: number; near?: number }): boolean => {
    disarm();
    stopLate();
    // Batch 18: the fields outside any form (filters above a list) have no root: the changed field's own box stands in.
    const root = roots[a.form] ?? (typeof a.near === 'number' ? fields[a.near]?.parentElement?.closest('section, article, aside, div, main, body') ?? null : null);
    if (!root || !root.isConnected) return false;
    const region = regionOf(root);
    const before = new Map<Element, Snap>();
    for (const el of elementsOf(region)) before.set(el, { vis: seen(el), own: ownText(el) });
    const styles = new Map<number, ReturnType<typeof styleOf>>();
    for (const ref of formFields[a.form] ?? []) {
      if (!fields[ref]?.isConnected) continue;
      const st = styleOf(fields[ref]!);
      styles.set(ref, st);
      if (!pristine.has(ref)) pristine.set(ref, st);
      if (!pristineWords.has(ref)) pristineWords.set(ref, wordsOf(fields[ref]!));
      if (!pristineRows.has(ref)) pristineRows.set(ref, rowWords(ref).sig);
    }
    const invalid: Armed['invalid'] = [];
    const onInvalid = (e: Event) => {
      const ref = fields.indexOf(e.target as Element);
      if (ref >= 0 && !invalid.some((x) => x.ref === ref)) invalid.push({ ref, message: clean((e.target as HTMLInputElement).validationMessage, 200), ev: e });
    };
    root.addEventListener('invalid', onInvalid, true);
    const mutated = new Set<Node>();
    const observer = new MutationObserver((records) => {
      noteBirths(records);
      for (const r of records) {
        if (mutated.size > 2000) break;
        mutated.add(r.target);
        r.addedNodes.forEach((n) => mutated.add(n));
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'role', 'aria-live', 'open'] });
    sinceCursor();
    rec.shield = true;
    // From here on the listener hook notes what each timer's own callback changes (`CollectedMessage.timer`).
    try { (W.__grntedTimerChanges as ((on: boolean) => boolean) | undefined)?.(true); } catch { /* no hook: nothing is attributed */ }
    liveAtArm = new Set(Array.from(document.querySelectorAll(LIVE_SEL)).slice(0, 1000));
    bornEmpty.clear();
    bornFull.clear();
    armed = { form: a.form, region, before, styles, invalid, onInvalid, mutated, observer, activeBefore: document.activeElement, reported: rec.reported, direct: new Set<Node>(), at: performance.now(), root };
    if (firstArmAt === null) firstArmAt = armed.at;
    return true;
  };
  function disarm(): void {
    if (!armed) return;
    try { armed.observer.disconnect(); } catch { /* ignore */ }
    try { armed.root.removeEventListener('invalid', armed.onInvalid, true); } catch { /* ignore */ }
    // Once recording, the shield stays on for good.
    rec.shield = rec.recording;
    armed = null;
  }
  const submit = (a: { form: number; button: number }): boolean => {
    const root = roots[a.form];
    if (!root || !root.isConnected) return false;
    try {
      const b = a.button >= 0 ? (buttons[a.button] as HTMLElement | undefined) : undefined;
      // Whether focus moved is judged from where it is when the form is submitted (the button, as a
      // person presses it), not from before the test filled the fields: a page that keeps focus on its
      // error summary from an earlier attempt and moves it there again has moved it.
      // What the page's scripts changed while the click (or requestSubmit) was dispatched, taken at once: the
      // submit's direct doing, which a timer or a rotating notice elsewhere cannot be (review r1 F3b).
      const takeDirect = () => {
        const A = armed;
        if (!A) return;
        const recs = A.observer.takeRecords();
        noteBirths(recs);
        for (const r of recs) {
          A.mutated.add(r.target);
          A.direct.add(r.target);
          r.addedNodes.forEach((n) => { A.mutated.add(n); A.direct.add(n); });
        }
      };
      if (b && b.isConnected) {
        b.focus();
        if (armed) armed.activeBefore = document.activeElement;
        b.click();
        takeDirect();
        return true;
      }
      if (root.tagName === 'FORM') {
        if (armed) armed.activeBefore = document.activeElement;
        (root as HTMLFormElement).requestSubmit();
        takeDirect();
        return true;
      }
    } catch { /* ignore */ }
    return false;
  };
  const collect = (c: { outside?: string } = {}): CollectResult | { gone: true } => {
    const A = armed;
    if (!A) return { gone: true };
    // Words of a message the caller also takes from outside the form's area (a toast, a notice in a page portal).
    let OUTSIDE: RegExp | null = null;
    try { OUTSIDE = c && typeof c.outside === 'string' && c.outside ? new RegExp(c.outside, 'i') : null; } catch { OUTSIDE = null; }
    const outsideEls = new Set<Element>();
    // Slotted into a live region of a shadow tree: announced.
    const slottedLive = (el: Element): boolean => {
      for (let a: Element | null = el; a; a = a.parentElement) if (a.assignedSlot && a.assignedSlot.closest(LIVE_SEL)) return true;
      return false;
    };
    const isDirect = (el: Element): boolean => {
      for (const n of A.direct) if (n === el || el.contains(n) || (n.nodeType === 1 && (n as Element).contains(el))) return true;
      return false;
    };
    // Churned: the element itself, something inside it, or a message-sized box around it changed while no attempt
    // was armed. Not known (the observer could not start, or filled up): every message counts as churned.
    const churnedEl = (el: Element): boolean => {
      if (!churnKnown || churnFull) return true;
      for (const c of churn) {
        if (c === el || el.contains(c)) return true;
        if (c.contains(el) && textOf(c, 400).length <= 300) return true;
      }
      return false;
    };
    // Written by a timer the page had running (the listener hook saw its callback do it): in this attempt's window,
    // by a timer set before the attempt was armed; or at any time since the first attempt, by a timer the page had
    // set before that one (text an earlier window's tick left, which the next attempt finds "changed since the
    // form was first tried").
    const timerWrote = (el: Element): boolean => {
      try {
        const wrote = W.__grntedTimerWrote as ((el: Element, since: number) => boolean) | undefined;
        return !!wrote && (wrote(el, A.at) === true || (firstArmAt !== null && wrote(el, firstArmAt) === true));
      } catch { return false; }
    };
    // Rendered through a shadow tree that holds a live region (slotted into a custom element): not known whether announced.
    const throughShadow = (el: Element): boolean => {
      for (let a: Element | null = el; a; a = a.parentElement) {
        const sr = (a as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
        if (sr && sr.querySelector(LIVE_SEL)) return true;
      }
      return false;
    };

    const formRefs = formFields[A.form] ?? [];
    const ownField = (el: Element) => !!el.closest('input, select, textarea, option, datalist, button, [role="button"], script, style, noscript, template');
    // Character counters and the like are not messages about errors.
    const counter = (t: string) => t.replace(/[^0-9]/g, '').length >= t.replace(/[^\p{L}]/gu, '').length;
    // Text that appeared or changed in the form's area: the outermost element that was inserted or
    // revealed, or an element whose own text changed.
    const changed: { el: Element; kind: CollectedMessage['kind'] }[] = [];
    const icons: Element[] = [];
    const symbols = new Set<Element>();
    for (const el of elementsOf(A.region)) {
      if (ownField(el) || !seen(el)) continue;
      // A revealed step or section holds fields: it is not a message.
      if (el.querySelector(FIELD_SEL)) continue;
      const b = A.before.get(el);
      const parent = el.parentElement;
      const pb = parent ? A.before.get(parent) : undefined;
      let kind: CollectedMessage['kind'] | undefined;
      if (!b) kind = pb !== undefined || el === A.region ? 'added' : undefined;
      else if (!b.vis) kind = !pb || pb.vis ? 'shown' : undefined;
      else {
        const own = ownText(el);
        if (own && own !== b.own) kind = 'text';
      }
      if (!kind) continue;
      if (changed.some((c) => c.kind !== 'text' && c.el.contains(el))) continue;
      const text = textOf(el, 300);
      if (!text) {
        if ((kind !== 'text' && el.querySelector('svg, img, i, [class*="icon"], [class*="fa-"]')) || /^(svg|img|i)$/i.test(el.tagName)) icons.push(el);
        continue;
      }
      // Batch 18 (V-EI-06): a symbol with no words ("*", "!", "✗" typed as text) says nothing in text: a mark, as an icon is.
      if (!/[\p{L}\p{N}]/u.test(text)) { if (kind !== 'text') { icons.push(el); symbols.add(el); } continue; }
      if (counter(text)) continue;
      changed.push({ el, kind });
    }
    // Error text inserted elsewhere on the page (an error summary at the top).
    const ERRORISH = /\b(error|errors|invalid|required|must|please|correct|missing|problem|wrong|fix|obligatorio|requerido|inv[aá]lido|corrija|falta)\b/i;
    for (const n of Array.from(A.mutated)) {
      if (n.nodeType !== 1 || changed.length >= 30) continue;
      const el = n as Element;
      if (!el.isConnected || A.region.contains(el) || ownField(el) || !seen(el) || el.querySelector(FIELD_SEL)) continue;
      if (changed.some((c) => c.el === el || c.el.contains(el) || el.contains(c.el))) continue;
      const text = textOf(el, 300);
      if (!text || counter(text)) continue;
      if (ERRORISH.test(text)) changed.push({ el, kind: 'added' });
      else if (OUTSIDE && churnKnown && !churnFull && OUTSIDE.test(text) && text.length <= 300) {
        // Only what the submit's own events wrote, and never something that also changed while nothing was being
        // submitted (review r1 F3b): a toast elsewhere is the submit's answer only when the submit caused it.
        if (!isDirect(el) || churnedEl(el)) continue;
        // The outermost changed element that holds the words: a message, not a section of the page.
        if (el.querySelector('h1, h2, h3, h4, h5, h6, form, table, ul, ol, nav, main, article, section')) continue;
        changed.push({ el, kind: 'added' });
        outsideEls.add(el);
      }
    }
    // Error text an earlier attempt put in what describes a field, left as it was by this one: the page's answer
    // to this attempt too (a page that judges the fields again and finds the same problem writes the same words).
    // Only text that was not there when the form was first tried, in an element that describes the field.
    for (const ref of formRefs) {
      const f = fields[ref];
      const p = pristineWords.get(ref);
      if (!f || !f.isConnected || !p || !fieldShown(f)) continue;
      for (const d of descOf(f)) {
        if (changed.length >= 30 || !seen(d) || changed.some((c) => c.el === d || c.el.contains(d) || d.contains(c.el))) continue;
        const t = textOf(d, 300);
        if (t && !p.desc.includes(t) && !counter(t)) changed.push({ el: d, kind: 'text' });
      }
    }
    // Live regions and alerts that changed anywhere on the page.
    const liveEls = new Set<Element>();
    for (const n of Array.from(A.mutated)) {
      const el = n.nodeType === 1 ? (n as Element) : n.parentElement;
      if (!el || !el.isConnected) continue;
      const live = el.closest(LIVE_SEL);
      if (live) liveEls.add(live);
      if (n.nodeType === 1) el.querySelectorAll(LIVE_SEL).forEach((x) => liveEls.add(x));
    }
    // Only regions that announce (batch 18, `announcedEl`): known before the attempt, or an alert, and not hidden.
    for (const l of Array.from(liveEls)) if (!announcedEl(l)) liveEls.delete(l);
    const announcements: string[] = [];
    // What the page announced through `ariaNotify` since the attempt was armed (batch 19): told to screen readers.
    for (const n of (W.__grntedNotified ?? []) as { t: number; text: string }[]) if (n.t >= A.at && n.text && !announcements.includes(n.text)) announcements.push(n.text);
    for (const l of Array.from(liveEls)) {
      const t = clean(l.textContent, 300);
      if (t && !announcements.includes(t)) announcements.push(t);
      if (!A.region.contains(l) && seen(l) && t && !changed.some((c) => c.el === l || c.el.contains(l) || l.contains(c.el))) changed.push({ el: l, kind: 'live' });
    }
    const norm = (s: string) => s.toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/[*:]/g, ' ')
      .replace(/\b(required|optional|obligatorio|opcional)\b/g, ' ').replace(/\s+/g, ' ').trim();
    const labels = new Map<number, string>();
    for (const ref of formRefs) labels.set(ref, norm(labelOf(fields[ref]!)));
    const nearOf = (m: Element): number => {
      let anc: Element | null = m.parentElement;
      for (let d = 0; anc && d < 4; d++, anc = anc.parentElement) {
        const inside = formRefs.filter((ref) => fields[ref]!.isConnected && anc!.contains(fields[ref]!) && fieldShown(fields[ref]!));
        if (inside.length) {
          const preceding = inside.filter((ref) => fields[ref]!.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_FOLLOWING);
          return preceding.length ? preceding[preceding.length - 1]! : inside[0]!;
        }
      }
      return -1;
    };
    const tiedTo = (m: Element): number[] => formRefs.filter((ref) => {
      const f = fields[ref]!;
      const described = [...byIds(f.getAttribute('aria-describedby')), ...byIds(f.getAttribute('aria-errormessage'))];
      if (described.some((t) => t === m || t.contains(m) || m.contains(t))) return true;
      const named = [...byIds(f.getAttribute('aria-labelledby')), ...Array.from((f as HTMLInputElement).labels ?? [])];
      return named.some((t) => t === m || t.contains(m));
    });
    /** Fields the message links to: an in-page link whose target is the field or an element around it. */
    const linkedFrom = (m: Element): number[] => {
      const out = new Set<number>();
      for (const a of Array.from(m.querySelectorAll('a[href^="#"]')).slice(0, 30)) {
        let id = (a.getAttribute('href') ?? '').slice(1);
        try { id = decodeURIComponent(id); } catch { /* used as written */ }
        const t = id ? document.getElementById(id) : null;
        if (!t) continue;
        for (const ref of formRefs) if (t === fields[ref] || t.contains(fields[ref]!)) out.add(ref);
      }
      return [...out];
    };
    const active = document.activeElement;
    const formRoot = roots[A.form];
    /** Words any error message uses: sharing them with a label says nothing about which field is meant. */
    const FORM_WORDS = new Set(['enter', 'type', 'your', 'please', 'field', 'fields', 'required', 'valid', 'value', 'this', 'that', 'with', 'from', 'have', 'must', 'what', 'here', 'form']);
    // A section of content (headings, controls, lists, a table) rather than a message.
    const PARTS = 'h1, h2, h3, h4, h5, h6, button, a[href], [role="button"], ul, ol, dl, table';
    const msgs: CollectedMessage[] = changed.slice(0, 30).map(({ el, kind }) => {
      const text = textOf(el, 300);
      const lower = norm(text);
      return {
        text, kind,
        // A message outside the form (an error summary above it) belongs to no single field.
        near: formRoot && !formRoot.contains(el) ? -1 : nearOf(el),
        assoc: tiedTo(el),
        // It names a field when it holds the field's whole label, or two or more of the label's own words
        // (four letters or more, form-filling words left out): "That is not seven plus five" says which field.
        names: formRefs.filter((ref) => {
          const l = labels.get(ref) ?? '';
          if (l.length >= 3 && lower.includes(l)) return true;
          const own = new Set((l.match(/\p{L}{4,}/gu) ?? []).filter((w) => !FORM_WORDS.has(w)));
          if (own.size < 2) return false;
          const said = new Set(lower.match(/\p{L}{4,}/gu) ?? []);
          let shared = 0;
          for (const w of own) if (said.has(w)) shared++;
          return shared >= 2;
        }),
        links: linkedFrom(el),
        live: announcedEl(el) || slottedLive(el),
        focus: !!active && (el === active || el.contains(active)),
        ...(outsideEls.has(el) ? { outside: true as const } : {}),
        ...(el.matches(PARTS) || el.querySelector(PARTS) ? { parts: true as const } : {}),
        ...(formRoot && formRoot.contains(el) ? { inForm: true as const } : {}),
        ...(isDirect(el) ? { direct: true as const } : {}),
        ...(churnedEl(el) ? { churned: true as const } : {}),
        // In a live region that appeared after arming, empty, then got its text (Sol S9): whether it is announced is not known.
        ...(throughShadow(el) || (!announcedEl(el) && !slottedLive(el) && announceUnsure(el)) ? { unsure: true as const } : {}),
        ...(timerWrote(el) ? { timer: true as const } : {}),
      };
    });
    lastMessages = changed.slice(0, 30).map(({ el }) => ({ el, own: ownText(el) }));
    const marks: CollectResult['marks'] = [];
    for (const ref of formRefs) {
      const f = fields[ref]!;
      const b = A.styles.get(ref);
      if (!b || !f.isConnected || !fieldShown(f)) continue;
      const now = styleOf(f);
      const focused = f === active;
      const added = now.cls.split(/\s+/).filter((c) => c && !b.cls.split(/\s+/).includes(c));
      const icon = icons.some((i) => nearOf(i) === ref);
      const symbol = icon && icons.filter((i) => nearOf(i) === ref).every((i) => symbols.has(i));
      const m = {
        ref,
        aria: now.aria === 'true' && b.aria !== 'true',
        // Focus rings are not error marks; a border or background that turned red is, focused or not.
        style: focused ? turnedRed(b.look, now.look) : turnedRed(`${b.look}|${b.ring}`, `${now.look}|${now.ring}`),
        cls: added.some((c) => /err|invalid|danger|warn/i.test(c)),
        icon,
        ...(symbol ? { symbol: true as const } : {}),
      };
      if (m.aria || m.style || m.cls || m.icon) marks.push(m);
    }
    // A mark an earlier submit left that this one kept, while it took the marks of other fields away: the page
    // judged every field again and still finds this one wrong (a page that marks only by toggling a class).
    type Look = { aria: string | null; cls: string; look: string; ring: string };
    const markOf = (base: Look, now: Look): { aria: boolean; style: boolean; cls: boolean } | null => {
      const added = now.cls.split(/\s+/).filter((c) => c && !base.cls.split(/\s+/).includes(c));
      const m = { aria: now.aria === 'true' && base.aria !== 'true', style: turnedRed(`${base.look}|${base.ring}`, `${now.look}|${now.ring}`), cls: added.some((c) => /err|invalid|danger|warn/i.test(c)) };
      return m.aria || m.style || m.cls ? m : null;
    };
    const cleared: number[] = [];
    const stayed: { ref: number; aria: boolean; style: boolean; cls: boolean }[] = [];
    for (const ref of formRefs) {
      const f = fields[ref]!;
      const b = A.styles.get(ref);
      const p = pristine.get(ref);
      if (!b || !p || !f.isConnected || !fieldShown(f) || marks.some((m) => m.ref === ref)) continue;
      if (!markOf(p, b)) continue;
      // Words about the field that were not there at first (anywhere around it: review r1 F1) may say what is
      // wrong: not a mark without text, whatever the page left from an earlier attempt. Absence must be shown.
      const w = pristineRows.get(ref);
      if (w === undefined || rowWords(ref).sig !== w) continue;
      const still = markOf(p, styleOf(f));
      if (still) stayed.push({ ref, ...still });
      else cleared.push(ref);
    }
    if (cleared.length) for (const m of stayed) marks.push({ ...m, icon: false, kept: true });
    const msgEls = changed.map((c) => c.el);
    const activeInfo = describeActive(A.form, msgEls);
    const before = A.activeBefore;
    const activeBeforeInfo: ActiveInfo = before && before !== document.body
      ? { to: fields.includes(before) ? 'field' : 'other', ref: fields.indexOf(before), form: formIndexOf(before), label: textOf(before, 60) }
      : { to: 'body', ref: -1, form: -1, label: '' };
    const result: CollectResult = {
      ...sinceCursor(),
      invalid: A.invalid.slice(0, 30).map((i) => ({ ref: i.ref, message: i.message, prevented: i.ev.defaultPrevented })),
      reported: rec.reported > A.reported,
      formGone: !roots[A.form]?.isConnected,
      messages: msgs,
      marks,
      rows: formRefs.slice(0, 60).map((ref) => {
        const w = rowWords(ref);
        return { ref, quiet: pristineRows.get(ref) === w.sig, text: w.text };
      }),
      announcements: announcements.slice(0, 10),
      active: activeInfo,
      activeBefore: activeBeforeInfo,
      // Focus moved to a field or a message (not just onto the button the test pressed).
      focusMoved: active !== before && (activeInfo.to === 'field' || activeInfo.to === 'message'),
    };
    disarm();
    startLate(lastMessages.map((m) => m.el));
    return result;
  };

  /**
   * Which of the last collected messages stay as they were for `ms`. Text that keeps changing or blinking by
   * itself (a countdown, a clock, a ticker, a notice in an endless animation) is not a message the form
   * showed when it was sent: it would have changed anyway.
   */
  const endless = (el: Element): boolean => {
    for (let a: Element | null = el, d = 0; a && d < 5; a = a.parentElement, d++) {
      if (a.tagName === 'MARQUEE') return true;
      const running = typeof a.getAnimations === 'function' ? a.getAnimations() : [];
      for (const an of running) {
        const t = an.effect?.getComputedTiming?.();
        if (an.playState === 'running' && t && t.iterations === Infinity) return true;
      }
    }
    return false;
  };
  const steady = async (a: { indices: number[]; ms: number }): Promise<boolean[]> => {
    const list = (a.indices ?? []).map((i) => lastMessages[i]);
    const ok = list.map((m) => !!m && !endless(m.el));
    const check = () => list.forEach((m, k) => {
      if (ok[k] && m && (!m.el.isConnected || !seen(m.el) || ownText(m.el) !== m.own)) ok[k] = false;
    });
    const until = performance.now() + Math.min(3000, Math.max(0, a.ms));
    while (ok.some(Boolean) && performance.now() < until) {
      await new Promise((r) => setTimeout(r, 100));
      check();
    }
    return ok;
  };

  /**
   * Announced late (review r1 F3c). From `collect` on (`startLate`), an observer notes whether a live region changes
   * anywhere on the page or one of the collected messages becomes live (a role or aria-live set on it or around it);
   * `lateAnnounce` waits up to `ms` more (at most 1.5 s) for that, then also counts a message now inside a live
   * region and focus moved (since `collect`) to a message or a field. Any of these counts as announced (the rule
   * leans to no failure). The next `arm` stops the watch.
   */
  let late: { obs: MutationObserver | null; hit: boolean; els: Element[]; startActive: Element | null } | null = null;
  const stopLate = (): void => {
    try { late?.obs?.disconnect(); } catch { /* ignore */ }
    late = null;
  };
  const startLate = (els: Element[]): void => {
    stopLate();
    const L: NonNullable<typeof late> = { obs: null, hit: false, els, startActive: document.activeElement };
    late = L;
    try {
      L.obs = new MutationObserver((recs) => {
        for (const r of recs) {
          const t = r.target.nodeType === 1 ? (r.target as Element) : r.target.parentElement;
          if (t && ((t.closest(LIVE_SEL) && announcedEl(t)) || (r.type === 'attributes' && L.els.some((e) => t === e || t.contains(e)) && L.els.some((e) => announcedEl(e))))) { L.hit = true; break; }
        }
      });
      L.obs.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['role', 'aria-live'] });
    } catch { L.hit = true; }
  };
  const lateAnnounce = async (a: { ms: number }): Promise<boolean> => {
    const L = late;
    // No watch running (the page was replaced, or collect did not run): say announced, never a failure.
    if (!L) return true;
    const until = performance.now() + Math.min(1500, Math.max(0, a.ms));
    while (!L.hit && performance.now() < until) await new Promise((r) => setTimeout(r, 50));
    // Records not yet delivered to the callback count too.
    try {
      for (const r of L.obs?.takeRecords() ?? []) {
        const t = r.target.nodeType === 1 ? (r.target as Element) : r.target.parentElement;
        if (t && ((t.closest(LIVE_SEL) && announcedEl(t)) || (r.type === 'attributes' && L.els.some((e) => t === e || t.contains(e)) && L.els.some((e) => announcedEl(e))))) { L.hit = true; break; }
      }
    } catch { /* ignore */ }
    const hit = L.hit;
    stopLate();
    if (hit) return true;
    const els = L.els.filter((e) => e.isConnected);
    if (els.some((e) => announcedEl(e) || slotLive(e))) return true;
    const act = document.activeElement;
    return !!act && act !== L.startActive && act !== document.body && (els.some((e) => e === act || e.contains(act)) || fields.includes(act));
  };
  const slotLive = (el: Element): boolean => {
    for (let a: Element | null = el; a; a = a.parentElement) if (a.assignedSlot && a.assignedSlot.closest(LIVE_SEL)) return true;
    return false;
  };

  W.__grntedForms = {
    scan, record, submitterNow, observe, focusField, blurField, change, restore, fill, shield, click, shownFields, sameAsOffered, whereValues, paste, arm, submit, collect, steady, lateAnnounce, labelSeen, markShown, freshScan,
    disarm: () => { disarm(); return true; },
    // Report evidence: puts one field where the shared picture helper finds it (window[key][0]), or takes it away.
    expose: (a: { ref: number; key: string }) => {
      const f = fields[a.ref];
      if (!f || !f.isConnected || typeof a.key !== 'string' || !a.key.startsWith('__grnted')) return false;
      (W as unknown as Record<string, unknown>)[a.key] = [f];
      return true;
    },
    // F111: the field as the scan judged it, with the closed <details> around it opened (`undisclose` closes them).
    disclose: (a: { ref: number }) => {
      const f = fields[a.ref];
      if (!f || !f.isConnected) return 0;
      for (let d = f.parentElement ? f.parentElement.closest('details') : null; d; d = d.parentElement ? d.parentElement.closest('details') : null) {
        if (!(d as HTMLDetailsElement).open) { (d as HTMLDetailsElement).open = true; disclosed.push(d as HTMLDetailsElement); }
      }
      return disclosed.length;
    },
    undisclose: () => {
      for (const d of disclosed.splice(0)) d.open = false;
      return true;
    },
    unexpose: (a: { key: string }) => {
      if (typeof a.key === 'string' && a.key.startsWith('__grnted')) delete (W as unknown as Record<string, unknown>)[a.key];
      return true;
    },
  };
  return true;
}

/** What `fill` is given for a list: its first real choice when nothing is chosen yet (the agent reads the literal). */
export const FIRST_CHOICE = 'grnted:first-choice';

/** Calls one agent operation inside the page; `{ gone: true }` when the page was replaced (the agent is gone). Self-contained. */
export function callFormsAgent(a: { op: string; arg?: unknown }): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const agent = (window as any).__grntedForms;
  if (!agent || typeof agent[a.op] !== 'function') return { gone: true };
  return agent[a.op](a.arg ?? {});
}
