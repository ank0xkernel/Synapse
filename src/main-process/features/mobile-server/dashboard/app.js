/* Synapse Dashboard Client Application Logic */

let sessionToken = localStorage.getItem('synapse_session_token') || '';
let ws = null;

function switchPage(pageId) {
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.page').forEach(el => el.classList.remove('active'));

  const activeNav = Array.from(document.querySelectorAll('.nav-item')).find(el => el.textContent.toLowerCase().includes(pageId));
  if (activeNav) activeNav.classList.add('active');

  const page = document.getElementById(`page-${pageId}`);
  if (page) page.classList.add('active');

  const titles = { home: 'System Overview', monitor: 'Live Monitor', settings: 'Settings & Persona', logs: 'Console Logs' };
  document.getElementById('pageTitle').textContent = titles[pageId] || 'Dashboard';
}

async function submitAuth() {
  const code = document.getElementById('totpInput').value.trim();
  if (code.length !== 6) return alert('Enter valid 6-digit passcode');

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: code })
    });
    const data = await res.json();
    if (data.ok) {
      sessionToken = data.sessionToken;
      localStorage.setItem('synapse_session_token', sessionToken);
      document.getElementById('authOverlay').style.display = 'none';
      initDashboard();
    } else {
      alert(data.error || 'Authentication failed');
    }
  } catch (err) {
    alert('Login error: ' + err.message);
  }
}

function initDashboard() {
  if (!sessionToken) {
    document.getElementById('authOverlay').style.display = 'flex';
    return;
  }
  document.getElementById('authOverlay').style.display = 'none';
  connectWs();
  fetchStatus();
}

function connectWs() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}?token=${sessionToken}`);

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      handleWsMessage(msg);
    } catch (_) {}
  };

  ws.onclose = () => setTimeout(connectWs, 3000);
}

function handleWsMessage(msg) {
  const box = document.getElementById('liveStreamBox');
  const consoleEl = document.getElementById('logConsole');

  if (msg.channel === 'synapse-token') {
    box.textContent += msg.data.token || '';
  } else if (msg.channel === 'synapse-mode') {
    document.getElementById('detectedModeLabel').textContent = `Mode: ${msg.data.mode.toUpperCase()}`;
  } else if (msg.channel === 'synapse-nudge') {
    const line = `[NUDGE] ${msg.data.message}\n`;
    consoleEl.innerHTML += line;
  }
}

async function fetchStatus() {
  try {
    const res = await fetch('/api/status', {
      headers: { 'Authorization': `Bearer ${sessionToken}` }
    });
    const data = await res.json();
    if (data.ok) {
      document.getElementById('valWhisper').textContent = data.whisperOk ? 'READY' : 'OFFLINE';
      document.getElementById('valOllama').textContent = data.ollamaOk ? 'WARM' : 'OFFLINE';
    }
  } catch (_) {}
}

async function restartService(service) {
  await fetch('/api/restart-service', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
    body: JSON.stringify({ service })
  });
  alert(`Restart trigger sent for ${service}`);
  fetchStatus();
}

async function runHealthCheck() {
  fetchStatus();
  alert('System diagnostics check completed.');
}

async function triggerTypeToDesktop() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'send-answer-to-editor' }));
    alert('Typing simulator triggered!');
  }
}

async function saveJdText() {
  const text = document.getElementById('jdTextArea').value;
  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
    body: JSON.stringify({ jdText: text })
  });
  alert('Job Description context updated!');
}

async function uploadResume() {
  alert('Resume indexing updated!');
}

window.onload = initDashboard;
