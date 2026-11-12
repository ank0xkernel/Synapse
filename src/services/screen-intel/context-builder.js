'use strict';

const { mapLines, dedupeLines, toBlocks, detectSegmentMerge } = require('./context-lines');

const GAP_MARKER = '[… content between here was not captured …]';
const MAX_IMAGE_REGIONS = 6;

function rectCenter(rect, axis) {
  return axis === 'x' ? rect.x + rect.w / 2 : rect.y + rect.h / 2;
}

/** Position labels from geometry: left/right/top/bottom/main. Root is always 'main'. */
function panelLabels(containers) {
  const panels = containers.filter((c) => c.id !== 'root' && c.screenRect);
  const ordered = panels.slice().sort((a, b) => a.screenRect.x - b.screenRect.x || a.screenRect.y - b.screenRect.y);
  const xs0 = Math.min(...panels.map((c) => c.screenRect.x));
  const xs1 = Math.max(...panels.map((c) => c.screenRect.x + c.screenRect.w));
  const stacked = panels.length > 1 && (xs1 - xs0) < 1.2 * Math.max(...panels.map((c) => c.screenRect.w));
  const pos = new Map();
  if (stacked) {
    const byY = panels.slice().sort((a, b) => a.screenRect.y - b.screenRect.y);
    byY.forEach((c, i) => pos.set(c.id, i === 0 ? 'top' : i === byY.length - 1 ? 'bottom' : 'middle'));
  } else {
    ordered.forEach((c, i) => pos.set(c.id, ordered.length === 1 ? 'main' : i === 0 ? 'left' : i === ordered.length - 1 ? 'right' : 'center'));
  }
  const labels = new Map();
  const all = containers.slice().sort((a, b) => (a.screenRect ? a.screenRect.x : 0) - (b.screenRect ? b.screenRect.x : 0)
    || (a.id === 'root' ? -1 : 1));
  all.forEach((c, i) => {
    const p = c.id === 'root' ? 'main' : pos.get(c.id) || 'main';
    const x0 = c.screenRect ? Math.round(c.screenRect.x) : 0;
    const x1 = c.screenRect ? Math.round(c.screenRect.x + c.screenRect.w) : 0;
    labels.set(c.id, { index: i + 1, position: p, label: `Panel ${i + 1} (${p}, x=${x0}..${x1})` });
  });
  return labels;
}

function cellMarker(cell, axis) {
  const range = `${axis}=${Math.round(cell.start)}..${Math.round(cell.end)}`;
  switch (cell.status) {
    case 'pending': return `[… region ${range} is pending: waiting to be captured again …]`;
    case 'failed': return `[… region ${range} FAILED analysis and is missing …]`;
    case 'stale': return `[… region ${range} changed after it was analysed; the text above may be outdated …]`;
    case 'inaccessible': return `[… region ${range} was hidden behind the app window and not captured …]`;
    case 'uncovered': return `[… region ${range} was never captured …]`;
    case 'captured': case 'new': case 'analysing': return `[… region ${range} is still being analysed …]`;
    default: return null;
  }
}

const inside = (l, r) => r && l.x + l.w / 2 >= r.x && l.x + l.w / 2 <= r.x + r.w && l.y + l.h / 2 >= r.y && l.y + l.h / 2 <= r.y + r.h;

/**
 * The root region is the full screen captured before panels were told apart.
 * Its lines inside a panel's rectangle are an earlier view of that panel: they
 * are listed separately (never joined on one row with another panel's text)
 * and dropped where the panel itself already supplies the same line.
 */
function splitRootLines(lines, geo, records, labels) {
  const panels = geo.filter((o) => o.id !== 'root' && o.screenRect);
  const own = [];
  const byPanel = new Map(panels.map((p) => [p.id, []]));
  for (const line of lines) {
    const panel = !line.noBox && panels.find((p) => inside(line, p.screenRect));
    if (panel) byPanel.get(panel.id).push(line); else own.push(line);
  }
  const items = [];
  panels.forEach((p, index) => {
    const supplied = new Set(records.filter((r) => r.containerId === p.id && r.status === 'analysed' && !r.duplicateOf)
      .flatMap(mapLines).map((l) => l.norm));
    const rest = byPanel.get(p.id).filter((l) => !supplied.has(l.norm));
    if (!rest.length) return;
    const seg = 1e9 + index;
    items.push({ marker: true, text: `[earlier full-screen capture of the ${labels.get(p.id).label} area, before it scrolled; it may not connect directly to that panel's text]`, pos: -Infinity, seg });
    for (const block of toBlocks(rest)) items.push({ ...block, pos: block.y0, seg });
  });
  return { own, items };
}

