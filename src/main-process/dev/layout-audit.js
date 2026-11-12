'use strict';

/**
 * Rendered-layout audit for the assistant window (development only, run by
 * the `layout` ui-capture scene). It runs inside the real renderer and reads
 * real bounding boxes, so it fails on what a user would actually see:
 *
 *   overlap   two visible controls in the same layer intersect
 *   blocked   the point at a control's centre hits something else (another
 *             control or an invisible overlay); controls under an open sheet
 *             are skipped, the sheet covers them on purpose
 *   clipped   a control's own content is wider than the control
 *   outside   a control extends past the window edge
 *   small     a control is under 24 px in either direction
 *   squeezed  the chat workspace lost its width or height
 *
 * `auditLayout` must stay self-contained: it is stringified and evaluated in
 * the page.
 */

function auditLayout() {
  // The session chip is a label, not a control, but nothing may sit on top of it either.
  const SELECTOR = 'button, select, input:not([type="hidden"]), textarea, a[href], [role="button"], #session-state';
  const problems = [];
  const name = (el) => el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''}${el.getAttribute('aria-label') ? `[${el.getAttribute('aria-label')}]` : ''}`;
  const visible = (el) => {
    if (el.closest('.hidden, [hidden], .command-targets')) return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  // Only the open sheet's own controls and the title bar are reachable while a sheet is open.
  const openSheet = document.querySelector('.sheet:not(.hidden)');
  const layerOf = (el) => (el.closest('.sheet') ? 'sheet' : el.closest('.topbar') ? 'topbar' : 'main');
  // The part of a control the user can see: clipped to its scroll container (a row
  // scrolled under a sheet's fixed header is scrolled away, not overlapped).
  const SCROLLERS = '.chat-messages, .sheet-body';
  const shown = new Map();
  for (const el of [...document.querySelectorAll(SELECTOR)].filter(visible)) {
    const r = el.getBoundingClientRect();
    const scroller = el.closest(SCROLLERS);
    const s = scroller ? scroller.getBoundingClientRect() : { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };
    const box = { left: Math.max(r.left, s.left), top: Math.max(r.top, s.top), right: Math.min(r.right, s.right), bottom: Math.min(r.bottom, s.bottom) };
    if (box.right - box.left > 1 && box.bottom - box.top > 1) shown.set(el, { full: r, box });
  }
  const controls = [...shown.keys()];

  // A scroll area must itself fit in the window, or its last rows can never be reached.
  for (const scroller of document.querySelectorAll(SCROLLERS)) {
    if (!visible(scroller)) continue;
    const s = scroller.getBoundingClientRect();
    if (s.bottom > innerHeight + 0.5 || s.right > innerWidth + 0.5) problems.push({ kind: 'outside', el: name(scroller), rect: [s.left, s.top, s.right, s.bottom].map(Math.round) });
  }

  // Content wider than the control, ignoring deliberate overhangs (count badges are position: absolute).
  const spills = (el) => {
    const r = el.getBoundingClientRect();
    for (const node of el.childNodes) {
      let c;
      if (node.nodeType === 3) {
        if (!node.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        c = range.getBoundingClientRect();
      } else if (node.nodeType === 1) {
        const style = getComputedStyle(node);
        if (style.position === 'absolute' || style.position === 'fixed' || style.display === 'none' || style.textOverflow === 'ellipsis') continue;
        c = node.getBoundingClientRect();
        if (!c.width) continue;
      } else continue;
      if (c.left < r.left - 1 || c.right > r.right + 1) return Math.round(Math.max(r.left - c.left, c.right - r.right));
    }
    return 0;
  };

  for (const el of controls) {
    const { full: r, box } = shown.get(el);
    if (box.left < -0.5 || box.top < -0.5 || box.right > innerWidth + 0.5 || box.bottom > innerHeight + 0.5) {
      problems.push({ kind: 'outside', el: name(el), rect: [box.left, box.top, box.right, box.bottom].map(Math.round) });
    }
    if (r.width < 23.5 || r.height < 23.5) problems.push({ kind: 'small', el: name(el), size: [Math.round(r.width), Math.round(r.height)] });
    if (!['SELECT', 'TEXTAREA', 'INPUT'].includes(el.tagName)) {
      const by = spills(el);
      if (by) problems.push({ kind: 'clipped', el: name(el), by });
    }
    const x = Math.min(Math.max((box.left + box.right) / 2, 0), innerWidth - 1);
    const y = Math.min(Math.max((box.top + box.bottom) / 2, 0), innerHeight - 1);
    const hit = document.elementFromPoint(x, y);
    // An open sheet covering a control on purpose is a layer, not a collision.
    const underSheet = openSheet && !openSheet.contains(el) && hit && openSheet.contains(hit);
    if (hit && hit !== el && !el.contains(hit) && !underSheet) problems.push({ kind: 'blocked', el: name(el), by: name(hit) });
  }

  for (let i = 0; i < controls.length; i += 1) {
    for (let j = i + 1; j < controls.length; j += 1) {
      const a = controls[i];
      const b = controls[j];
      if (a.contains(b) || b.contains(a) || layerOf(a) !== layerOf(b)) continue;
      const ra = shown.get(a).box;
      const rb = shown.get(b).box;
      const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (w > 1 && h > 1) problems.push({ kind: 'overlap', el: name(a), with: name(b), by: [Math.round(w), Math.round(h)] });
    }
  }

  const chat = document.getElementById('chat-container');
  if (chat && !document.getElementById('app').classList.contains('compact-mode')) {
    const r = chat.getBoundingClientRect();
    if (r.width < innerWidth - 4 || r.height < Math.min(200, innerHeight - 140)) {
      problems.push({ kind: 'squeezed', el: '#chat-container', size: [Math.round(r.width), Math.round(r.height)], window: [innerWidth, innerHeight] });
    }
    // The feed itself (not the composer) must keep room for about three lines of answer.
    const feed = document.getElementById('chat-messages')?.getBoundingClientRect();
    if (feed && feed.height < 96) problems.push({ kind: 'squeezed', el: '#chat-messages', size: [Math.round(feed.width), Math.round(feed.height)], window: [innerWidth, innerHeight] });
  }
  // The title bar's scroll fallback keeps controls from overlapping, but needing it means a collapse step is missing.
  const center = document.querySelector('.topbar-center');
  if (center && center.scrollWidth > center.clientWidth + 1) problems.push({ kind: 'crowded', el: '.topbar-center', content: center.scrollWidth, box: center.clientWidth });

  // Natural (unsqueezed) width of each title-bar region, for sizing the breakpoints.
  const natural = (sel) => { const el = document.querySelector(sel); return el ? Math.ceil(el.scrollWidth) : 0; };
  const items = (sel) => [...(document.querySelector(sel)?.children || [])]
    .filter((el) => el.getBoundingClientRect().width)
    .map((el) => `${el.id || el.className.split(' ')[0]}:${Math.round(el.getBoundingClientRect().width)}`);
  const regions = {
    viewport: innerWidth,
    start: natural('.topbar-start'),
    center: natural('.action-buttons'),
    end: natural('.topbar-end'),
    centerItems: items('.action-buttons'),
    endItems: items('.topbar-end')
  };
  return { checked: controls.length, problems, regions };
}

/** Puts the renderer in a named visual state using the same classes and text the app sets. */
function applyState(state) {
  const $ = (id) => document.getElementById(id);
  const chip = $('session-state');
  const label = $('session-state-label');
  const listen = $('transcription-toggle');
  const analyze = $('analyze-screen-btn');
  const badge = $('screenshot-count');
  const reset = () => {
    chip.dataset.state = 'ready';
    label.textContent = 'Ready';
    listen.classList.remove('listening', 'connecting');
    analyze.classList.remove('analyzing');
    analyze.disabled = false;
    badge.hidden = true;
    $('mobile-server-pill').classList.remove('connected');
    $('show-mobile-code-btn').style.display = 'none';
    document.querySelector('.timer').textContent = '00:00';
  };
  reset();
  if (state === 'busy') {
    // Every label at its longest, every optional control shown.
    chip.dataset.state = 'reconnecting';
    label.textContent = 'Reconnecting';
    document.querySelector('.timer').textContent = '128:45';
    listen.classList.add('listening');
    analyze.classList.add('analyzing');
    analyze.disabled = true;
    badge.hidden = false;
    badge.textContent = '12';
    $('mobile-server-pill').classList.add('connected');
    $('show-mobile-code-btn').style.display = '';
  }
  return true;
}

module.exports = { auditLayout, applyState };
