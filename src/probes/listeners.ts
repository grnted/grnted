// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The listener hook: an init script that runs in every page and frame of a probe context before the
// page's own scripts (`addInitScript`, no CDP), recording what the probes need to find interactive
// elements and timed behaviour. Engine core: no Node-only imports.
//
// It is a plain string, not a serialized function, so bundlers that rename or wrap functions (e.g.
// esbuild's keepNames in the Worker build) cannot break it. It must never break a page: every hook
// calls the original with the same `this` and arguments and returns its result, recording happens
// in try/catch, removeEventListener and AbortSignal removal are honoured, and wrapped functions keep
// their names, lengths and native-looking toString.
//
// In the page, after load:
//   window.__grntedListeners() -> RecordedListener[] (JSON-safe, main frame, connected elements only)
//   window.__grntedHooks()     -> RecordedHooks (listeners, timers >= 1 s, dialog/open/submit calls, audio)
//   window.__grntedTarget(ref) -> the element (or window/document) of a listener's `ref`
// and, for in-page probe code (Task 4.4):
//   window.__grntedPending()   -> PendingTimer[]: timers >= 1 s not yet fired or cleared
//   window.__grntedFire(handle, keep) -> runs that timer's callback now, as if its time had come (a
//                                 timeout is cancelled unless `keep`; an interval keeps running)
//   window.__grntedCancel(handle) -> cancels a pending timeout (an interval is left alone)
//   window.__grntedCalls()     -> the recorded alert/confirm/prompt/open/submit calls
//   window.__grntedSubmitStopped(ev) -> whether the page itself stopped a submit event (the hook cancels
//                                 every trusted one, so a form is never sent; null for others)
//   window.__grntedTimerChanges(on) -> while on, a timer's record gets lastChangeAt when its own callback
//                                 changes the DOM
//   window.__grntedTimerWrote(el, since) -> while watching (__grntedTimerChanges), whether the own callback of a
//                                 timer of 1 s or more that was SET BEFORE `since` (page performance.now() ms)
//                                 changed `el`, something inside it, or a message-sized box around it, at or
//                                 after `since`: what the page keeps writing by itself (an arrival time, a
//                                 clock, a rotating notice), never an answer to what a test did after `since`
//   window.__grntedSound()     -> { played, contexts, outputs, pageSuspended(ctx), sources, playedAuto(el),
//                                 ctxByInput(ctx), routed, speech }: media elements the page called play() on
//                                 (and whether outside an input event), AudioContexts (and whether made in one),
//                                 nodes connected to a speaker, source nodes started (and whether in an input event),
//                                 media elements routed into Web Audio, text spoken with speech synthesis
//   window.__grntedTimerHold() -> { on, held }: whether the page's long timers are held, and how many wait
//   window.__grntedInInput()   -> whether a click, press, key, change or input event is being dispatched now
//   window.__grntedDescribe(el) -> the hook's ListenerTarget description of an element
//   window.__grntedFreeze(on)  -> holds (true) or releases (false) the callbacks of timers >= 1 s, so
//                                 a carousel or slideshow does not advance while a test looks; a
//                                 timeout due while held runs as soon as it is released, an interval
//                                 skips its ticks. Returns the timeouts held so far.
import type { RecordedHooks, RecordedListener } from './types.js';

/** Event types recorded (handlers added with addEventListener, on* properties or inline attributes). */
export const LISTENER_TYPES = [
  'click', 'dblclick', 'auxclick', 'contextmenu',
  'mousedown', 'mouseup', 'mousemove', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave',
  'pointerdown', 'pointerup', 'pointermove', 'pointerover', 'pointerout', 'pointerenter', 'pointerleave', 'pointercancel',
  'touchstart', 'touchend', 'touchmove', 'touchcancel',
  'keydown', 'keyup', 'keypress',
  'devicemotion', 'deviceorientation', 'deviceorientationabsolute',
  'drag', 'dragstart', 'dragend', 'dragenter', 'dragleave', 'dragover', 'dragexit', 'drop',
  'focus', 'blur', 'focusin', 'focusout',
  'wheel', 'change', 'input', 'beforeinput', 'submit',
] as const;

/** Timers shorter than this are animation and scheduling noise and are not recorded. */
export const MIN_TIMER_MS = 1000;