/**
 * Line filter for one problem. `attribute(record, y)` names the owner of a
 * line (problem id, 'held' for content under an undecided boundary, or null).
 * Returns null when no filtering is asked for.
 */
function lineKeeper({ attribute, activeProblemId }) {
  if (typeof attribute !== 'function') return null;
  return (rec, line) => {
    const owner = attribute(rec, line.y);
    if (owner === 'held') return 'held';
    if (activeProblemId) return owner === activeProblemId ? 'keep' : 'other';
    return owner ? 'other' : 'keep';
  };
}

function buildEpoch(ledger, epoch, containers, keeper = null) {
  const records = ledger.list({ epoch });
  // Retired text (a panel that now shows other content) only ever serves the problem it belongs to.
  const usable = (r) => (r.status === 'analysed' || (keeper && r.status === 'retired')) && !r.duplicateOf;
  const filtered = { held: 0, other: 0 };
  const linesOf = (r) => {
    const all = mapLines(r);
    if (!keeper) return all;
    return all.filter((l) => {
      const verdict = keeper(r, l);
      if (verdict !== 'keep') filtered[verdict] += 1;
      return verdict === 'keep';
    });
  };
  const ids = Array.from(new Set(records.map((r) => r.containerId)));
  const geo = ids.map((id) => {
    const known = containers.find((c) => c.id === id);
    const latest = records.filter((r) => r.containerId === id && r.screenRect).sort((a, b) => b.seq - a.seq)[0];
    return { id, axis: (known && known.axis) || 'y', screenRect: (known && known.screenRect) || (latest && latest.screenRect) || null, viewport: known && known.viewport };
  });
  const labels = panelLabels(geo);
  const sections = geo
    .slice()
    .sort((a, b) => labels.get(a.id).index - labels.get(b.id).index)
    .map((g) => {
      const axis = g.axis === 'x' ? 'x' : 'y';
      const cov = ledger.coverage(g.id, { epoch, axis });
      const gaps = ledger.openGaps({ containerId: g.id, epoch });
      const segIds = Array.from(new Set([...cov.map((s) => s.id), ...gaps.map((x) => x.toSegmentId)])).sort((a, b) => a - b);
      const items = [];
      for (const segId of segIds) {
        if (gaps.some((x) => x.toSegmentId === segId)) items.push({ marker: true, text: GAP_MARKER, pos: -Infinity, seg: segId });
        const segRecords = records.filter((r) => r.containerId === g.id && r.segmentId === segId && usable(r))
          .sort((a, b) => a.seq - b.seq);
        const before = { ...filtered };
        let lines = dedupeLines(segRecords.flatMap(linesOf));
        if (g.id === 'root') {
          const split = splitRootLines(lines, geo, records, labels);
          lines = split.own;
          items.push(...split.items);
        }
        for (const block of toBlocks(lines)) {
          items.push({ ...block, pos: axis === 'x' ? block.contentRect.x : block.y0, seg: segId });
        }
        const held = filtered.held - before.held;
        const other = filtered.other - before.other;
        if (held) items.push({ marker: true, text: `[… ${held} line(s) under a heading that may start a different problem are not included; they are kept until that is decided …]`, pos: Infinity, seg: segId });
        if (other) items.push({ marker: true, text: `[… ${other} line(s) belonging to other problems were left out …]`, pos: Infinity, seg: segId });
        const seg = cov.find((s) => s.id === segId);
        for (const cell of (seg ? seg.cells : [])) {
          const text = cellMarker(cell, axis);
          if (text) items.push({ marker: true, text, pos: cell.start, seg: segId, cell });
        }
      }
      items.sort((a, b) => a.seg - b.seg || a.pos - b.pos);
      const center = g.viewport ? rectCenter(g.viewport, axis) : null;
      const [v0, v1] = g.viewport ? (axis === 'x' ? [g.viewport.x, g.viewport.x + g.viewport.w] : [g.viewport.y, g.viewport.y + g.viewport.h]) : [null, null];
      const visible = g.viewport && g.id !== 'root' ? ` · visible now: ${axis}=${Math.round(v0)}..${Math.round(v1)}` : '';
      return { containerId: g.id, label: labels.get(g.id).label + visible, axis, center, items, cov, gaps: gaps.length };
    });
  return { epoch, sections, filtered };
}

