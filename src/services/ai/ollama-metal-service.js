'use strict';

const http = require('http');
const { spawn } = require('child_process');
const EventEmitter = require('events');
const capabilities = require('../system-capabilities');

class OllamaMetalService extends EventEmitter {
  constructor(options = {}) {
    super();
    this.host = options.host || '127.0.0.1';
    this.port = options.port || 11434;
    this.model = options.model || 'codeqwen:7b-chat-v1.5-q4_K_M';
    this.ollamaProcess = null;
    this.isWarm = false;
    this.isAvailable = false;

    // How long Ollama keeps the model resident after a request. The old value
    // was -1 ("never unload"), which pins several GB permanently — on a small
    // machine that pushes the whole desktop into swap. A timeout keeps the
    // common case fast while letting memory come back when you stop using it.
    this.keepAlive = options.keepAlive || '5m';

    // Pre-warming trades a large, immediate memory allocation for a faster
    // first answer. Only worth it on a machine with room to spare.
    this.preWarm = options.preWarm ?? capabilities.canRunLocalLlm();
  }

  async initialize() {
    const isRunning = await this.checkHealth();
    if (!isRunning) {
      console.log('[OllamaMetal] Ollama not running. Attempting to spawn background server...');
      this.spawnOllama();
      const becameHealthy = await this.waitForHealth(10, 1000);
      if (!becameHealthy) {
        console.warn('[OllamaMetal] Ollama did not come up; local generation is unavailable.');
        return;
      }
    }

    const resolved = await this.resolveAvailableModel();
    if (!resolved) {
      return;
    }

    this.isAvailable = true;

    if (this.preWarm) {
      await this.preWarmModel();
    } else {
      console.log(
        `[OllamaMetal] Skipping pre-warm on ${capabilities.describeMachine()} — `
        + `${this.model} will load on first use (slower first answer, no idle memory cost).`
      );
    }
  }

  spawnOllama() {
    try {
      // Launched through `nice` for the same reason as the two Whisper servers:
      // this competes with the video call itself for CPU, and a dropped frame
      // in the call is worse than a slightly later first token. The Whisper
      // services already did this; Ollama was the one heavy child process
      // still spawning at default priority.
      this.ollamaProcess = spawn('nice', ['-n', '10', 'ollama', 'serve'], { stdio: 'ignore' });
      this.ollamaProcess.on('error', (err) => {
        console.error('[OllamaMetal] Failed to spawn Ollama:', err.message);
      });
    } catch (err) {
      console.error('[OllamaMetal] Spawn exception:', err.message);
    }
  }

  checkHealth() {
    return new Promise((resolve) => {
      const req = http.get(`http://${this.host}:${this.port}/api/version`, (res) => {
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(800, () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  /**
   * Picks a locally installed model that actually fits in this machine's
   * memory. Returns false when nothing suitable is installed — callers should
   * treat that as "local generation unavailable" rather than pushing on.
   */
  async resolveAvailableModel() {
    const models = await this.listInstalledModels();

    if (models.length === 0) {
      console.warn('[OllamaMetal] No models installed. Run: ollama pull qwen2.5-coder:1.5b');
      return false;
    }

    if (models.includes(this.model) && capabilities.canRunLocalLlm()) {
      return true;
    }

    const { model, reason } = capabilities.selectModelForMemory(models);

    if (!model) {
      console.warn(`[OllamaMetal] ${reason}`);
      console.warn(
        '[OllamaMetal] Local generation disabled to protect system memory. '
        + 'Either use the Gemini provider, or install a smaller model: '
        + 'ollama pull qwen2.5-coder:1.5b'
      );
      return false;
    }

    if (model !== this.model) {
      console.log(`[OllamaMetal] ${reason}`);
      this.model = model;
    }

    return true;
  }

  listInstalledModels() {
    return new Promise((resolve) => {
      const req = http.get(`http://${this.host}:${this.port}/api/tags`, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            resolve((data.models || []).map((m) => m.name));
          } catch (_) {
            resolve([]);
          }
        });
      });
      req.on('error', () => resolve([]));
      req.setTimeout(2000, () => {
        req.destroy();
        resolve([]);
      });
    });
  }

  async waitForHealth(maxRetries = 10, intervalMs = 1000) {
    for (let i = 0; i < maxRetries; i++) {
      if (await this.checkHealth()) return true;
      await new Promise(res => setTimeout(res, intervalMs));
    }
    return false;
  }

  async preWarmModel() {
    console.log(`[OllamaMetal] Pre-warming ${this.model} in unified memory...`);
    try {
      // Yield to the event loop so the UI paints before the allocation.
      await new Promise((res) => setTimeout(res, 500));
      await this.generateResponse('ping', { max_tokens: 1, num_ctx: 128 });
      this.isWarm = true;
      console.log(`[OllamaMetal] ${this.model} warm and ready.`);
    } catch (err) {
      console.warn(`[OllamaMetal] Pre-warm notice: ${err.message}`);
    }
  }

  async streamResponse(prompt, onToken, options = {}) {
    const modelToUse = options.model || this.model;
    const postData = JSON.stringify({
      model: modelToUse,
      prompt: prompt,
      stream: true,
      options: {
        num_ctx: options.num_ctx || 2048,
        mirostat: options.mirostat || 2,
        temperature: options.temperature || 0.2
      },
      keep_alive: options.keep_alive !== undefined ? options.keep_alive : this.keepAlive
    });

    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: this.host,
        port: this.port,
        path: '/api/generate',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      }, (res) => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Ollama API error status ${res.statusCode}`));
        }

        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const parsed = JSON.parse(line);
              if (parsed.response && onToken) {
                onToken(parsed.response);
              }
            } catch (_) {}
          }
        });

        res.on('end', () => resolve());
      });

      if (options.signal) {
        options.signal.addEventListener('abort', () => req.destroy());
      }

      req.on('error', (err) => reject(err));
      req.write(postData);
      req.end();
    });
  }

  async generateResponse(prompt, options = {}) {
    let resultText = '';
    await this.streamResponse(prompt, (token) => {
      resultText += token;
    }, options);
    return resultText;
  }

  async stop() {
    if (this.pingTimer) clearInterval(this.pingTimer);
  }
}

module.exports = OllamaMetalService;