const SCRIPT = String.raw`(function () {
  var W = window;
  if (W.__grntedListeners) return;
  var TYPES = new Set(__TYPES__);
  var MIN_TIMER = __MIN_TIMER__;
  var MAX_RECORDS = 20000, MAX_TIMERS = 200, MAX_CALLS = 200, MAX_AUDIO = 50;
  var nativeToString = Function.prototype.toString;
  var masks = new WeakMap();
  var defineProp = Object.defineProperty;
  var getDesc = Object.getOwnPropertyDescriptor;

  // Wrapped functions print like the originals (some sites check for [native code]).
  try {
    var toStringHook = function toString() { return nativeToString.call(masks.get(this) || this); };
    masks.set(toStringHook, nativeToString);
    defineProp(Function.prototype, 'toString', { value: toStringHook, writable: true, enumerable: false, configurable: true });
  } catch (e) {}

  function replace(obj, name, wrapper, orig) {
    try {
      var d = getDesc(obj, name);
      if (!d || !d.configurable) return false;
      masks.set(wrapper, orig);
      try { defineProp(wrapper, 'name', { value: orig.name }); } catch (e) {}
      defineProp(obj, name, { value: wrapper, writable: d.writable, enumerable: d.enumerable, configurable: true });
      return true;
    } catch (e) { return false; }
  }

  // --- Event listeners ---------------------------------------------------------------------------
  var byTarget = new Map();
  var total = 0;
  function tracked(t) { return t === W || (typeof Node === 'function' && t instanceof Node); }
  function listOf(t) { var l = byTarget.get(t); if (!l) { l = []; byTarget.set(t, l); } return l; }
  function isCapture(o) { return typeof o === 'boolean' ? o : !!(o && typeof o === 'object' && o.capture); }
  function forget(t, type, listener, capture, via) {
    var l = byTarget.get(t);
    if (!l) return;
    for (var i = 0; i < l.length; i++) {
      var r = l[i];
      if (r.via === via && r.type === type && (via === 'property' || (r.listener === listener && r.capture === capture))) {
        l.splice(i, 1); total--; return;
      }
    }
  }

  var ET = EventTarget.prototype;
  var origAdd = ET.addEventListener, origRemove = ET.removeEventListener;
  var addHook = function addEventListener(type, listener) {
    var opts = arguments[2];
    try {
      var t = this == null ? W : this;
      if (listener && typeof type === 'string' && TYPES.has(type) && tracked(t) && total < MAX_RECORDS) {
        var capture = isCapture(opts);
        var signal = opts && typeof opts === 'object' ? opts.signal : undefined;
        if (!(signal && signal.aborted)) {
          var l = listOf(t), seen = false;
          for (var i = 0; i < l.length; i++) {
            if (l[i].via === 'add' && l[i].type === type && l[i].listener === listener && l[i].capture === capture) { seen = true; break; }
          }
          if (!seen) {
            l.push({ type: type, listener: listener, capture: capture, passive: !!(opts && typeof opts === 'object' && opts.passive), via: 'add' });
            total++;
            if (signal && typeof signal === 'object') {
              origAdd.call(signal, 'abort', function () { try { forget(t, type, listener, capture, 'add'); } catch (e) {} }, { once: true });
            }
          }
        }
      }
    } catch (e) {}
    return origAdd.apply(this, arguments);
  };
  var removeHook = function removeEventListener(type, listener) {
    var opts = arguments[2];
    try {
      var t = this == null ? W : this;
      if (typeof type === 'string' && TYPES.has(type)) forget(t, type, listener, isCapture(opts), 'add');
    } catch (e) {}
    return origRemove.apply(this, arguments);
  };
  replace(ET, 'addEventListener', addHook, origAdd);
  replace(ET, 'removeEventListener', removeHook, origRemove);

  // --- The pointer probes' canceller (src/probes/pointerKit.ts) -----------------------------------
  // Registered here, before any page script, on window in the capture phase, so it runs before every
  // listener of the page; never removed. Off until a probe turns it on (__grntedHold). While on, every
  // click, auxclick, dblclick, contextmenu, submit and (unless allowed) dragstart is cancelled and
  // stopped, and form.submit()/requestSubmit() do nothing. The kit's own synthetic event passes to
  // the page's listeners, with its default action still prevented when it lands on a link or a submitter.
  var hold = { on: false, drag: false, watch: null, own: null, reached: [], submits: 0 };
  var HOLD_TYPES = ['click', 'auxclick', 'dblclick', 'contextmenu', 'submit', 'dragstart'];
  var holdListener = function (e) {
    if (!hold.on) return;
    try {
      if (e.type === 'dragstart' && hold.drag) return;
      if (e === hold.own) {
        var t = e.target;
        if (t && t.closest && t.closest('a[href], area[href], [role="link"], button, input[type="submit"], input[type="image"]')) e.preventDefault();
        return;
      }
      if (e.type !== 'dragstart' && hold.watch && hold.reached.length < 50 && e.composedPath().indexOf(hold.watch) >= 0) hold.reached.push(e.type);
    } catch (x) {}
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  for (var h = 0; h < HOLD_TYPES.length; h++) { try { origAdd.call(W, HOLD_TYPES[h], holdListener, true); } catch (e) {} }

  // --- The popup blocker (src/probes/guard.ts's first layer) -------------------------------------
  // No window or tab is ever opened, at any time (load, probes, between them): in some browsers
  // (Cloudflare's) a new window's first request is not routed, so the request guard cannot stop it.
  // - window.open (and document.open with three arguments) returns null, as for a popup the browser
  //   blocked, unless it targets this window, its parent or top, or a frame of the page by name.
  // - A click (or middle click) that would follow a link or submit a form into a new window (target
  //   _blank or a name no frame has, a base element's target, formtarget, ctrl/cmd/shift or the
  //   middle button) is cancelled by listeners on window registered before any page script (and on
  //   every shadow root, at creation), and so is such a submit event (shift/ctrl/cmd+Enter included).
  // - A target the page changes while the event is dispatched is seen too: synchronously when it uses
  //   the attribute APIs, and through a MutationObserver between listeners for the browser's own events.
  // - Clicks the window never sees (a link not in the page, a non-composed click in a shadow root) or
  //   cannot cancel (cancelable: false) are checked before they are dispatched; one that cannot be
  //   cancelled is dispatched as a cancelable copy. form.submit() and requestSubmit() are checked too.
  // Each is reported with the address it would have loaded (console.debug with a per-context prefix,
  // see popupReportPrefix): the guard logs it as a 'popup' under the probe running.
  // Every built-in the checks use is read once, here, before any page script: a page that replaces
  // preventDefault, getAttribute or String methods changes nothing.
  var POPUP_PREFIX = __POPUP_PREFIX__;
  var FORM_PREFIX = __FORM_PREFIX__;
  var popups = (function () {
    var call = Reflect.apply, nCreate = Object.create;
    function getter(o, n) { try { var d = o && getDesc(o, n); return (d && d.get) || null; } catch (e) { return null; } }
    function get(g, o) { return call(g, o, []); }
    function proto(name) { var C = W[name]; return typeof C === 'function' ? C.prototype : null; }
    var EP = Event.prototype, UP = proto('UIEvent'), MP = proto('MouseEvent'), PP = proto('PointerEvent'), KP = proto('KeyboardEvent'), SP = proto('SubmitEvent');
    var NP = Node.prototype, EL = Element.prototype, DP = Document.prototype, TP = proto('Text'), SRP = proto('ShadowRoot');
    var AP = proto('HTMLAnchorElement'), ARP = proto('HTMLAreaElement'), FP = proto('HTMLFormElement'), BP = proto('HTMLButtonElement'), IP = proto('HTMLInputElement');
    var gType = getter(EP, 'type'), gCancelable = getter(EP, 'cancelable'), gPrevented = getter(EP, 'defaultPrevented'), gPhase = getter(EP, 'eventPhase');
    var gComposed = getter(EP, 'composed'), gBubbles = getter(EP, 'bubbles'), gTarget = getter(EP, 'target'), fPrevent = EP.preventDefault, fPath = EP.composedPath;
    var gView = getter(UP, 'view'), gDetail = getter(UP, 'detail'), gButton = getter(MP, 'button'), gButtons = getter(MP, 'buttons');
    var gCtrl = getter(MP, 'ctrlKey'), gMeta = getter(MP, 'metaKey'), gShift = getter(MP, 'shiftKey'), gAlt = getter(MP, 'altKey'), gRelated = getter(MP, 'relatedTarget');
    var MOUSE_COPY = ['screenX', 'screenY', 'clientX', 'clientY'], gMouse = nCreate(null);
    for (var mi = 0; mi < MOUSE_COPY.length; mi++) gMouse[MOUSE_COPY[mi]] = getter(MP, MOUSE_COPY[mi]);
    var gPointerType = getter(PP, 'pointerType'), gPointerId = getter(PP, 'pointerId'), gPrimary = getter(PP, 'isPrimary');
    var gKey = getter(KP, 'key'), gKCtrl = getter(KP, 'ctrlKey'), gKMeta = getter(KP, 'metaKey'), gKShift = getter(KP, 'shiftKey');
    var gSubmitter = getter(SP, 'submitter');
    var gNodeType = getter(NP, 'nodeType'), gParent = getter(NP, 'parentNode'), gOwner = getter(NP, 'ownerDocument'), gBaseURI = getter(NP, 'baseURI'), gConnected = getter(NP, 'isConnected');
    var gLocal = getter(EL, 'localName'), gNs = getter(EL, 'namespaceURI'), fGetAttr = EL.getAttribute, fGetAttrNS = EL.getAttributeNS, fSetAttr = EL.setAttribute;
    var fRemove = EL.remove, fTest = RegExp.prototype.test, SPEC_REL = /(^|\s)(prefetch|prerender)(\s|$)/i;
    var gElSlot = getter(EL, 'assignedSlot'), gTextSlot = getter(TP, 'assignedSlot'), gHost = getter(SRP, 'host');
    var gView2 = getter(DP, 'defaultView'), fQS = DP.querySelector, fQSA = DP.querySelectorAll, gNLLength = getter(NodeList.prototype, 'length');
    var gAHref = getter(AP, 'href'), gAreaHref = getter(ARP, 'href'), gAction = getter(FP, 'action');
    var gBtnType = getter(BP, 'type'), gBtnForm = getter(BP, 'form'), gBtnAction = getter(BP, 'formAction');
    var gInType = getter(IP, 'type'), gInForm = getter(IP, 'form'), gInAction = getter(IP, 'formAction');
    var gWinName = getter(W, 'name'), gWinLength = getter(W, 'length'), gTop = getter(W, 'top'), gDocument = getter(W, 'document');
    var gFrameWins = [getter(proto('HTMLIFrameElement'), 'contentWindow'), getter(proto('HTMLFrameElement'), 'contentWindow'), getter(proto('HTMLObjectElement'), 'contentWindow')];
    var fCharCode = String.prototype.charCodeAt, NURL = W.URL, gUrlHref = getter(NURL && NURL.prototype, 'href');
    var cons = W.console, fDebug = cons && cons.debug, NMO = W.MutationObserver, fObserve = NMO && NMO.prototype.observe, fDisconnect = NMO && NMO.prototype.disconnect;
    var nTimeout = W.setTimeout, NMouse = W.MouseEvent, NPointer = W.PointerEvent, NPromise = W.Promise, fReject = NPromise && NPromise.reject, NDOMException = W.DOMException;
    var fDispatch = ET.dispatchEvent, fClick = typeof HTMLElement === 'function' ? HTMLElement.prototype.click : null, fOpen = W.open, fDocOpen = DP.open;
    var fSubmit = FP && FP.submit, fRequestSubmit = FP && FP.requestSubmit;
    var HTML = 'http://www.w3.org/1999/xhtml', SVG = 'http://www.w3.org/2000/svg', XLINK = 'http://www.w3.org/1999/xlink';

    function report(url) {
      if (!POPUP_PREFIX) return;
      try { call(fDebug, cons, [POPUP_PREFIX + url]); } catch (e) {}
    }
    function prevent(e) { call(fPrevent, e, []); }
    // ASCII case-insensitive comparison with a lower-case literal (target keywords).
    function eqi(s, lit) {
      if (typeof s !== 'string' || s.length !== lit.length) return false;
      for (var i = 0; i < s.length; i++) {
        var c = call(fCharCode, s, [i]);
        if (c >= 65 && c <= 90) c += 32;
        if (c !== call(fCharCode, lit, [i])) return false;
      }
      return true;
    }
    function attr(el, name) { return call(fGetAttr, el, [name]); }
    function resolve(u, base) {
      try { return get(gUrlHref, new NURL(u, base)); } catch (e) { return u; }
    }
    function nameOf(w) { try { return get(gWinName, w); } catch (e) { return null; } }
    function framesOf(w) {
      try { return get(gWinLength, w); } catch (e) { try { return w.length; } catch (x) { return 0; } }
    }
    // Is there a frame (or window) of the page with this name? Searches from the top window down; the
    // name of a frame of another origin is read from its element. Unknown means no: a new window.
    function frameNamed(name, w) {
      var top = w;
      try { top = get(gTop, w); } catch (e) { try { top = w.top; } catch (x) {} }
      var q = nCreate(null), qn = 0, qi = 0;
      q[qn++] = top;
      while (qi < qn && qi < 300) {
        var cur = q[qi++], own = nameOf(cur);
        if (own === name) return true;
        var n = framesOf(cur);
        for (var i = 0; i < n && i < 100 && qn < 300; i++) {
          var child = null;
          try { child = cur[i]; } catch (e) {}
          if (child) q[qn++] = child;
        }
        if (own === null) continue; // another origin: its frames' elements are not readable
        var doc = null;
        try { doc = get(gDocument, cur); } catch (e) {}
        if (!doc) continue;
        var list = call(fQSA, doc, ['iframe, frame, object']), ln = get(gNLLength, list);
        for (var j = 0; j < ln && j < 200; j++) {
          var el = list[j], cw = null;
          for (var g = 0; g < gFrameWins.length && !cw; g++) { try { if (gFrameWins[g]) cw = get(gFrameWins[g], el); } catch (e) {} }
          if (cw && nameOf(cw) === null && attr(el, 'name') === name) return true;
        }
      }
      return false;
    }
    // Would navigating to this target (as read from the page) open a new window? An empty target is this window.
    function opensNew(target, w) {
      if (target === null || target === '') return false;
      if (eqi(target, '_self') || eqi(target, '_parent') || eqi(target, '_top')) return false;
      if (eqi(target, '_blank')) return true;
      return !frameNamed(target, w);
    }
    function winOf(node) {
      var doc = get(gOwner, node);
      return doc ? get(gView2, doc) : null;
    }
    // The document's base target: the first base element with a target attribute.
    function baseTarget(node) {
      var doc = get(gOwner, node), b = doc ? call(fQS, doc, ['base[target]']) : null;
      return b ? attr(b, 'target') : null;
    }
    // A target attribute that is missing or empty means the base target (as Chromium reads it).
    function targetOf(el, name) {
      var t = attr(el, name);
      return t === null || t === '' ? null : t;
    }
    function link(el) {
      var ln = get(gLocal, el), ns = get(gNs, el);
      if (ln === 'a' && ns === HTML) return 1;
      if (ln === 'area' && ns === HTML) return 2;
      if (ln === 'a' && ns === SVG) return 3;
      return 0;
    }
    function linkHref(el, kind) {
      if (kind === 3) {
        var h = attr(el, 'href');
        if (h === null) h = call(fGetAttrNS, el, [XLINK, 'href']);
        return h === null ? null : resolve(h, get(gBaseURI, el));
      }
      return attr(el, 'href') === null ? null : get(kind === 1 ? gAHref : gAreaHref, el);
    }
    function linkTarget(el, kind) {
      var t = targetOf(el, 'target');
      if (t === null && kind === 3 && call(fGetAttrNS, el, [XLINK, 'show']) === 'new') t = '_blank';
      return t === null ? baseTarget(el) : t;
    }
    // A submit button's form (null when it is not one, or has none).
    function submitForm(el) {
      if (get(gNs, el) !== HTML) return null;
      var ln = get(gLocal, el);
      if (ln === 'button') return get(gBtnType, el) === 'submit' ? get(gBtnForm, el) : null;
      if (ln === 'input') { var t = get(gInType, el); return t === 'submit' || t === 'image' ? get(gInForm, el) : null; }
      return null;
    }
    function candidate(el) {
      if (link(el)) return true;
      if (get(gNs, el) !== HTML) return false;
      var ln = get(gLocal, el);
      return ln === 'button' || ln === 'input';
    }
    function submitterAttr(sub, name) { return sub ? targetOf(sub, name) : null; }
    function formTarget(form, sub) {
      var t = submitterAttr(sub, 'formtarget');
      if (t === null) t = targetOf(form, 'target');
      return t === null ? baseTarget(form) : t;
    }
    function dialogForm(form, sub) {
      var m = submitterAttr(sub, 'formmethod');
      return eqi(m === null ? attr(form, 'method') : m, 'dialog');
    }
    function formUrl(form, sub) {
      if (sub && submitterAttr(sub, 'formaction') !== null) return get(get(gLocal, sub) === 'button' ? gBtnAction : gInAction, sub);
      return get(gAction, form);
    }
    // The address a form submission would open in a new window, or null.
    function formPopup(form, sub, mods) {
      var win = winOf(form);
      if (!win || dialogForm(form, sub)) return null;
      return mods || opensNew(formTarget(form, sub), win) ? formUrl(form, sub) : null;
    }
    // The address a click would open in a new window (following a link or submitting a form), or null.
    // Every link and submit button on its path counts, not only the nearest.
    function clickPopup(ev, path, len) {
      var type = get(gType, ev), aux = type === 'auxclick';
      if (type !== 'click' && !aux) return null;
      var button;
      try { button = get(gButton, ev); } catch (e) { return null; } // not a MouseEvent: no default action
      if (aux && button !== 1) return null;
      var middle = button === 1, mods = !!(get(gCtrl, ev) || get(gMeta, ev) || get(gShift, ev));
      for (var i = 0; i < len; i++) {
        var el = path[i];
        try { if (get(gNodeType, el) !== 1) continue; } catch (e) { continue; }
        // A document with no window (DOMParser, createHTMLDocument) navigates nothing.
        var win = winOf(el);
        if (!win) continue;
        var kind = link(el);
        if (kind) {
          var href = linkHref(el, kind);
          if (href !== null && (mods || middle || opensNew(linkTarget(el, kind), win))) return href;
          continue;
        }
        if (middle) continue;
        var form = submitForm(el);
        if (form) { var url = formPopup(form, el, mods); if (url !== null) return url; }
      }
      return null;
    }
    // A key that submits a form into a new window (shift, ctrl or cmd with Enter): it sets this for
    // the rest of its task, so the submit event it causes is cancelled.
    var keyMods = false;
    function submitPopup(ev) {
      var form = get(gTarget, ev);
      if (!form || get(gNodeType, form) !== 1 || get(gLocal, form) !== 'form') return null;
      var sub = null;
      try { if (gSubmitter) sub = get(gSubmitter, ev); } catch (e) {}
      return formPopup(form, sub, keyMods);
    }

    // --- Watching an event while it is dispatched ---
    var watches = nCreate(null), watchN = 0, watchSeq = 0, cleanup = false, mo = null;
    var MO_OPTS = nCreate(null);
    MO_OPTS.attributes = true; MO_OPTS.subtree = true; MO_OPTS.childList = true;
    try { if (NMO) mo = new NMO(function () { recheck(); }); } catch (e) {}
    function observe(node) { try { if (mo) call(fObserve, mo, [node, MO_OPTS]); } catch (e) {} }
    function drop(id) {
      if (!watches[id]) return;
      delete watches[id];
      if (--watchN === 0) { try { if (mo) call(fDisconnect, mo, []); } catch (e) {} }
    }
    function sweep() {
      cleanup = false;
      for (var k in watches) { try { if (watches[k].kind === 'submit' || get(gPhase, watches[k].ev) === 0) drop(k); } catch (e) { drop(k); } }
      if (watchN) queueSweep();
    }
    function queueSweep() { if (!cleanup) { cleanup = true; try { call(nTimeout, W, [sweep, 0]); } catch (e) { cleanup = false; } } }
    function watch(ev, path, len, kind, live) {
      for (var k in watches) if (watches[k].ev === ev) { drop(k); break; }
      if (watchN >= 50) return 0;
      var w = nCreate(null);
      w.ev = ev; w.path = path; w.len = len; w.kind = kind; w.live = live;
      var id = ++watchSeq;
      watches[id] = w;
      watchN++;
      try { observe(get(gOwner, path[0]) || path[0]); } catch (e) {}
      for (var i = 0; i < len; i++) { try { if (get(gNodeType, path[i]) === 1) observe(path[i]); } catch (e) {} }
      queueSweep();
      return id;
    }
    // Checks every watched event again (the page changed something while it was dispatched).
    function recheck() {
      for (var k in watches) {
        var w = watches[k];
        try {
          if (get(gPrevented, w.ev)) { drop(k); continue; }
          if (w.kind === 'submit') {
            var su = submitPopup(w.ev);
            if (su === null) continue;
            report(su);
            drop(k);
            // While the submit event is dispatched, cancelling it stops the submission. After it (a
            // formdata handler, which runs before the browser reads the target), the form's target is
            // set back to this window, so the submission is the same-tab one the request guard sees.
            if (get(gPhase, w.ev) !== 0) prevent(w.ev);
            else restoreTarget(w.ev);
            continue;
          }
          // Dispatched (not yet) or done; a watch made before dispatching counts as live.
          if (!w.live && get(gPhase, w.ev) === 0) { drop(k); continue; }
          var url = clickPopup(w.ev, w.path, w.len);
          if (url !== null) { prevent(w.ev); report(url); drop(k); }
        } catch (e) {}
      }
    }
    function restoreTarget(ev) {
      var form = get(gTarget, ev), sub = null;
      try { if (gSubmitter) sub = get(gSubmitter, ev); } catch (e) {}
      if (sub && submitterAttr(sub, 'formtarget') !== null) call(fSetAttr, sub, ['formtarget', '_self']);
      call(fSetAttr, form, ['target', '_self']);
    }

    // --- Listeners: on window (registered before any page script) and on each shadow root ---
    function onActivate(e) {
      try {
        if (get(gPrevented, e)) return;
        var type = get(gType, e);
        if (type === 'submit') {
          var su = submitPopup(e);
          if (su !== null) { prevent(e); report(su); } else watch(e, [get(gTarget, e)], 1, 'submit', false);
          return;
        }
        var path = call(fPath, e, []), len = path.length;
        var url = clickPopup(e, path, len);
        if (url !== null) { prevent(e); report(url); return; }
        for (var i = 0; i < len; i++) {
          try { if (get(gNodeType, path[i]) === 1 && candidate(path[i])) { watch(e, path, len, 'click', false); return; } } catch (x) {}
        }
      } catch (x) {}
    }
    function onKey(e) {
      try {
        if (get(gKey, e) === 'Enter' && (get(gKCtrl, e) || get(gKMeta, e) || get(gKShift, e))) {
          keyMods = true;
          call(nTimeout, W, [function () { keyMods = false; }, 0]);
        }
      } catch (x) {}
    }
    var ACTIVATE = ['click', 'auxclick', 'submit'];
    function listen(target) {
      for (var i = 0; i < ACTIVATE.length; i++) { try { origAdd.call(target, ACTIVATE[i], onActivate, true); } catch (e) {} }
    }
    listen(W);
    try { origAdd.call(W, 'keydown', onKey, true); } catch (e) {}
    try {
      var origAttach = EL.attachShadow;
      if (typeof origAttach === 'function') {
        replace(EL, 'attachShadow', function attachShadow() {
          var root = call(origAttach, this, arguments);
          listen(root);
          return root;
        }, origAttach);
      }
    } catch (e) {}

    // --- Script: window.open, document.open, Document Picture-in-Picture ---
    var openHook = function open(url, target, features) {
      var u = url === undefined ? '' : '' + url;
      var t = target === undefined ? '' : '' + target;
      var f = features === undefined ? undefined : '' + features;
      var fresh = true;
      try { fresh = t === '' || opensNew(t, W); } catch (e) {}
      if (!fresh) return call(fOpen, this == null ? W : this, f === undefined ? [u, t] : [u, t, f]);
      var doc = null;
      try { doc = get(gDocument, W); } catch (e) {}
      report(u === '' ? 'about:blank' : resolve(u, doc ? get(gBaseURI, doc) : undefined));
      return null;
    };
    // Patched where open lives (in Chromium the window's own property; the prototype chain is walked in
    // case it moves), and left configurable: the keyboard and forms probes wrap it again and call through.
    var openOwner = W;
    try { while (openOwner && !getDesc(openOwner, 'open')) openOwner = Object.getPrototypeOf(openOwner); } catch (e) { openOwner = W; }
    if (typeof fOpen === 'function' && openOwner) replace(openOwner, 'open', openHook, fOpen);
    if (typeof fDocOpen === 'function') {
      replace(DP, 'open', function open() {
        if (arguments.length > 2) return call(openHook, W, [arguments[0], arguments[1], arguments[2]]);
        return call(fDocOpen, this, arguments);
      }, fDocOpen);
    }
    try {
      var PIP = proto('DocumentPictureInPicture'), origPip = PIP && PIP.requestWindow;
      if (typeof origPip === 'function') {
        replace(PIP, 'requestWindow', function requestWindow() {
          report('about:blank');
          return call(fReject, NPromise, [new NDOMException('Opening a window is not allowed.', 'NotAllowedError')]);
        }, origPip);
      }
    } catch (e) {}

    // --- Script: clicks the window does not see or cannot cancel ---
    // The event path from a node, as the browser builds it (open shadow roots and slots): whether it
    // reaches a window, and whether it holds a link or a form control.
    function pathFrom(node, composed) {
      var nodes = nCreate(null), len = 0, n = node, win = false, cand = false;
      while (n && len < 4096) {
        nodes[len++] = n;
        var nt = get(gNodeType, n), next = null;
        if (nt === 1) {
          if (!cand && candidate(n)) cand = true;
          next = get(gElSlot, n);
        } else if (nt === 3 && gTextSlot) {
          next = get(gTextSlot, n);
        } else if (nt === 9) {
          win = !!get(gView2, n);
          break;
        } else if (nt === 11) {
          var host = null;
          try { host = get(gHost, n); } catch (e) {}
          if (host) { if (!composed) break; n = host; continue; }
        }
        n = next || get(gParent, n);
      }
      var p = nCreate(null);
      p.nodes = nodes; p.len = len; p.win = win; p.cand = cand;
      return p;
    }
    function clickInit(src) {
      var d = nCreate(null);
      d.bubbles = true; d.cancelable = true; d.composed = true; d.view = W; d.detail = 1;
      if (src) {
        d.bubbles = get(gBubbles, src); d.composed = get(gComposed, src); d.view = get(gView, src); d.detail = get(gDetail, src);
        for (var i = 0; i < MOUSE_COPY.length; i++) d[MOUSE_COPY[i]] = get(gMouse[MOUSE_COPY[i]], src);
        d.ctrlKey = get(gCtrl, src); d.shiftKey = get(gShift, src); d.altKey = get(gAlt, src); d.metaKey = get(gMeta, src);
        d.button = get(gButton, src); d.buttons = get(gButtons, src); d.relatedTarget = get(gRelated, src);
      }
      return d;
    }
    // A cancelable copy of a click (a PointerEvent stays one).
    function cancelableCopy(src) {
      var d = clickInit(src), pointer = false;
      try { if (gPointerType && NPointer) { d.pointerType = get(gPointerType, src); d.pointerId = get(gPointerId, src); d.isPrimary = get(gPrimary, src); pointer = true; } } catch (e) {}
      return pointer ? new NPointer(get(gType, src), d) : new NMouse(get(gType, src), d);
    }
    // Dispatches ev (a click) on target, watched, or cancelled when it would open a window.
    function dispatchChecked(target, ev, p) {
      var url = clickPopup(ev, p.nodes, p.len), id = 0;
      if (url !== null) { prevent(ev); report(url); } else if (!p.win) id = watch(ev, p.nodes, p.len, 'click', true);
      try { return call(fDispatch, target, [ev]); } finally { if (id) drop(id); }
    }
    if (typeof fDispatch === 'function') {
      replace(ET, 'dispatchEvent', function dispatchEvent(ev) {
        var p = null, copy = null;
        try {
          var type = get(gType, ev);
          if (type === 'click' || type === 'auxclick') {
            get(gNodeType, this); // a Node (else: not a link, the browser decides as usual)
            p = pathFrom(this, get(gComposed, ev));
            // One that cannot be cancelled is never delivered as it is, on any node: a link our path
            // misses would still be followed. One in a page with a window: its listener checks it.
            if (!get(gCancelable, ev)) copy = cancelableCopy(ev);
            else if (!p.cand || p.win) p = null;
          }
        } catch (e) { p = null; }
        if (!p) return call(fDispatch, this, arguments);
        if (copy) { dispatchChecked(this, copy, p); return true; }
        return dispatchChecked(this, ev, p);
      }, fDispatch);
    }
    if (typeof fClick === 'function') {
      replace(HTMLElement.prototype, 'click', function click() {
        var p = null, ev = null;
        try {
          p = pathFrom(this, true);
          // In a page, the window's listener checks the click. A link that is not in one would still be followed.
          if (p.win || !p.cand) p = null;
          else ev = NPointer ? new NPointer('click', clickInit(null)) : new NMouse('click', clickInit(null));
        } catch (e) { p = null; }
        if (!p) return call(fClick, this, arguments);
        dispatchChecked(this, ev, p);
        return undefined;
      }, fClick);
    }
    // form.submit() fires no event; requestSubmit() fires one the window does not see in a shadow root.
    if (typeof fSubmit === 'function') {
      replace(FP, 'submit', function submit() {
        var url = null;
        try { url = formPopup(this, null, false); } catch (e) {}
        if (url !== null) { report(url); return undefined; }
        reportForm(this, null); // never sent, only reported (see "Forms are never sent" below)
        return undefined;
      }, fSubmit);
    }
    if (typeof fRequestSubmit === 'function') {
      replace(FP, 'requestSubmit', function requestSubmit(submitter) {
        var url = null;
        try { if (get(gConnected, this) && !pathFrom(this, false).win) url = formPopup(this, submitter == null ? null : submitter, false); } catch (e) {}
        if (url !== null) { report(url); return undefined; }
        fakeRequestSubmit(this, submitter);
        return undefined;
      }, fRequestSubmit);
    }

    // --- Changes the page makes while a watched event is dispatched ---
    // Only attributes that decide where a click or a form goes (or whether a frame by that name exists).
    var RELEVANT = ['target', 'formtarget', 'href', 'xlink:href', 'xlink:show', 'type', 'method', 'formmethod', 'action', 'formaction', 'name'];
    var gAttrName = getter(proto('Attr'), 'name');
    function relevant(name) {
      if (typeof name !== 'string') return true;
      for (var i = 0; i < RELEVANT.length; i++) if (eqi(name, RELEVANT[i])) return true;
      return false;
    }
    // which: the index of the argument naming the attribute, 'attr' for an Attr argument, 'node' for
    // a Node setter (an Attr's value only), or undefined (always).
    function rechecking(orig, which) {
      return function () {
        var r = call(orig, this, arguments);
        if (which === 'markup' || which === 'outer') {
          try { defuse(which === 'outer' ? (get(gParent, this) || this) : this); } catch (e) {}
        }
        if (watchN) {
          var go = true;
          try {
            if (which === 'node') go = get(gNodeType, this) === 2 && relevant(get(gAttrName, this));
            else if (which === 'attr') go = relevant(get(gAttrName, arguments[0]));
            else if (typeof which === 'number') go = relevant(arguments[which]); // not a string: always
          } catch (e) { go = true; }
          if (go) recheck();
        }
        return r;
      };
    }
    function hookMethods(o, names) {
      if (!o) return;
      for (var i = 0; i < names.length; i += 2) {
        var orig = o[names[i]];
        if (typeof orig === 'function') replace(o, names[i], rechecking(orig, names[i + 1]), orig);
      }
    }
    // markup: after the call, the element (or, for outerHTML, its parent) is defused; nodes: each node
    // argument is defused before the call. Both recheck watched events at the end, as rechecking does.
    function hookInsertions(o, names, markup) {
      if (!o) return;
      for (var i = 0; i < names.length; i++) {
        (function (name) {
          var orig = o[name];
          if (typeof orig !== 'function') return;
          replace(o, name, function () {
            if (!markup) for (var j = 0; j < arguments.length; j++) defuse(arguments[j]);
            var r = call(orig, this, arguments);
            if (markup) defuse(this);
            if (watchN) recheck();
            return r;
          }, orig);
        })(names[i]);
      }
    }
    function hookSetters(o, names, which) {
      if (!o) return;
      for (var i = 0; i < names.length; i++) {
        try {
          var d = getDesc(o, names[i]);
          if (!d || !d.set || !d.configurable) continue;
          var s = rechecking(d.set, which);
          masks.set(s, d.set);
          try { defineProp(s, 'name', { value: d.set.name }); } catch (e) {}
          defineProp(o, names[i], { get: d.get, set: s, enumerable: d.enumerable, configurable: true });
        } catch (e) {}
      }
    }
    hookMethods(EL, ['setAttribute', 0, 'setAttributeNS', 1, 'removeAttribute', 0, 'removeAttributeNS', 1, 'toggleAttribute', 0,
      'setAttributeNode', 'attr', 'setAttributeNodeNS', 'attr', 'removeAttributeNode', 'attr']);
    hookMethods(proto('NamedNodeMap'), ['setNamedItem', 'attr', 'setNamedItemNS', 'attr', 'removeNamedItem', 0, 'removeNamedItemNS', 1]);
    hookSetters(proto('Attr'), ['value'], 'node');
    hookSetters(NP, ['nodeValue', 'textContent'], 'node');
    hookSetters(AP, ['target', 'href']);
    hookSetters(ARP, ['target', 'href']);
    hookSetters(FP, ['target', 'method', 'action']);
    hookSetters(BP, ['formTarget', 'formMethod', 'formAction', 'type']);
    hookSetters(IP, ['formTarget', 'formMethod', 'formAction', 'type']);
    hookSetters(proto('HTMLBaseElement'), ['target']);
    hookSetters(proto('HTMLIFrameElement'), ['name']);
    hookSetters(proto('SVGAnimatedString'), ['baseVal']);
    // Inserting markup or nodes (a base element, a wrapping link) is checked at the end of each call
    // too: a script-dispatched click or a formdata handler gives the MutationObserver no turn.
    // Each also defuses a speculative load it would add (see below) before the browser sees it.
    hookInsertions(NP, ['appendChild', 'insertBefore', 'replaceChild'], false);
    hookInsertions(EL, ['insertAdjacentElement', 'append', 'prepend', 'before', 'after', 'replaceWith', 'replaceChildren'], false);
    hookInsertions(EL, ['insertAdjacentHTML', 'setHTMLUnsafe'], true);
    hookInsertions(DP, ['append', 'prepend', 'replaceChildren'], false);
    hookMethods(DP, ['write', undefined, 'writeln', undefined]);
    hookSetters(EL, ['innerHTML'], 'markup');
    hookSetters(EL, ['outerHTML'], 'outer');
    hookSetters(SRP, ['innerHTML'], 'markup');

    // --- Speculative loads: the browser makes them by itself, outside the request guard ---
    // A speculation-rules script or a prefetch/prerender link is taken out of the page as soon as it is
    // added (the browser has not acted on it yet when the observer runs; checked in Chromium for rules
    // in the HTML and added by script). The sandbox drops the Speculation-Rules and Link headers.
    // Strips what makes an element a speculative load: a link's prefetch/prerender tokens, a
    // speculation-rules script's type. In the node and, for an element or fragment, below it.
    var SPEC_SEL = 'link[rel], script[type]', fQSAEl = EL.querySelectorAll, fQSAFrag = proto('DocumentFragment') && proto('DocumentFragment').querySelectorAll;
    function defuseOne(n) {
      if (!speculative(n)) return;
      if (get(gLocal, n) === 'script') { call(fSetAttr, n, ['type', 'text/plain']); return; }
      var rel = attr(n, 'rel'), words = rel.split(/\s+/), keep = '';
      for (var i = 0; i < words.length; i++) { if (words[i] && !call(fTest, SPEC_REL, [words[i]])) keep += (keep ? ' ' : '') + words[i]; }
      call(fSetAttr, n, ['rel', keep]);
    }
    function defuse(n) {
      try {
        var nt = get(gNodeType, n);
        if (nt === 1) defuseOne(n);
        if (nt !== 1 && nt !== 11 && nt !== 9) return;
        var list = call(nt === 1 ? fQSAEl : nt === 11 ? fQSAFrag : fQSA, n, [SPEC_SEL]), ln = get(gNLLength, list);
        for (var i = 0; i < ln && i < 500; i++) defuseOne(list[i]);
      } catch (e) {}
    }
    function speculative(n) {
      try {
        if (get(gNodeType, n) !== 1 || get(gNs, n) !== HTML) return false;
        var ln = get(gLocal, n);
        if (ln === 'script') return eqi(attr(n, 'type'), 'speculationrules');
        if (ln !== 'link') return false;
        var rel = attr(n, 'rel');
        return typeof rel === 'string' && call(fTest, SPEC_REL, [rel]);
      } catch (e) { return false; }
    }
    try {
      if (NMO) {
        var specMo = new NMO(function (records) {
          for (var i = 0; i < records.length; i++) {
            var added = records[i].type === 'childList' ? records[i].addedNodes : null, t = records[i].target;
            if (added) for (var j = 0; j < added.length; j++) { if (speculative(added[j])) call(fRemove, added[j], []); }
            else if (speculative(t)) call(fRemove, t, []);
          }
        });
        var SPEC_OPTS = nCreate(null);
        SPEC_OPTS.childList = true; SPEC_OPTS.subtree = true; SPEC_OPTS.attributes = true; SPEC_OPTS.attributeFilter = ['rel', 'type'];
        call(fObserve, specMo, [document, SPEC_OPTS]);
      }
    } catch (e) {}
    return { watching: function () { return watchN; } };
  })();

  // on* properties (el.onclick = fn). On window they are own properties; elsewhere on the prototypes.
  function patchOn(o) {
    var names = Object.getOwnPropertyNames(o);
    for (var i = 0; i < names.length; i++) {
      (function (name) {
        if (name.slice(0, 2) !== 'on' || !TYPES.has(name.slice(2))) return;
        var d = getDesc(o, name);
        if (!d || !d.set || !d.configurable) return;
        var type = name.slice(2), set = d.set;
        var setter = function (v) {
          try {
            var t = this == null ? W : this;
            if (tracked(t)) {
              forget(t, type, null, false, 'property');
              if (typeof v === 'function' && total < MAX_RECORDS) {
                listOf(t).push({ type: type, listener: v, capture: false, passive: false, via: 'property' });
                total++;
              }
            }
          } catch (e) {}
          return set.call(this, v);
        };
        masks.set(setter, set);
        try { defineProp(setter, 'name', { value: set.name }); } catch (e) {}
        defineProp(o, name, { get: d.get, set: setter, enumerable: d.enumerable, configurable: true });
      })(names[i]);
    }
  }
  var protos = [W, typeof Window === 'function' ? Window.prototype : null, typeof HTMLElement === 'function' ? HTMLElement.prototype : null,
    typeof SVGElement === 'function' ? SVGElement.prototype : null, typeof Document === 'function' ? Document.prototype : null];
  for (var p = 0; p < protos.length; p++) { if (protos[p]) { try { patchOn(protos[p]); } catch (e) {} } }

  // --- Timers, calls and audio -------------------------------------------------------------------
  var timers = [], timerKeys = new Map(), calls = [], current = -1, changeWatch = null;
  // What timers' own callbacks changed while a probe watches (__grntedTimerWrote): the element, when, and when
  // that timer was set. The newest MAX_WRITES are kept.
  var timerWrites = [], MAX_WRITES = 300;
  function noteWrites(recs, setAt) {
    try {
      var now = timerNow(), seen = [];
      for (var i = 0; i < recs.length && seen.length < 40; i++) {
        var t = recs[i].target, el = t && t.nodeType === 1 ? t : t && t.parentElement;
        if (el && seen.indexOf(el) < 0) seen.push(el);
      }
      for (var k = 0; k < seen.length; k++) timerWrites.push({ el: seen[k], at: now, set: setAt });
      if (timerWrites.length > MAX_WRITES) timerWrites.splice(0, timerWrites.length - MAX_WRITES);
    } catch (x) {}
  }
  // Timer stamps are on the page's monotonic clock (review r5 of fix/late-mount): a wall-clock correction
  // (Date.now jumping) must never read as time a timer ran. Call stamps (below) stay wall-clock time.
  var perf = W.performance, perfNow = perf.now, timerNow = function () { return perfNow.call(perf); };
  var sources = new WeakMap();
  // Timers of at least MIN_TIMER that have not fired or been cleared yet, by handle. A probe can run
  // one's callback now (window.__grntedFire), as if its time had come: a timeout is then cancelled
  // (so the page's own bookkeeping, e.g. a chain of timeouts it can clear, stays right); an interval
  // keeps running.
  var MAX_PENDING = 300, pending = new Map(), firing = 0, origSetTimeout = W.setTimeout, origClearTimeout = W.clearTimeout;
  // __grntedFreeze: while on, the callbacks of these timers do not run. A timeout's call waits (in
  // order) until the freeze ends, none is ever lost; an interval's ticks are skipped (it ticks again later).
  var frozen = false, held = [], MAX_HELD = 300;
  function sourceInfo(h) {
    if (typeof h !== 'function') { var s0 = String(h); return { length: s0.length, snippet: s0.replace(/\s+/g, ' ').slice(0, 120) }; }
    var info = sources.get(h);
    if (!info) {
      var s = '';
      try { s = nativeToString.call(h); } catch (e) {}
      info = { length: s.length, snippet: s.slice(0, 400).replace(/\s+/g, ' ').slice(0, 120) };
      sources.set(h, info);
    }
    return info;
  }
  function wrapTimer(kind, name) {
    var orig = W[name];
    if (typeof orig !== 'function') return;
    var hook = function (handler) {
      var args = Array.prototype.slice.call(arguments);
      try {
        var delay = Number(args[1]) || 0;
        if (delay >= MIN_TIMER) {
          var info = sourceInfo(handler);
          var key = kind + '|' + delay + '|' + info.snippet;
          var idx = timerKeys.get(key);
          if (idx === undefined && timers.length < MAX_TIMERS) {
            idx = timers.length;
            timers.push({ kind: kind, delay: delay, count: 0, fired: 0, firstAt: timerNow(), sourceLength: info.length, snippet: info.snippet });
            timerKeys.set(key, idx);
          }
          if (idx !== undefined) {
            timers[idx].count++;
            if (typeof handler === 'function') {
              var i2 = idx, entry = null;
              args[0] = function () {
                if (frozen && !firing) {
                  if (kind === 'timeout') {
                    var hs = this, ha = Array.prototype.slice.call(arguments), hf = args[0];
                    if (held.length < MAX_HELD) held.push({ fn: hf, self: hs, args: ha });
                    // The list is full: this one waits on its own (checked again shortly), so it still runs once the hold ends.
                    else { try { origSetTimeout.call(W, function () { hf.apply(hs, ha); }, 250); } catch (x) {} }
                  }
                  return;
                }
                var e = timers[i2], prev = current;
                try { e.fired++; e.lastFiredAt = timerNow(); } catch (x) {}
                try { if (kind === 'timeout' && !firing && entry) pending.delete(entry.handle); } catch (x) {}
                current = i2;
                // While a probe watches (__grntedTimerChanges), the DOM changes this run makes itself
                // (synchronously, in its own callback) are stamped on its timer: another script's writes
                // never are. The probe's own early runs (firing) are not stamped.
                var watching = changeWatch && !firing;
                if (watching) { try { changeWatch.takeRecords(); } catch (x) {} }
                try { return handler.apply(this, arguments); } finally {
                  current = prev;
                  if (watching) { try { var recs = changeWatch.takeRecords(); if (recs.length) { e.lastChangeAt = timerNow(); noteWrites(recs, entry ? entry.at : e.firstAt); } } catch (x) {} }
                }
              };
              var h = orig.apply(this, args);
              try {
                if (pending.size < MAX_PENDING) {
                  entry = { handle: h, kind: kind, delay: delay, timer: idx, at: timerNow(), fn: args[0], args: args.slice(2) };
                  pending.set(h, entry);
                }
              } catch (x) {}
              return h;
            }
            var hs = orig.apply(this, args);
            try {
              // A string handler cannot be wrapped (that would need eval); it is fired with a 0 ms timer.
              if (pending.size < MAX_PENDING) pending.set(hs, { handle: hs, kind: kind, delay: delay, timer: idx, at: timerNow(), fn: String(handler), args: [] });
            } catch (x) {}
            return hs;
          }
        }
      } catch (e) {}
      return orig.apply(this, args);
    };
    replace(W, name, hook, orig);
  }
  wrapTimer('timeout', 'setTimeout');
  wrapTimer('interval', 'setInterval');
  ['clearTimeout', 'clearInterval'].forEach(function (name) {
    var orig = W[name];
    if (typeof orig !== 'function') return;
    // Browsers share one handle pool, so either function clears either kind of timer.
    replace(W, name, function (h) { try { pending.delete(h); } catch (e) {} return orig.apply(this, arguments); }, orig);
  });
  function pendingList() {
    var out = [], now = timerNow();
    pending.forEach(function (p) {
      // A string timeout is not wrapped, so its firing is not seen: drop it once it is due.
      if (typeof p.fn === 'string' && p.kind === 'timeout' && now >= p.at + p.delay) { pending.delete(p.handle); return; }
      var t = timers[p.timer];
      out.push({ handle: p.handle, kind: p.kind, delay: p.delay, timer: p.timer, at: p.at, snippet: t ? t.snippet : '', string: typeof p.fn === 'string' });
    });
    return out;
  }
  function cancel(h) {
    var p = pending.get(h);
    if (!p) return false;
    if (p.kind === 'timeout') {
      pending.delete(h);
      try { origClearTimeout.call(W, h); } catch (e) {}
    }
    return true;
  }
  // keep: run the callback but leave a timeout pending (cancel it later, or let it fire).
  function fire(h, keep) {
    var p = pending.get(h);
    if (!p) return { ok: false, error: 'not pending' };
    if (!keep) cancel(h);
    if (typeof p.fn === 'string') {
      try { origSetTimeout.call(W, p.fn, 0); return { ok: true, async: true }; } catch (e) { return { ok: false, error: String(e && e.name || e) }; }
    }
    firing++;
    try { p.fn.apply(W, p.args); return { ok: true }; } catch (e) { return { ok: true, error: String(e && e.message || e).slice(0, 160) }; } finally { firing--; }
  }

  function freeze(on) {
    if (on) { frozen = true; return held.length; }
    frozen = false;
    var due = held;
    held = [];
    for (var i = 0; i < due.length; i++) {
      (function (d) { try { origSetTimeout.call(W, function () { d.fn.apply(d.self, d.args); }, 0); } catch (e) {} })(due[i]);
    }
    return due.length;
  }

  function recordCall(api) {
    try {
      if (calls.length < MAX_CALLS) {
        var c = { api: api, at: Date.now() };
        if (current >= 0) c.timer = current;
        calls.push(c);
        return c;
      }
    } catch (e) {}
    return null;
  }
  // What a script-made submit is of (for the timing tests): how many fields a visitor fills the form shows,
  // whether it would have been sent (the page's own handler did not stop it), whether sending it would have
  // replaced this page (it targets this window, not a frame or a new one), and the form's words.
  // The effective submission (Sol r1 S4, as reportForm reads it): the submitter's formmethod and formtarget first, then
  // the form's, then the document's <base target>; method="dialog" closes a dialog and sends nothing.
  function formFacts(form, sent, sub) {
    try {
      var attrOf = function (el, a) { return el && el.hasAttribute && el.hasAttribute(a) ? el.getAttribute(a) : null; };
      var method = String(attrOf(sub, 'formmethod') !== null ? attrOf(sub, 'formmethod') : form.getAttribute('method') || 'get').toLowerCase();
      if (method === 'dialog') sent = false;
      var n = 0, els = form.elements || [];
      for (var i = 0; i < els.length && i < 400; i++) {
        var e = els[i], tag = e.localName, type = String(e.type || '').toLowerCase();
        if (tag !== 'input' && tag !== 'select' && tag !== 'textarea') continue;
        if (tag === 'input' && /^(hidden|submit|button|reset|image)$/.test(type)) continue;
        if (e.getClientRects && e.getClientRects().length) n++;
      }
      var tg = attrOf(sub, 'formtarget');
      if (tg === null) tg = form.getAttribute('target');
      if (!tg) { var base = form.ownerDocument && form.ownerDocument.querySelector('base[target]'); if (base) tg = base.getAttribute('target'); }
      var t = String(tg || '').toLowerCase();
      var here = t === '' || t === '_self' || t === '_top' || t === '_parent';
      return { fields: n, sent: !!sent, page: !!sent && here && W === W.top, text: String(form.innerText || form.textContent || '').replace(/\s+/g, ' ').slice(0, 600) };
    } catch (e) { return undefined; }
  }
  ['alert', 'confirm', 'prompt', 'open'].forEach(function (api) {
    var orig = W[api];
    if (typeof orig !== 'function') return;
    replace(W, api, function () { recordCall(api); return orig.apply(this, arguments); }, orig);
  });
  // --- Forms are never sent while a scan runs (Plan 4 rule 1) -------------------------------------
  // form.submit() and requestSubmit() are recorded and their native methods never run: requestSubmit
  // checks the fields and fires a submit event as the browser does (a synthetic one, which sends
  // nothing). A trusted submit event (a test pressing a submit button or Enter, or the page clicking
  // one) is recorded on window in the capture phase, before any page listener, and cancelled at the
  // end of bubbling, after delegated page handlers have run, so
  // whether the PAGE stopped it is kept apart (__grntedSubmitStopped(ev)): the form tests still tell a
  // page that checks its fields from one that would send them. A page that stops the event before it
  // reaches the canceller relies on the request guard's navigation and action rules. Strict mode
  // blocks every request once a probe types; the page's own visitor-level GETs are allowed (guard.ts).
  var submitStops = new WeakMap(), nPrevent = Event.prototype.preventDefault;
  var fConsole = W.console, fFormDebug = fConsole && fConsole.debug, nStringify = JSON.stringify;
  // A submission the hook cancelled (the page did not stop it) is reported as what it would have been,
  // so the request guard logs it as it would have (a write blocked, a navigation held, a frame kept) and
  // a test still knows its press would have sent a form: console.debug(FORM_PREFIX + JSON).
  function reportForm(form, sub) {
    if (!FORM_PREFIX || !form || !form.isConnected) return; // a form not in a document submits nothing
    try {
      var attrOf = function (el, n) { return el && el.hasAttribute && el.hasAttribute(n) ? el.getAttribute(n) : null; };
      var method = String(attrOf(sub, 'formmethod') !== null && sub.formMethod ? sub.formMethod : form.method || 'get').toLowerCase();
      if (method === 'dialog') return; // closes a dialog, sends nothing
      var url = attrOf(sub, 'formaction') !== null && sub.formAction ? sub.formAction : form.action;
      var target = attrOf(sub, 'formtarget');
      if (target === null) target = form.target || '';
      if (!target) { var base = form.ownerDocument && form.ownerDocument.querySelector('base[target]'); if (base) target = base.getAttribute('target') || ''; }
      var t = target.toLowerCase();
      var top = W === W.top;
      // Where it would have loaded: this window (a frame unless this is the top), the top, or a frame by name.
      var frame = t === '' || t === '_self' ? !top : t === '_top' ? false : t === '_parent' ? W.parent !== W.top : true;
      fFormDebug.call(fConsole, FORM_PREFIX + nStringify({ method: method.toUpperCase(), url: String(url), frame: frame }));
    } catch (e) {}
  }
  var gDefaultPrevented = (function () { try { var d = getDesc(Event.prototype, 'defaultPrevented'); return d && d.get; } catch (e) { return null; } })();
  var prevented = function (e) { try { return gDefaultPrevented ? !!gDefaultPrevented.call(e) : !!e.defaultPrevented; } catch (x) { return false; } };
  // Whether the page let each requestSubmit through (it would have been sent), per invocation (Sol r1 S5): each call of
  // the wrappers below pushes its own record, so a nested requestSubmit (an outer handler that stops its own submit and
  // requests another form's) never speaks for the outer one.
  var submitStack = [];
  function fakeRequestSubmit(form, submitter) {
    var own = submitStack.length ? submitStack[submitStack.length - 1] : null;
    if (own) own.sent = false;
    try {
      var skip = form.noValidate || !!(submitter && submitter.formNoValidate);
      if (!skip && !form.reportValidity()) return;
      var ev;
      try { ev = new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: submitter || null }); } catch (e) { ev = new Event('submit', { bubbles: true, cancelable: true }); }
      // Not stopped by the page: it would have been sent, so it is reported as such (never sent).
      if (form.dispatchEvent(ev)) { reportForm(form, submitter || null); if (own) own.sent = true; }
    } catch (e) {}
  }
  if (typeof HTMLFormElement === 'function') {
    ['submit', 'requestSubmit'].forEach(function (api) {
      var FP = HTMLFormElement.prototype, orig = FP[api];
      if (typeof orig !== 'function') return;
      // The popup blocker's wrapper (below it) reports a submission into a new window and sends nothing;
      // without it (it could not be installed) the native method is never called here either.
      var popupChecked = masks.has(orig);
      replace(FP, api, function () {
        var c = recordCall(api);
        if (hold.on) { hold.submits++; return undefined; } // the pointer probes' canceller is on: no event either
        var mine = { sent: null };
        submitStack.push(mine);
        var r;
        try {
          if (popupChecked) r = orig.apply(this, arguments);
          else if (api === 'requestSubmit') fakeRequestSubmit(this, arguments[0]);
          else reportForm(this, null);
        } finally { submitStack.pop(); }
        // form.submit() asks no handler; requestSubmit() is sent unless the form's fields or a handler stopped it.
        try { if (c) c.form = formFacts(this, api === 'submit' || mine.sent !== false, api === 'requestSubmit' ? arguments[0] || null : null); } catch (e) {}
        return r;
      }, masks.get(orig) || orig);
    });
  }
  function onSubmitCapture(e) {
      try {
        if (!e.isTrusted || !e.cancelable) return; // a synthetic submit event sends nothing
        if (submitStops.has(e)) return;
        var st = { page: false, cancelled: false };
        submitStops.set(e, st);
        // Already cancelled here, before any page listener: by the hook's own blockers.
        if (prevented(e)) return;
        // The page's own calls after the cancel below still count as the page stopping it.
        try {
          var pd = function preventDefault() { st.page = true; return nPrevent.call(e); };
          masks.set(pd, nPrevent);
          defineProp(e, 'preventDefault', { value: pd, writable: true, enumerable: false, configurable: true });
          defineProp(e, 'returnValue', { get: function () { return !prevented(e); }, set: function (v) { if (!v) { st.page = true; nPrevent.call(e); } }, enumerable: false, configurable: true });
        } catch (x) {}
        var fin = function (event) {
          if (event !== e) return;
          try { origRemove.call(root, 'submit', fin); } catch (x) {}
          if (st.cancelled) return;
          try { if (prevented(e)) st.page = true; nPrevent.call(e); } catch (x) {}
          st.cancelled = true;
        };
        var root = e.currentTarget, form = e.target, sub = e.submitter || null;
        try { origAdd.call(root, 'submit', fin); } catch (x) {}
        // A task, not a microtask: every handler (including delegated document/window handlers) has
        // finished dispatch before we decide whether the page cancelled. The native cancellation
        // above is kept separate from the page's preventDefault/returnValue calls.
        origSetTimeout.call(W, function () {
          try { origRemove.call(root, 'submit', fin); } catch (x) {}
          if (!st.cancelled && prevented(e)) st.page = true;
          if (!st.page) reportForm(form, sub);
        }, 0);
      } catch (x) {}
  }
  try { origAdd.call(W, 'submit', onSubmitCapture, true); } catch (e) {}
  // Submit does not leave a shadow root. Declarative roots bypass attachShadow, including roots
  // parsed before this hook and hosts inserted later; watch each discovered root for nested hosts.
  var submitRoots = new WeakSet();
  function findSubmitRoots(node) {
    try {
      if (node.shadowRoot) listenSubmitRoot(node.shadowRoot);
      var els = node.querySelectorAll ? node.querySelectorAll('*') : [];
      for (var i = 0; i < els.length; i++) if (els[i].shadowRoot) listenSubmitRoot(els[i].shadowRoot);
    } catch (e) {}
  }
  var submitObserver = new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      try { if (records[i].target.shadowRoot) listenSubmitRoot(records[i].target.shadowRoot); } catch (e) {}
      for (var j = 0; j < records[i].addedNodes.length; j++) findSubmitRoots(records[i].addedNodes[j]);
    }
  });
  function listenSubmitRoot(root) {
    if (submitRoots.has(root)) return;
    submitRoots.add(root);
    origAdd.call(root, 'submit', onSubmitCapture, true);
    submitObserver.observe(root, { childList: true, subtree: true });
    findSubmitRoots(root);
  }
  submitObserver.observe(document, { childList: true, subtree: true });
  findSubmitRoots(document);
  // Hosts of closed shadow roots made by a script (a declarative closed root is not seen): what they show cannot be
  // read by in-page tests, which then leave it undecided (the keyboard test's 2.1.1, fix round 2).
  var closedHosts = new WeakSet();
  try {
    var EL2 = Element.prototype, attachPrev = EL2.attachShadow;
    if (typeof attachPrev === 'function') {
      replace(EL2, 'attachShadow', function attachShadow() {
        var root = attachPrev.apply(this, arguments);
        try { listenSubmitRoot(root); } catch (e) {}
        try { if (root && root.mode === 'closed') closedHosts.add(this); } catch (e) {}
        return root;
      }, masks.get(attachPrev) || attachPrev);
    }
  } catch (e) {}

  // Whether an input event (a click, a press, a key) is being dispatched now: what the page does then is the
  // visitor's doing, not something that plays by itself (1.4.2). Set only while its handlers run, synchronously.
  var INPUT_EVENTS = { click: 1, pointerdown: 1, pointerup: 1, mousedown: 1, mouseup: 1, touchstart: 1, touchend: 1, keydown: 1, keyup: 1, change: 1, input: 1 };
  // Inside a shadow tree window.event is undefined (the DOM standard): a composed input event is also seen by the
  // window's capture listener first and its bubble listener last, and a handler that stops it leaves the mark until
  // the next task. Only for clicks, keys, change and input: with window listeners for pointer, mouse and touch events
  // too, the request guard could not settle the page's load on a page with speculative loads (sandbox auto), so every
  // test of that page was not run (guardLayers "nothing speculative is ever requested"; bisected 2026-11-13). Their
  // handlers in the light DOM are still seen through window.event.
  var inputDepth = 0, SHADOW_INPUT = ['click', 'keydown', 'keyup', 'change', 'input'];
  try {
    SHADOW_INPUT.forEach(function (type) {
      // The unwrapped addEventListener: the hook's own listeners are never recorded as the page's.
      origAdd.call(W, type, function (e) { if (!e.composed) return; inputDepth++; try { origSetTimeout.call(W, function () { inputDepth = 0; }, 0); } catch (x) {} }, true);
      origAdd.call(W, type, function (e) { if (e.composed && inputDepth > 0) inputDepth--; }, false);
    });
  } catch (e) {}
  function inInput() { try { var e = W.event; return (!!e && INPUT_EVENTS[e.type] === 1) || inputDepth > 0; } catch (x) { return false; } }
  var audioCreated = 0, audioCtxs = [], ctxByInput = new WeakSet();
  try {
    var AC = W.AudioContext;
    if (typeof AC === 'function') {
      var Hooked = class AudioContext extends AC {
        constructor() {
          super(...arguments);
          try { audioCreated++; if (audioCtxs.length < MAX_AUDIO) audioCtxs.push(this); if (inInput()) ctxByInput.add(this); } catch (e) {}
        }
      };
      replace(W, 'AudioContext', Hooked, AC);
      if (W.webkitAudioContext === AC) replace(W, 'webkitAudioContext', Hooked, AC);
    }
  } catch (e) {}

  // Sound sources for the audio probe: media elements the page called play() on (also ones never
  // added to the document), Web Audio nodes connected to a speaker, and contexts the page suspended.
  var MAX_MEDIA = 100, MAX_OUTPUTS = 200;
  var played = [], outputs = [], suspended = new WeakSet(), audioSources = [];
  // Media elements the page called play() on outside an input event (it asked for sound by itself); media
  // elements whose sound the page routed into Web Audio (createMediaElementSource: their sound reaches the
  // speakers only through that context); text the page spoke with speech synthesis.
  var playedAuto = new WeakSet(), routed = [], speech = [], MAX_SPEECH = 50;
  try {
    var MP = typeof HTMLMediaElement === 'function' ? HTMLMediaElement.prototype : null;
    var origPlay = MP && MP.play;
    if (typeof origPlay === 'function') {
      replace(MP, 'play', function play() {
        try { if (played.length < MAX_MEDIA && played.indexOf(this) < 0) played.push(this); if (!inInput()) playedAuto.add(this); } catch (e) {}
        return origPlay.apply(this, arguments);
      }, origPlay);
    }
  } catch (e) {}
  try {
    var BAC = typeof BaseAudioContext === 'function' ? BaseAudioContext.prototype : (typeof AC === 'function' ? AC.prototype : null);
    var ACP0 = typeof AC === 'function' ? AC.prototype : null;
    var mesOwner = ACP0 && Object.prototype.hasOwnProperty.call(ACP0, 'createMediaElementSource') ? ACP0 : BAC;
    var origMes = mesOwner && mesOwner.createMediaElementSource;
    if (typeof origMes === 'function') {
      replace(mesOwner, 'createMediaElementSource', function createMediaElementSource(el) {
        var node = origMes.apply(this, arguments);
        try { if (routed.length < MAX_MEDIA) routed.push({ el: el, node: node, ctx: this }); } catch (e) {}
        return node;
      }, origMes);
    }
  } catch (e) {}
  try {
    var SS = W.speechSynthesis, origSpeak = SS && SS.speak;
    if (typeof origSpeak === 'function') {
      var speak = function speak(u) {
        try { if (speech.length < MAX_SPEECH) speech.push({ at: Date.now(), byInput: inInput(), chars: String((u && u.text) || '').length }); } catch (e) {}
        return origSpeak.apply(this, arguments);
      };
      var ssProto = Object.getPrototypeOf(SS);
      if (!(ssProto && replace(ssProto, 'speak', speak, origSpeak))) replace(SS, 'speak', speak, origSpeak);
    }
  } catch (e) {}
  try {
    var AN = typeof AudioNode === 'function' ? AudioNode.prototype : null;
    var origConnect = AN && AN.connect;
    if (typeof origConnect === 'function') {
      replace(AN, 'connect', function connect(dest) {
        try {
          if (typeof AudioDestinationNode === 'function' && dest instanceof AudioDestinationNode && outputs.length < MAX_OUTPUTS && outputs.indexOf(this) < 0) outputs.push(this);
        } catch (e) {}
        return origConnect.apply(this, arguments);
      }, origConnect);
    }
    // When each source node was scheduled to start and stop, in its context's clock (start(when),
    // stop(when), or its end): the audio probe times a sound already playing from it.
    var SN = typeof AudioScheduledSourceNode === 'function' ? AudioScheduledSourceNode.prototype : null;
    var origStart = SN && SN.start, origStop = SN && SN.stop;
    if (typeof origStart === 'function') {
      replace(SN, 'start', function start(when) {
        try {
          if (audioSources.length < MAX_OUTPUTS) {
            var node = this, rec = { node: node, ctx: node.context, start: Math.max(Number(when) || 0, node.context.currentTime), stop: Infinity, byInput: inInput() };
            audioSources.push(rec);
            node.addEventListener('ended', function () { try { rec.stop = Math.min(rec.stop, node.context.currentTime); } catch (x) {} });
          }
        } catch (e) {}
        return origStart.apply(this, arguments);
      }, origStart);
    }
    if (typeof origStop === 'function') {
      replace(SN, 'stop', function stop(when) {
        try {
          for (var i = 0; i < audioSources.length; i++) {
            if (audioSources[i].node === this) audioSources[i].stop = Math.min(audioSources[i].stop, Math.max(Number(when) || 0, this.context.currentTime));
          }
        } catch (e) {}
        return origStop.apply(this, arguments);
      }, origStop);
    }
    var ACP = typeof AC === 'function' ? AC.prototype : null;
    ['suspend', 'resume'].forEach(function (api) {
      var orig = ACP && ACP[api];
      if (typeof orig !== 'function') return;
      replace(ACP, api, function () {
        try { if (api === 'suspend') suspended.add(this); else suspended.delete(this); } catch (e) {}
        return orig.apply(this, arguments);
      }, orig);
    });
  } catch (e) {}

  // --- Snapshot ----------------------------------------------------------------------------------
  var refs = new Map(), targets = [];
  function refOf(t) { var r = refs.get(t); if (r === undefined) { r = targets.length; targets.push(t); refs.set(t, r); } return r; }
  function esc(s) { return W.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }
  function clean(s) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 80); }
  function cheapName(el) {
    var a = el.getAttribute('aria-label');
    if (a && a.trim()) return clean(a);
    var lb = el.getAttribute('aria-labelledby');
    if (lb) {
      var s = lb.split(/\s+/).map(function (id) { var x = document.getElementById(id); return x ? x.textContent : ''; }).join(' ');
      if (s.trim()) return clean(s);
    }
    var tag = el.localName;
    if ((tag === 'img' || tag === 'area' || (tag === 'input' && el.type === 'image')) && el.getAttribute('alt')) return clean(el.getAttribute('alt'));
    if (tag === 'input' && /^(button|submit|reset)$/.test(el.type) && el.value) return clean(el.value);
    if (tag !== 'html' && tag !== 'body') { var t = clean(el.textContent); if (t) return t; }
    var title = el.getAttribute('title');
    if (title) return clean(title);
    var ph = el.getAttribute('placeholder');
    return ph ? clean(ph) : undefined;
  }
  function cssPath(el) {
    var parts = [], cur = el, root = el.getRootNode();
    while (cur && cur.nodeType === 1) {
      if (cur.id && root.querySelectorAll && root.querySelectorAll('#' + esc(cur.id)).length === 1) { parts.unshift('#' + esc(cur.id)); break; }
      var parent = cur.parentElement, name = esc(cur.localName);
      if (!parent) { parts.unshift(name); break; }
      var n = 1, only = true;
      for (var s = cur.previousElementSibling; s; s = s.previousElementSibling) if (s.localName === cur.localName) n++;
      if (n > 1) only = false;
      else for (var s2 = cur.nextElementSibling; s2; s2 = s2.nextElementSibling) if (s2.localName === cur.localName) { only = false; break; }
      parts.unshift(only ? name : name + ':nth-of-type(' + n + ')');
      cur = parent;
    }
    return parts.join(' > ');
  }
  function hostOf(t) {
    // A shadow root's listeners belong to its host element.
    while (t && typeof ShadowRoot === 'function' && t instanceof ShadowRoot) t = t.host;
    return t;
  }
  function describe(el) {
    var d = { kind: 'element', tag: el.localName, classes: Array.prototype.slice.call(el.classList || [], 0, 4), path: cssPath(el) };
    if (el.id) d.id = el.id;
    var role = el.getAttribute('role');
    if (role) d.role = role;
    var name = cheapName(el);
    if (name) d.name = name;
    if (typeof ShadowRoot === 'function' && el.getRootNode() instanceof ShadowRoot) d.inShadow = true;
    return d;
  }
  var VIA_ORDER = { add: 0, property: 1, attribute: 2 };
  // opts.shadowInline: also read inline handlers in open shadow roots (the keyboard test's 2.1.1 only; chart fix
  // round 4, S4: every other reader, the names and controls tests among them, reads the document's as before).
  function snapshot(opts) {
    var shadowInline = !!(opts && opts.shadowInline);
    var groups = new Map();
    function add(target, r) {
      var g = groups.get(target);
      if (!g) { g = new Map(); groups.set(target, g); }
      var e = g.get(r.type);
      if (!e) { e = { type: r.type, count: 0, passive: true, capture: false, via: [] }; g.set(r.type, e); }
      e.count++;
      e.passive = e.passive && r.passive;
      e.capture = e.capture || r.capture;
      if (e.via.indexOf(r.via) < 0) e.via.push(r.via);
    }
    byTarget.forEach(function (list, t) {
      var target = hostOf(t);
      if (target !== W && target !== document && !(target instanceof Element && target.isConnected)) return;
      for (var i = 0; i < list.length; i++) add(target, list[i]);
    });
    // Inline on* attributes (the HTML parser and setAttribute bypass the property setters), in the document and, when
    // asked (opts.shadowInline), in its open shadow roots, read through bounded (at most 200 roots, 20000 elements looked
    // at for hosts; fix round 2, S7). A handler past those bounds is not listed: never a failure, only not looked at.
    var sel = Array.from(TYPES).map(function (t) { return '[on' + t + ']'; }).join(',');
    var roots = [document], looked = 0;
    for (var ri = 0; ri < roots.length; ri++) {
      var withAttr = roots[ri].querySelectorAll(sel);
      for (var j = 0; j < withAttr.length; j++) {
        var el = withAttr[j], attrs = el.attributes;
        for (var k = 0; k < attrs.length; k++) {
          var an = attrs[k].name.toLowerCase();
          if (an.slice(0, 2) === 'on' && TYPES.has(an.slice(2))) add(el, { type: an.slice(2), passive: false, capture: false, via: 'attribute' });
        }
      }
      var inRoot = shadowInline ? roots[ri].querySelectorAll('*') : [];
      for (var hi = 0; hi < inRoot.length && looked < 20000 && roots.length < 200; hi++, looked++) {
        var sr = inRoot[hi].shadowRoot;
        if (sr) roots.push(sr);
      }
    }
    // Window, document, then elements in document order (shadow content at its host).
    var order = new Map(), all = document.getElementsByTagName('*');
    for (var m = 0; m < all.length; m++) order.set(all[m], m);
    function rank(t) {
      if (t === W) return -2;
      if (t === document) return -1;
      var h = t, r;
      while (h && (r = order.get(h)) === undefined) { var root = h.getRootNode(); h = root && root.host; }
      return r === undefined ? 1e9 : r;
    }
    var keys = Array.from(groups.keys()).sort(function (a, b) { return rank(a) - rank(b); });
    var out = [];
    for (var q = 0; q < keys.length; q++) {
      var tgt = keys[q];
      var desc = tgt === W ? { kind: 'window' } : tgt === document ? { kind: 'document' } : describe(tgt);
      var ref = refOf(tgt);
      groups.get(tgt).forEach(function (e) {
        e.via.sort(function (a, b) { return VIA_ORDER[a] - VIA_ORDER[b]; });
        out.push({ type: e.type, target: desc, ref: ref, count: e.count, passive: e.passive, capture: e.capture, via: e.via });
      });
    }
    return out;
  }
  function expose(name, fn) { try { defineProp(W, name, { value: fn, writable: false, enumerable: false, configurable: true }); } catch (e) {} }
  expose('__grntedListeners', snapshot);
  // Identities of the handlers of some types on a listener target ('f<n>' per function or object,
  // 'a:<source>' per inline attribute): elements with the same identities run the same code.
  var handlerIds = new WeakMap(), nextHandler = 1;
  expose('__grntedHandlerIds', function (ref, types) {
    var t = targets[ref], out = [];
    if (!t) return out;
    var want = new Set(types), list = byTarget.get(t) || [];
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (!want.has(r.type) || !r.listener) continue;
      var id = handlerIds.get(r.listener);
      if (!id) { id = 'f' + (nextHandler++); try { handlerIds.set(r.listener, id); } catch (e) { id = 'f?'; } }
      out.push(r.type + ':' + id);
    }
    if (t.getAttribute) types.forEach(function (ty) { var a = t.getAttribute('on' + ty); if (a) out.push(ty + ':a:' + a.slice(0, 200)); });
    return out.sort();
  });
  expose('__grntedHold', function (op, a) {
    if (op === 'on') { hold.on = true; hold.drag = !!(a && a.drag); hold.watch = (a && a.watch) || null; hold.reached = []; hold.submits = 0; hold.own = null; return true; }
    if (op === 'own') { hold.own = a || null; return true; }
    if (op === 'state') return { on: hold.on, reached: hold.reached.slice(), submits: hold.submits };
    var res = { reached: hold.reached.slice(), submits: hold.submits };
    hold.on = false; hold.watch = null; hold.own = null; hold.reached = []; hold.submits = 0;
    return res;
  });
  expose('__grntedTarget', function (ref) { return targets[ref]; });
  expose('__grntedClosedHost', function (el) { try { return closedHosts.has(el); } catch (e) { return false; } });
  // For in-page probe code (src/probes/kit.ts): pending timers, firing one early, sound sources and
  // the hook's element description (path and cheap name).
  expose('__grntedPending', pendingList);
  expose('__grntedFire', fire);
  expose('__grntedCancel', cancel);
  expose('__grntedFreeze', freeze);
  // Whether the page itself stopped this submit event (null: not a trusted submit event the hook saw).
  expose('__grntedSubmitStopped', function (ev) { var st = submitStops.get(ev); return st ? st.page : null; });
  expose('__grntedCalls', function () { return calls.slice(); });
  expose('__grntedSound', function () {
    return {
      played: played.slice(), contexts: audioCtxs.slice(), outputs: outputs.slice(), pageSuspended: function (c) { return suspended.has(c); },
      sources: audioSources.map(function (r) { return { ctx: r.ctx, start: r.start, stop: r.stop, byInput: !!r.byInput }; }),
      playedAuto: function (m) { return playedAuto.has(m); },
      ctxByInput: function (c) { return ctxByInput.has(c); },
      routed: routed.map(function (r) { return { el: r.el, ctx: r.ctx }; }),
      speech: speech.slice(),
    };
  });
  // Whether the page's long timers are held now (an earlier test's hold), and how many callbacks wait.
  // (Not __grntedHold: that name is the click canceller's, above.)
  expose('__grntedTimerHold', function () { return { on: frozen, held: held.length }; });
  // Whether an input event is being dispatched now, also inside a shadow tree (the audio test credits a control).
  expose('__grntedInInput', inInput);
  expose('__grntedTimerChanges', function (on) {
    try {
      if (on && !changeWatch && typeof MutationObserver === 'function') {
        changeWatch = new MutationObserver(function () {});
        changeWatch.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
      } else if (!on && changeWatch) { changeWatch.disconnect(); changeWatch = null; }
    } catch (e) {}
    return !!changeWatch;
  });
  expose('__grntedTimerWrote', function (el, since) {
    try {
      if (!el || el.nodeType !== 1) return false;
      for (var i = timerWrites.length - 1; i >= 0; i--) {
        var w = timerWrites[i];
        if (w.at < since) break;
        if (w.set >= since) continue;
        if (w.el === el || el.contains(w.el) || (w.el.contains(el) && String(w.el.textContent || '').length <= 300)) return true;
      }
    } catch (e) {}
    return false;
  });
  expose('__grntedDescribe', function (el) { return el && el.nodeType === 1 ? describe(el) : null; });
  expose('__grntedHooks', function () {
    var running = 0;
    for (var i = 0; i < audioCtxs.length; i++) { try { if (audioCtxs[i].state === 'running') running++; } catch (e) {} }
    return {
      listeners: snapshot(),
      timers: timers.map(function (t) { var c = {}; for (var k in t) c[k] = t[k]; return c; }),
      calls: calls.slice(),
      audio: { created: audioCreated, running: running },
    };
  });
})();`;