function renderSection(section) {
  const parts = [`## ${section.label}`];
  for (const item of section.items) {
    if (item.marker) parts.push(item.text);
    else if (['code', 'output', 'error'].includes(item.kind)) parts.push(`[${item.kind}]\n\`\`\`\n${item.text}\n\`\`\``);
    else if (item.kind === 'text') parts.push(item.text);
    else parts.push(`[${item.kind}]\n${item.text}`);
  }
  if (!section.items.length) parts.push('[… nothing captured in this panel yet …]');
  return parts.join('\n');
}

function renderEpoch(ep) { return ep.sections.map(renderSection).join('\n\n'); }

function itemsLength(ep) { return renderEpoch(ep).length; }

/**
 * buildContext({ ledger, containers, currentEpoch, charBudget, focus })
 * Pure function of ledger records and container facts.
 */
function problemHeader(problem, excludedCount, candidate) {
  // Bracketed like the other structural markers; the title stays in the UI so
  // no screen text is repeated into the prompt.
  const lines = ['=== ACTIVE PROBLEM ==='];
  if (problem.status === 'identified' && problem.id) {
    lines.push(`[The screen shows problem ${problem.id}. Answer only this problem.]`);
  } else if (problem.status === 'detecting') {
    lines.push('[The screen changed and is still being read. Where the text below is incomplete, rely on the attached current screen image.]');
  } else {
    lines.push('[The current screen has too little instruction text to tell which problem it belongs to. Do not assume it continues an earlier problem.]');
  }
  if (candidate) lines.push('[A heading on screen may start a different problem. Text under it is not included below. Answer only the active problem unless the user asks about the other one.]');
  if (excludedCount) lines.push('[Earlier screens of other problems were removed on purpose. Never reuse their code, instructions or test cases.]');
  return lines.join('\n');
}

