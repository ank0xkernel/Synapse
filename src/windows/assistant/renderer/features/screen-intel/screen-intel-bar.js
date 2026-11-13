// Screen intelligence bar: shows what continuous screen monitoring has really
// captured and analysed. Renders only from snapshots pushed by the main
// process; the single timer rewrites one text node.

import {
  STATUS_LABELS, buildCoverage, describeCandidate, describeProblem, describeProblemResult, describeProblems, describeStatus, describeTime, formatClock, formatDuration, tickInterval
} from './screen-intel-view.js';

const api = window.electronAPI;
const $ = (id) => document.getElementById(id);
const root = $('screen-intel');

if (root && api?.onScreenIntelState) {
  const el = {
    primary: $('screen-intel-primary'), hint: $('screen-intel-hint'), time: $('screen-intel-time'), chips: $('screen-intel-chips'),
    retry: $('screen-intel-retry'), pause: $('screen-intel-pause'), stop: $('screen-intel-stop'), toggle: $('screen-intel-toggle'),
    details: $('screen-intel-details'), monitoring: $('screen-intel-monitoring'), view: $('screen-intel-view'),
    lastCapture: $('screen-intel-last-capture'), lastAnalysis: $('screen-intel-last-analysis'), duration: $('screen-intel-duration'), problem: $('screen-intel-problem'),
    maps: $('screen-intel-maps'), regions: $('screen-intel-regions'), error: $('screen-intel-error'),
    inspector: $('screen-intel-inspector'), inspectorTitle: $('screen-intel-inspector-title'), inspectorText: $('screen-intel-inspector-text'),
    inspectorImage: $('screen-intel-inspector-image'), reanalyse: $('screen-intel-reanalyse'), latest: $('screen-intel-latest'), restart: $('screen-intel-restart'),
    newProblem: $('screen-intel-new-problem'), candidate: $('screen-intel-candidate'), candidateText: $('screen-intel-candidate-text'),
    candidateNew: $('screen-intel-candidate-new'), candidateSame: $('screen-intel-candidate-same'), problems: $('screen-intel-problems')
  };

  let snapshot = null;
  let timer = null;
  let timerPeriod = 0;
  let selectedRegion = null;
  // One problem action at a time: a second click while one runs does nothing.
  let problemBusy = false;
  let notice = null;
  let noticeTimer = null;

  function showNotice(next) {
    clearTimeout(noticeTimer);
    notice = next;
    if (notice) noticeTimer = setTimeout(() => { notice = null; if (snapshot) render(snapshot); }, 4000);
    if (snapshot) render(snapshot);
  }

  async function problemAction(run, action) {
    if (problemBusy) return;
    problemBusy = true;
    for (const button of [el.newProblem, el.candidateNew, el.candidateSame]) { button.disabled = true; button.setAttribute('aria-busy', 'true'); }
    try {
      showNotice(describeProblemResult(await run(), action));
    } catch (error) {
      showNotice({ tone: 'danger', text: error.message || 'The problem could not be changed.' });
    } finally {
      problemBusy = false;
      for (const button of [el.newProblem, el.candidateNew, el.candidateSame]) { button.disabled = false; button.removeAttribute('aria-busy'); }
    }
  }

  function paintProblems() {
    el.problems.replaceChildren(...describeProblems(snapshot.problems).map((item) => {
      const row = node('li', 'screen-intel-problem');
      row.dataset.active = String(item.active);
      if (item.active) row.setAttribute('aria-current', 'true');
      const text = node('div', 'screen-intel-problem-text');
      text.append(node('span', 'screen-intel-problem-label', item.label), node('span', 'screen-intel-problem-meta', item.meta));
      row.append(text);
      if (item.canSwitch) {
        const button = node('button', 'btn btn-ghost btn-sm', 'Switch');
        button.type = 'button';
        button.setAttribute('aria-label', `Switch to ${item.label}`);
        button.addEventListener('click', () => problemAction(() => api.screenIntelActivateProblem(item.id), 'switch'));
        row.append(button);
      }
      return row;
    }));
  }

  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };

  function paintTime() {
    const text = describeTime(snapshot, Date.now());
    if (el.time.textContent !== text) el.time.textContent = text;
  }

  function syncTimer() {
    const period = root.hidden ? 0 : tickInterval(snapshot);
    if (period === timerPeriod) return;
    clearInterval(timer);
    timerPeriod = period;
    timer = period ? setInterval(paintTime, period) : null;
  }

  function showInspector({ title, text, imageDataUrl, regionId }) {
    selectedRegion = regionId || null;
    el.inspectorTitle.textContent = title;
    el.inspectorText.textContent = text || 'No text was read from this region.';
    el.inspectorImage.hidden = !imageDataUrl;
    if (imageDataUrl) el.inspectorImage.src = imageDataUrl;
    else el.inspectorImage.removeAttribute('src');
    el.reanalyse.hidden = !regionId;
    el.inspector.hidden = false;
  }

  async function inspectRegion(regionId) {
    const region = await api.screenIntelGetRegion(regionId);
    if (!region) return;
    const label = STATUS_LABELS[region.status] || region.status;
    const failure = region.error ? `\n\n${region.error.message}` : '';
    showInspector({
      title: `${label} · captured ${formatClock(region.capturedAt)}`,
      text: `${region.text || ''}${failure}`.trim(),
      imageDataUrl: region.imageDataUrl,
      regionId
    });
  }

  function paintMaps() {
    el.maps.replaceChildren(...buildCoverage(snapshot).map((map) => {
      const row = node('div', 'screen-intel-map');
      row.append(node('span', 'screen-intel-map-label', map.label));
      const track = node('div', 'screen-intel-track');
      track.setAttribute('role', 'group');
      track.setAttribute('aria-label', `${map.label}: ${map.summary}`);
      for (const part of map.parts) {
        const cell = node(part.regionId ? 'button' : 'span', 'screen-intel-cell');
        cell.dataset.status = part.status;
        cell.title = part.label;
        if (part.status === 'gap') {
          cell.textContent = '⋯';
        } else {
          cell.style.flexGrow = String(Math.max(part.share, 0.01));
        }
        if (part.regionId) {
          cell.type = 'button';
          cell.setAttribute('aria-label', `${part.label}. Inspect region.`);
          cell.addEventListener('click', () => inspectRegion(part.regionId));
        }
        track.append(cell);
      }
      row.append(track, node('span', 'screen-intel-map-summary', map.summary));
      return row;
    }));
  }

  function paintRegions() {
    el.regions.replaceChildren(...(snapshot.regions || []).slice(0, 12).map((region) => {
      const item = node('li');
      const button = node('button', 'screen-intel-region');
      button.type = 'button';
      button.dataset.status = region.status;
      button.append(
        node('span', 'screen-intel-region-status', STATUS_LABELS[region.status] || region.status),
        node('span', 'screen-intel-region-preview', region.error ? region.error.message : (region.preview || 'No text')),
        node('span', 'screen-intel-region-time', formatClock(region.capturedAt))
      );
      button.addEventListener('click', () => inspectRegion(region.id));
      item.append(button);
      return item;
    }));
  }

  function render(next) {
    snapshot = next;
    const status = describeStatus(snapshot);
    root.hidden = !status.visible;
    document.body.classList.toggle('screen-intel-active', status.visible && snapshot.monitoring !== 'stopped');
    if (!status.visible) return syncTimer();

    root.dataset.tone = notice ? notice.tone : status.tone;
    el.primary.textContent = notice ? notice.text : status.primary;
    el.hint.textContent = notice ? '' : status.hint;
    const candidate = describeCandidate(snapshot.problem);
    el.candidate.hidden = !candidate;
    if (candidate) {
      el.candidateText.textContent = candidate.text;
      el.candidate.dataset.cut = candidate.id;
    }
    el.chips.replaceChildren(...status.chips.map((chip) => {
      const element = node('span', 'screen-intel-chip', chip.text);
      element.dataset.status = chip.status;
      return element;
    }));
    el.retry.hidden = !status.canRetry;
    const stopped = snapshot.monitoring === 'stopped';
    el.pause.hidden = stopped;
    el.stop.hidden = stopped;
    el.pause.textContent = snapshot.monitoring === 'paused' ? 'Resume' : 'Pause';
    el.monitoring.textContent = status.monitoring;
    el.view.textContent = status.view;
    el.lastCapture.textContent = formatClock(snapshot.lastCaptureAt);
    el.lastAnalysis.textContent = formatClock(snapshot.lastAnalysisAt);
    el.duration.textContent = formatDuration(snapshot.lastAnalysisDurationMs);
    el.problem.textContent = describeProblem(snapshot.problem);
    el.error.textContent = status.error;
    el.error.hidden = !status.error;
    if (!el.details.hidden) {
      paintMaps();
      paintRegions();
      paintProblems();
    }
    paintTime();
    return syncTimer();
  }

  el.toggle.addEventListener('click', () => {
    el.details.hidden = !el.details.hidden;
    el.toggle.setAttribute('aria-expanded', String(!el.details.hidden));
    if (!el.details.hidden && snapshot) {
      paintMaps();
      paintRegions();
      paintProblems();
    } else {
      el.inspector.hidden = true;
    }
  });
  el.retry.addEventListener('click', () => api.screenIntelRetry());
  // The chat context is cut before main is asked, so nothing typed or sent
  // from this moment can carry the previous problem (renderer.js listens).
  el.newProblem.addEventListener('click', () => problemAction(() => {
    window.dispatchEvent(new CustomEvent('synapse:new-problem'));
    return api.screenIntelNewProblem();
  }, 'new'));
  el.candidateNew.addEventListener('click', () => {
    const cutId = el.candidate.dataset.cut;
    if (cutId) problemAction(() => api.screenIntelResolveCandidate({ cutId, choice: 'new' }), 'new');
  });
  el.candidateSame.addEventListener('click', () => {
    const cutId = el.candidate.dataset.cut;
    if (cutId) problemAction(() => api.screenIntelResolveCandidate({ cutId, choice: 'same' }), 'same');
  });
  el.pause.addEventListener('click', () => (snapshot?.monitoring === 'paused' ? api.screenIntelResume() : api.screenIntelPause()));
  el.stop.addEventListener('click', () => api.screenIntelStop());
  el.restart.addEventListener('click', () => {
    el.inspector.hidden = true;
    api.screenIntelRestart();
  });
  el.reanalyse.addEventListener('click', () => selectedRegion && api.screenIntelReanalyse(selectedRegion));
  el.latest.addEventListener('click', async () => {
    const frame = await api.screenIntelGetLatestFrame();
    const imageDataUrl = typeof frame === 'string' ? frame : null;
    showInspector({
      title: 'Latest captured screen',
      text: imageDataUrl ? 'This is the most recent frame from the monitoring stream.' : 'No frame is available. Monitoring may be paused or stopped.',
      imageDataUrl
    });
  });
  $('screen-intel-inspector-close').addEventListener('click', () => {
    el.inspector.hidden = true;
  });

  api.onScreenIntelState(render);
  api.screenIntelGetState().then((state) => state && !state.error && render(state));
}