/**
 * How the page reports a window it did not open: `console.debug(prefix + address)`. The nonce is per
 * context (`newPopupNonce`), so a page cannot make up reports by guessing it.
 */
export function popupReportPrefix(nonce: string): string {
  return `grnted:popup:${nonce}:`;
}

/**
 * How the page reports a form submission the listener hook cancelled (the page did not stop it):
 * `console.debug(prefix + JSON {method, url, frame})`, with the same per-context nonce.
 */
export function formReportPrefix(nonce: string): string {
  return `grnted:form:${nonce}:`;
}

/** A fresh, hard-to-guess nonce for `listenerHookScript` and the request guard (`installGuard`). */
export function newPopupNonce(): string {
  const bytes = new Uint8Array(12);
  const c = (globalThis as { crypto?: { getRandomValues?(a: Uint8Array): Uint8Array } }).crypto;
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The init script (self-contained JavaScript). Add it with `context.addInitScript({ content })`.
 * With a nonce, the popup blocker reports each window it did not open (see `popupReportPrefix`);
 * without one it blocks them silently.
 */
export function listenerHookScript(popupNonce = ''): string {
  if (!/^[0-9a-zA-Z_-]*$/.test(popupNonce)) throw new Error('popup nonce: letters, digits, - and _ only');
  const values: Record<string, string> = {
    __TYPES__: JSON.stringify(LISTENER_TYPES),
    __MIN_TIMER__: String(MIN_TIMER_MS),
    __POPUP_PREFIX__: JSON.stringify(popupNonce ? popupReportPrefix(popupNonce) : ''),
    __FORM_PREFIX__: JSON.stringify(popupNonce ? formReportPrefix(popupNonce) : ''),
  };
  return SCRIPT.replace(/__TYPES__|__MIN_TIMER__|__POPUP_PREFIX__|__FORM_PREFIX__/g, (k) => values[k]!);
}

/** The init script without popup reports (`listenerHookScript()`). */
export const LISTENER_HOOK_SCRIPT = listenerHookScript();

/** Runs in the page (self-contained): the hook's listener snapshot, or null when it is not installed. */
export function readListeners(opts?: { shadowInline?: boolean }): RecordedListener[] | null {
  const w = window as unknown as { __grntedListeners?: (o?: { shadowInline?: boolean }) => RecordedListener[] };
  return typeof w.__grntedListeners === 'function' ? w.__grntedListeners(opts && opts.shadowInline ? { shadowInline: true } : undefined) : null;
}

/** Runs in the page (self-contained): everything the hook recorded, or null when it is not installed. */
export function readHooks(): RecordedHooks | null {
  const w = window as unknown as { __grntedHooks?: () => RecordedHooks };
  return typeof w.__grntedHooks === 'function' ? w.__grntedHooks() : null;
}
