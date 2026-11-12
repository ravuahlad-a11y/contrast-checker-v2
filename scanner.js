// scanner.js (v2)
// Injected into every frame. Exposes:
//   __contrastFrameContexts()      -> for this frame's iframes: covered? overlaid? what is behind them?
//   __contrastScan(ctxMap)         -> checks every visible text item in this frame
//   __contrastHighlight(on)        -> outlines failing items
//   __contrastLive(on, hl)         -> re-checks when the page changes
(() => {
  if (window.__contrastScan) return;

  const HTML_NS = 'http://www.w3.org/1999/xhtml';
  const WCAG_NORMAL = 4.5;
  const WCAG_LARGE = 3;
  const OPAQUE = 0.999;
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK',
    'TITLE', 'IFRAME', 'OBJECT', 'EMBED', 'CANVAS', 'VIDEO', 'AUDIO', 'MATH', 'SELECT']);
  const MEDIA_TAGS = new Set(['IMG', 'VIDEO', 'CANVAS', 'PICTURE', 'IFRAME', 'OBJECT', 'EMBED']);
  const SKIP_INPUT_TYPES = new Set(['hidden', 'password', 'checkbox', 'radio', 'range', 'color', 'file', 'image']);
  const HL_CLASS = 'cc-contrast-fail';
  const LIGHT_DEFAULT = [255, 255, 255];
  const DARK_DEFAULT = [18, 18, 18];

  const state = {
    failing: [], marked: [],
    base: LIGHT_DEFAULT,      // what is behind the whole frame (white, dark, or the parent page's color)
    frameOpacity: 1,          // opacity inherited from the parent page's iframe element
    ctxMap: null,
    layerCache: new WeakMap()
  };
  const live = { observer: null, timer: null, on: false, highlightOn: false, badge: null };

  // ---------- Color math ----------

  // A 1x1 canvas turns any CSS color into sRGB numbers.
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx2d = canvas.getContext('2d', { willReadFrequently: true });
  const colorCache = new Map();

  function toRGBA(css) {
    if (colorCache.has(css)) return colorCache.get(css).slice();
    ctx2d.clearRect(0, 0, 1, 1);
    ctx2d.fillStyle = 'rgba(0, 0, 0, 0)';
    ctx2d.fillStyle = css;
    ctx2d.fillRect(0, 0, 1, 1);
    const d = ctx2d.getImageData(0, 0, 1, 1).data;
    const value = [d[0], d[1], d[2], d[3] / 255];
    colorCache.set(css, value);
    return value.slice();
  }

  // Lay a translucent color (top) over another color (bottom).
  function over(top, bottom) {
    const a = top[3] + bottom[3] * (1 - top[3]);
    if (a === 0) return [0, 0, 0, 0];
    const mix = i => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / a;
    return [mix(0), mix(1), mix(2), a];
  }

  function luminance([r, g, b]) {
    const lin = c => {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }
  function contrastRatio(c1, c2) {
    const a = luminance(c1);
    const b = luminance(c2);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }

  const toHex = ([r, g, b]) => '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
  const round1 = n => Math.round(n * 10) / 10;
  const round2 = n => Math.round(n * 100) / 100;

  // ---------- DOM helpers ----------

  function parentOf(el) {
    if (el.parentElement) return el.parentElement;
    const root = el.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  }

  function chainOpacity(el) {
    let o = 1;
    for (let e = el; e && e.nodeType === 1; e = parentOf(e)) o *= parseFloat(getComputedStyle(e).opacity);
    return o;
  }

  function pageDefaultBg() {
    const scheme = getComputedStyle(document.documentElement).colorScheme || '';
    return scheme.includes('dark') && !scheme.includes('light') ? DARK_DEFAULT : LIGHT_DEFAULT;
  }

  function allElements(root = document, out = []) {
    for (const el of root.querySelectorAll('*')) {
      out.push(el);
      if (el.shadowRoot) allElements(el.shadowRoot, out);
    }
    return out;
  }

  function selectorFor(el) {
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && parts.length < 5; e = parentOf(e)) {
      if (e.id) {
        parts.unshift(e.tagName.toLowerCase() + '#' + CSS.escape(e.id));
        break;
      }
      const cls = [...e.classList].filter(c => !c.startsWith('cc-')).slice(0, 2)
        .map(c => '.' + CSS.escape(c)).join('');
      parts.unshift(e.tagName.toLowerCase() + cls);
    }
    return parts.join(' > ');
  }

  // Is the element actually displayed (not display:none, not zero-size)?
  function isRendered(el) {
    if (chainOpacity(el) === 0) return false;
    if (getComputedStyle(el).visibility !== 'visible') return false;
    if (getComputedStyle(el).display === 'contents') return true;
    return el.getClientRects().length > 0;
  }

  // Is the element cut off by an ancestor with overflow (height:0 menus, clipped panels)?
  function isClipped(el) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return true;
    for (let e = parentOf(el); e && e.nodeType === 1; e = parentOf(e)) {
      const cs = getComputedStyle(e);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const b = e.getBoundingClientRect();
      const ix = Math.min(r.right, b.right) - Math.max(r.left, b.left);
      const iy = Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top);
      if (ix <= 0 || iy <= 0) return true;
    }
    return false;
  }

  // Parked off the left/right edge (the common "hidden until focused" trick).
  function isOffscreenHorizontally(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && (r.right <= 0 || r.left >= window.innerWidth);
  }

  // ---------- Layers: what paints behind or on top of a point ----------

  // Describe one element as a paint layer and note anything the math can't handle exactly.
  function describeLayer(e) {
    const cached = state.layerCache.get(e);
    if (cached) return cached;

    const cs = getComputedStyle(e);
    const reasons = [];
    const c = toRGBA(cs.backgroundColor);
    const alpha = c[3] * chainOpacity(e) * state.frameOpacity;

    if (cs.backgroundImage && cs.backgroundImage !== 'none') reasons.push('background image or gradient');
    if (cs.filter && cs.filter !== 'none') reasons.push('CSS filter');
    if (cs.backdropFilter && cs.backdropFilter !== 'none') reasons.push('backdrop blur');
    if (cs.mixBlendMode && cs.mixBlendMode !== 'normal') reasons.push('blend mode');
    if (MEDIA_TAGS.has(e.tagName)) reasons.push('image, video or frame behind text');
    for (const p of ['::before', '::after']) {
      const pc = getComputedStyle(e, p);
      const hasContent = pc.content && pc.content !== 'none' && pc.content !== 'normal';
      const painted = (pc.backgroundImage && pc.backgroundImage !== 'none') || toRGBA(pc.backgroundColor)[3] > 0;
      if (hasContent && painted) reasons.push('decorative ' + p + ' background');
    }

    const layer = { color: [c[0], c[1], c[2], alpha], reasons };
    state.layerCache.set(e, layer);
    return layer;
  }

  // Stack layers from the top of the given sequence down until one is opaque, then blend upward.
  function composeStack(seq) {
    const layers = [];
    const reasons = new Set();
    for (const e of seq) {
      const L = describeLayer(e);
      L.reasons.forEach(r => reasons.add(r));
      if (L.color[3] > 0) layers.push(L.color);
      if (L.color[3] >= OPAQUE) break;
    }
    let bg = [...state.base, 1];
    for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
    return { bg: bg.slice(0, 3), reasons: [...reasons] };
  }

  // Ask the browser which elements are at a point, top to bottom, and analyze that stack.
  function hitTest(target, x, y) {
    const root = target.getRootNode();
    return (root instanceof ShadowRoot ? root : document).elementsFromPoint(x, y);
  }

  function analyzePoint(target, x, y) {
    const list = hitTest(target, x, y);
    const idx = list.findIndex(e => e === target || target.contains(e));
    if (idx === -1) return null; // not hit-testable (for example pointer-events: none)

    // Elements painted ON TOP of the target at this point.
    let covered = false;
    const overlayReasons = [];
    for (const e of list.slice(0, idx)) {
      if (e.contains(target)) continue;
      const L = describeLayer(e);
      if (L.color[3] >= OPAQUE) covered = true;
      else if (L.color[3] > 0 || L.reasons.length) {
        overlayReasons.push(...(L.reasons.length ? L.reasons : ['translucent layer on top of text']));
      }
    }

    // Everything painted at or below the target at this point.
    const stack = composeStack(list.slice(idx));
    return {
      covered,
      overlay: overlayReasons.length > 0,
      reasons: [...overlayReasons, ...stack.reasons],
      bg: stack.bg
    };
  }

  // Fallback when no point can be hit-tested: walk up the ancestors only.
  function ancestorAnalysis(el) {
    const seq = [];
    for (let e = el; e && e.nodeType === 1; e = parentOf(e)) seq.push(e);
    const stack = composeStack(seq);
    return { covered: false, overlay: false, reasons: stack.reasons, bg: stack.bg };
  }

  function samplePoints(el) {
    const pts = [];
    const rects = [...el.getClientRects()].filter(r => r.width > 0 && r.height > 0).slice(0, 3);
    for (const r of rects) {
      pts.push([r.left + r.width / 2, r.top + r.height / 2]);
      pts.push([r.left + r.width * 0.2, r.top + r.height * 0.3]);
      pts.push([r.left + r.width * 0.8, r.top + r.height * 0.7]);
    }
    return pts;
  }

  function evaluateBackground(el) {
    const hits = [];
    let inView = 0;
    for (const [x, y] of samplePoints(el)) {
      if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) continue;
      inView++;
      const a = analyzePoint(el, x, y);
      if (a) hits.push(a);
    }
    if (hits.length) return { results: hits, note: '' };
    const note = inView === 0
      ? 'outside the visible area, so overlays were not checked'
      : 'not hit-testable (pointer-events: none?), so overlays were not checked';
    return { results: [ancestorAnalysis(el)], note };
  }

  // ---------- Collect text ----------

  function collectTargets() {
    const targets = [];
    for (const el of allElements()) {
      if (el.namespaceURI !== HTML_NS || SKIP_TAGS.has(el.tagName) || el.id === 'cc-badge') continue;

      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        const type = (el.type || 'text').toLowerCase();
        if (SKIP_INPUT_TYPES.has(type)) continue;
        const isButton = ['submit', 'button', 'reset'].includes(type);
        if (el.value) {
          targets.push({ el, kind: isButton ? 'button text' : 'input text', text: el.value, pseudo: null });
        } else if (el.placeholder && !isButton) {
          targets.push({ el, kind: 'placeholder', text: el.placeholder, pseudo: '::placeholder' });
        }
        continue;
      }

      const own = [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE)
        .map(n => n.textContent).join(' ').replace(/\s+/g, ' ').trim();
      if (own) targets.push({ el, kind: 'text', text: own, pseudo: null });

      for (const p of ['::before', '::after']) {
        const pc = getComputedStyle(el, p);
        const m = pc.content && pc.content.match(/^"(.*)"$/);
        if (m && m[1].trim()) targets.push({ el, kind: 'generated ' + p, text: m[1], pseudo: p });
      }
    }
    return targets;
  }

  // ---------- Iframe context (what the parent page does to each iframe) ----------

  function frameContexts() {
    state.frameOpacity = 1;
    state.base = pageDefaultBg();
    state.layerCache = new WeakMap();
    const out = {};
    for (const iframe of document.querySelectorAll('iframe')) {
      if (!iframe.dataset.ccId) iframe.dataset.ccId = Math.random().toString(36).slice(2, 10);
      const r = iframe.getBoundingClientRect();
      const ctx = { hidden: false, covered: false, overlay: false, opacity: chainOpacity(iframe), bg: null, reasons: [] };

      if (!isRendered(iframe) || isClipped(iframe) || isOffscreenHorizontally(iframe) || ctx.opacity === 0) {
        ctx.hidden = true;
      } else {
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        if (cx >= 0 && cy >= 0 && cx < window.innerWidth && cy < window.innerHeight) {
          const a = analyzePoint(iframe, cx, cy);
          if (a) {
            ctx.covered = a.covered;
            ctx.overlay = a.overlay;
            ctx.reasons = a.reasons;
            ctx.bg = a.covered ? null : a.bg;
          }
        }
      }
      out['id:' + iframe.dataset.ccId] = ctx;
      if (iframe.src) out['url:' + iframe.src] = ctx;
    }
    return out;
  }

  function frameContextFor(ctxMap) {
    if (!ctxMap) return null;
    let id = null;
    try { id = window.frameElement && window.frameElement.dataset.ccId; } catch (e) { /* cross-origin */ }
    if (id && ctxMap['id:' + id]) return ctxMap['id:' + id];
    return ctxMap['url:' + location.href] || null;
  }

  // ---------- Scan ----------

  function scan(ctxMap) {
    state.ctxMap = ctxMap || null;
    const fc = frameContextFor(ctxMap);
    state.frameOpacity = fc ? fc.opacity : 1;
    state.base = fc && fc.bg ? fc.bg : pageDefaultBg();
    state.layerCache = new WeakMap();
    state.failing = [];

    const frame = location.href;
    if (fc && fc.hidden) {
      return { frame, checked: 0, covered: 0, hidden: 0, items: [], skipped: 'this frame is hidden or clipped by the parent page' };
    }
    if (fc && fc.covered) {
      return { frame, checked: 0, covered: 0, hidden: 0, items: [], skipped: 'this frame is covered by an element in the parent page' };
    }

    const items = [];
    let hidden = 0;
    let covered = 0;

    for (const t of collectTargets()) {
      const el = t.el;
      if (!isRendered(el) || isClipped(el) || isOffscreenHorizontally(el)) { hidden++; continue; }

      const cs = getComputedStyle(el, t.pseudo);
      const size = parseFloat(cs.fontSize);
      const weight = parseInt(cs.fontWeight, 10) || 400;
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const required = large ? WCAG_LARGE : WCAG_NORMAL;
      const selector = selectorFor(el);

      const clipText = cs.backgroundClip === 'text' || cs.webkitBackgroundClip === 'text';
      const fg = toRGBA(clipText ? cs.webkitTextFillColor : cs.color);
      fg[3] *= chainOpacity(el) * state.frameOpacity;
      if (fg[3] === 0 && clipText) {
        // Text painted by a gradient through background-clip: the fill is transparent, so the
        // color the user sees comes from the background. Can't be measured exactly; flag it.
        items.push({
          status: 'review', kind: t.kind, text: t.text.slice(0, 120), ratio: null, required, large,
          size: round1(size), weight, fg: null, bg: null, selector, frame,
          notes: ['gradient-filled text: the color comes from the background, check visually']
        });
        continue;
      }
      if (fg[3] === 0) { hidden++; continue; }

      const ev = evaluateBackground(el);
      const considered = ev.results.filter(r => !r.covered);

      if (considered.length === 0) {
        covered++;
        items.push({
          status: 'covered', kind: t.kind, text: t.text.slice(0, 120), ratio: null, required, large,
          size: round1(size), weight, fg: null, bg: null, selector, frame,
          notes: ['hidden under another element, not checked']
        });
        continue;
      }

      // Worst case across every sampled point.
      let worst = Infinity;
      let worstBg = null;
      let worstFg = null;
      const reasons = new Set();
      for (const r of considered) {
        const solid = over(fg, [...r.bg, 1]).slice(0, 3);
        const ratio = contrastRatio(solid, r.bg);
        if (ratio < worst) { worst = ratio; worstBg = r.bg; worstFg = solid; }
        r.reasons.forEach(x => reasons.add(x));
      }
      if (considered.length < ev.results.length) reasons.add('partly covered by another element');
      if (clipText) reasons.add('gradient or clipped text (color behind it is not solid)');
      if (fc && fc.overlay) reasons.add('frame sits under a translucent overlay in the parent page');

      const reviewReasons = [...reasons];
      const status = reviewReasons.length ? 'review' : (worst >= required ? 'pass' : 'fail');
      const notes = [...reviewReasons];
      if (ev.note) notes.push(ev.note);
      if (reviewReasons.length && worst < required) notes.push(`would fail at ${round2(worst)}:1 if the background is solid`);

      const item = {
        status, kind: t.kind, text: t.text.slice(0, 120), ratio: round2(worst), required, large,
        size: round1(size), weight, fg: toHex(worstFg), bg: toHex(worstBg), selector, frame, notes
      };
      items.push(item);
      if (status === 'fail') state.failing.push({ el });
    }

    return { frame, checked: items.length, covered, hidden, items, skipped: null };
  }

  // ---------- Highlighting ----------

  function ensureStyle(root) {
    if (root.querySelector('#cc-style')) return;
    const style = document.createElement('style');
    style.id = 'cc-style';
    style.textContent = `.${HL_CLASS}{outline:3px solid #e11d48 !important;outline-offset:2px !important;}`;
    (root instanceof ShadowRoot ? root : document.head || document.documentElement).appendChild(style);
  }

  function highlight(on) {
    for (const el of state.marked) el.classList.remove(HL_CLASS);
    state.marked = [];
    if (!on) return;
    for (const { el } of state.failing) {
      if (!el.isConnected) continue;
      const root = el.getRootNode();
      ensureStyle(root instanceof ShadowRoot ? root : document);
      el.classList.add(HL_CLASS);
      state.marked.push(el);
    }
  }

  // ---------- Live mode ----------

  function renderBadge(text) {
    if (window.top !== window) return;
    if (!live.badge) {
      live.badge = document.createElement('div');
      live.badge.id = 'cc-badge';
      Object.assign(live.badge.style, {
        position: 'fixed', right: '12px', bottom: '12px', zIndex: '2147483647',
        font: '14px/1.4 system-ui, sans-serif', padding: '8px 12px', borderRadius: '8px',
        background: '#1f2937', color: '#ffffff', boxShadow: '0 2px 8px rgba(0,0,0,.3)'
      });
      (document.body || document.documentElement).appendChild(live.badge);
    }
    live.badge.textContent = text;
  }

  function removeBadge() {
    if (live.badge) live.badge.remove();
    live.badge = null;
  }

  function runLive() {
    const res = scan(state.ctxMap);
    highlight(live.highlightOn);
    const fails = res.items.filter(i => i.status === 'fail').length;
    const reviews = res.items.filter(i => i.status === 'review').length;
    renderBadge(`Contrast (live): ${fails} failing, ${reviews} to review`);
    // Drop the mutations we caused ourselves (outlines, badge text) so we don't loop.
    if (live.observer) live.observer.takeRecords();
  }

  function setLive(on, highlightOn) {
    live.highlightOn = !!highlightOn;
    if (on === live.on) {
      if (on) runLive();
      return;
    }
    live.on = !!on;
    if (live.on) {
      live.observer = new MutationObserver(() => {
        clearTimeout(live.timer);
        live.timer = setTimeout(runLive, 700);
      });
      live.observer.observe(document.documentElement, {
        subtree: true, childList: true, characterData: true,
        attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden']
      });
      runLive();
    } else {
      clearTimeout(live.timer);
      if (live.observer) live.observer.disconnect();
      live.observer = null;
      highlight(false);
      removeBadge();
    }
  }

  // ---------- Expose ----------

  window.__contrastFrameContexts = () => frameContexts();
  window.__contrastScan = ctxMap => scan(ctxMap);
  window.__contrastHighlight = on => {
    live.highlightOn = !!on;
    highlight(!!on);
  };
  window.__contrastLive = (on, highlightOn) => setLive(on, highlightOn);
})();
