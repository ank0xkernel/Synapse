/* Synapse Dashboard REST & WebSocket Client Manager */

class SynapseApiClient {
  constructor() {
    this.sessionToken = localStorage.getItem('synapse_session_token') || '';
    this.ws = null;
    this.onMessageCallback = null;
  }

  setToken(token) {
    this.sessionToken = token;
    localStorage.setItem('synapse_session_token', token);
  }

  async login(totpCode) {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: totpCode })
    });
    const data = await res.json();
    if (data.ok) {
      this.setToken(data.sessionToken);
    }
    return data;
  }

  async fetchStatus() {
    const res = await fetch('/api/status', {
      headers: { 'Authorization': `Bearer ${this.sessionToken}` }
    });
    return res.json();
  }

  async restartService(serviceName) {
    const res = await fetch('/api/restart-service', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.sessionToken}` },
      body: JSON.stringify({ service: serviceName })
    });
    return res.json();
  }

  async updateJdContext(jdText) {
    const res = await fetch('/api/jd', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.sessionToken}` },
      body: JSON.stringify({ jdText })
    });
    return res.json();
  }

  connectWebSocket(onMessage) {
    this.onMessageCallback = onMessage;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/dashboard-ws?token=${this.sessionToken}`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (this.onMessageCallback) this.onMessageCallback(payload);
      } catch (_) {}
    };

    this.ws.onclose = () => {
      setTimeout(() => this.connectWebSocket(onMessage), 3000);
    };
  }

  sendWsCommand(type, payload = {}) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, ...payload }));
    }
  }
}

window.apiClient = new SynapseApiClient();