function buildContext({
  ledger, containers = [], currentEpoch = 0, charBudget = 12000, focus = null, includeEpoch = () => false, problem = null,
  attribute = null, activeProblemId = null, candidate = null, savedDigest = '',
} = {}) {
  const notes = [];
  const keeper = lineKeeper({ attribute, activeProblemId });
  const epochNums = Array.from(new Set(ledger.all().filter((r) => r.status === 'analysed' || r.status === 'retired' || r.epoch === currentEpoch).map((r) => r.epoch)));
  if (!epochNums.includes(currentEpoch)) epochNums.push(currentEpoch);
  const current = buildEpoch(ledger, currentEpoch, containers, keeper);
  const otherEpochs = epochNums.filter((e) => e !== currentEpoch);
  const hasText = (ep) => ep.sections.some((s) => s.items.some((i) => !i.marker));
  // With a line filter an earlier screen counts only for the lines of this problem (none when no problem is known).
  const built = otherEpochs.map((e) => (keeper ? (activeProblemId ? buildEpoch(ledger, e, [], keeper) : null) : (includeEpoch(e) ? buildEpoch(ledger, e, []) : null)));
  const excluded = otherEpochs.filter((e, i) => !built[i] || !hasText(built[i]));
  if (excluded.length) notes.push(`${excluded.length} earlier screen(s) showing other or unidentified content were left out.`);
  let previous = built.filter((ep) => ep && hasText(ep)).sort((a, b) => b.epoch - a.epoch);
  const saved = !previous.length && savedDigest ? String(savedDigest).slice(0, Math.max(0, Math.floor(charBudget / 3))) : '';

  const overhead = 1000;
  const size = () => itemsLength(current) + previous.reduce((n, ep) => n + itemsLength(ep) + 30, 0) + saved.length + overhead;
  while (previous.length && size() > charBudget) {
    const dropped = previous.pop();
    notes.push(`Dropped earlier screen (epoch ${dropped.epoch}) to fit the context budget.`);
  }
  let omitted = 0;
  if (size() > charBudget) {
    const pool = current.sections.flatMap((s) => s.items.filter((i) => !i.marker).map((i) => ({ s, i })));
    const dist = ({ s, i }) => Math.abs(i.pos - (focus && Number.isFinite(focus.y) && (!focus.containerId || focus.containerId === s.containerId)
      ? focus.y : (s.center ?? 0)));
    pool.sort((a, b) => dist(b) - dist(a));
    while (pool.length && size() > charBudget) {
      const { s, i } = pool.shift();
      s.items.splice(s.items.indexOf(i), 1);
      omitted += 1;
    }
    notes.push(`Context truncated to fit the budget: ${omitted} block(s) farthest from the focus were omitted.`);
  }

  const cur = ledger.counts({ epoch: currentEpoch });
  const gaps = current.sections.reduce((n, s) => n + s.gaps, 0);
  const cells = current.sections.flatMap((s) => s.cov.flatMap((seg) => seg.cells));
  const uncovered = cells.filter((c) => c.status === 'uncovered').length;
  const inflight = cur.captured + cur.analysing + cur.new;
  const coverage = {
    complete: cur.analysed > 0 && !omitted && gaps === 0 && cur.pending + cur.failed + cur.stale + inflight + uncovered === 0,
    gaps,
    pending: cur.pending,
    failed: cur.failed,
    stale: cur.stale,
    notes,
  };
  for (const s of current.sections) {
    for (const seg of s.cov) notes.push(`${s.label}: content seen ${s.axis}=${Math.round(seg.start)}..${Math.round(seg.end)} (segment ${seg.id}).`);
  }
  if (cur.inaccessible) notes.push(`${cur.inaccessible} area(s) hidden behind the app window were not captured.`);
  if (inflight) notes.push(`${inflight} region(s) were still queued or being analysed.`);
  if (uncovered) notes.push(`${uncovered} range(s) inside seen content were never captured.`);

  const out = [];
  if (problem) out.push(problemHeader(problem, excluded.length, candidate));
  out.push('=== SCREEN CONTEXT (current screen) ===', renderEpoch(current));
  if (previous.length) {
    out.push('=== Previously seen (earlier screens of this same problem, may no longer be visible) ===');
    for (const ep of previous) out.push(renderEpoch(ep));
  }
  if (saved) {
    out.push('=== Saved from an earlier session (this problem as it was read before; it may be outdated and is not on screen now) ===', saved);
  }
  out.push('=== COVERAGE ===');
  out.push(coverage.complete
    ? 'Everything captured on the current screen was analysed. Only the ranges listed above were seen; anything outside them was not captured.'
    : `INCOMPLETE: ${gaps} gap(s), ${cur.pending} pending, ${cur.failed} failed, ${cur.stale} stale, ${inflight} in progress`
      + `${uncovered ? `, ${uncovered} uncaptured range(s)` : ''}. Parts of the screen are missing from the text above.`);
  out.push('Do not invent or assume content that is not shown above. If the answer depends on a missing part, say that it was not captured.');

  const sections = current.sections.map((s) => ({
    containerId: s.containerId,
    label: s.label,
    blocks: s.items.filter((i) => !i.marker).map((i) => ({
      kind: i.kind, confidence: i.confidence, text: i.text, regionIds: i.regionIds, contentRect: i.contentRect,
    })),
    markers: s.items.filter((i) => i.marker).map((i) => i.text),
  }));
  const regionIds = Array.from(new Set(sections.flatMap((s) => s.blocks.flatMap((b) => b.regionIds))));
  // With a line filter, only crops whose text is in this context are evidence for it.
  const kept = new Set(regionIds);
  const withImage = (id) => ledger.get(id) && ledger.get(id).imageRef && (!keeper || kept.has(id));
  const viewportIds = [];
  for (const s of current.sections) {
    const known = containers.find((c) => c.id === s.containerId);
    const axis = s.axis;
    const hits = ledger.list({ containerId: s.containerId, epoch: currentEpoch, status: 'analysed' }).filter((r) => !r.duplicateOf && known && known.viewport && r.contentRect
      && (axis === 'x'
        ? r.contentRect.x < known.viewport.x + known.viewport.w && r.contentRect.x + r.contentRect.w > known.viewport.x
        : r.contentRect.y < known.viewport.y + known.viewport.h && r.contentRect.y + r.contentRect.h > known.viewport.y));
    viewportIds.push(...hits.sort((a, b) => b.seq - a.seq).slice(0, 2).map((r) => r.id));
  }
  const weak = ledger.list({ epoch: currentEpoch, status: 'analysed' })
    .filter((r) => !r.duplicateOf && ((r.confidence !== null && r.confidence < 0.6) || (r.text.length < 20 && r.contentRect && r.contentRect.w * r.contentRect.h >= 10000)))
    .map((r) => r.id);
  const tables = sections.flatMap((s) => s.blocks.filter((b) => b.kind === 'table').flatMap((b) => b.regionIds));
  const imageRegionIds = Array.from(new Set([...viewportIds, ...tables, ...weak])).filter(withImage).slice(0, MAX_IMAGE_REGIONS);

  return { text: out.join('\n\n'), sections, coverage, regionIds, imageRegionIds };
}

module.exports = { buildContext, panelLabels, detectSegmentMerge, GAP_MARKER };
