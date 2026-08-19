'use strict';

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const EventEmitter = require('events');
const constants = require('./stt-constants');
const capabilities = require('../system-capabilities');

// process.cwd() is the launch directory, not the app directory.
const PROJECT_ROOT = path.join(__dirname, '..', '..', '..');

class WhisperCoreMLService extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port || constants.WHISPER_PORT;
    this.host = options.host || constants.WHISPER_HOST;
    this.model = options.model || constants.DEFAULT_MODEL;
    this.binaryPath = options.binaryPath || path.join(PROJECT_ROOT, 'bin', 'whisper.cpp', 'server');
    this.modelPath = options.modelPath || path.join(PROJECT_ROOT, 'bin', 'whisper.cpp', 'models', this.model);

    this.childProcess = null;
    this.restartAttempts = 0;
    this.maxRestartAttempts = constants.MAX_RESTART_ATTEMPTS;
    this.healthCheckTimer = null;
    this.restartTimer = null;
    this.isStarting = false;
    this.isStopped = false;
    this.status = 'offline'; // offline | starting | ready | error | unavailable
  }

  async start() {
    if (this.childProcess || this.isStarting) {
      console.log('[WhisperCoreML] Process already running or starting.');
      return;
    }

    // Spawning without a model produces an instant exit, which used to feed
    // the restart path and spawn processes in a loop. Check first.
    const assets = capabilities.checkWhisperAssets(this.binaryPath, this.modelPath);
    if (!assets.available) {
      this.setStatus('unavailable', assets.missing.join('; '));
      console.warn(`[WhisperCoreML] Not starting — ${assets.missing.join('; ')}`);
      if (assets.hint) console.warn(`[WhisperCoreML] ${assets.hint}`);
      return;
    }

    this.isStarting = true;
    this.isStopped = false;
    this.setStatus('starting', 'Spawning whisper.cpp server...');

    // NOTE: --step/--length/-vAD belong to the `whisper-stream` example, not
    // `server`. Passing them makes the server exit with "unknown argument".
    const args = [
      '-m', this.modelPath,
      '--port', String(this.port),
      '--host', this.host,
      '-t', '4'
    ];

    console.log(`[WhisperCoreML] Launching: ${this.binaryPath} ${args.join(' ')}`);

    try {
      this.childProcess = spawn('nice', ['-n', '10', this.binaryPath, ...args], {
        stdio: ['ignore', 'pipe', 'pipe']
      });

      this.childProcess.stdout.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) console.log(`[WhisperCoreML stdout] ${msg}`);
      });

      this.childProcess.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) console.warn(`[WhisperCoreML stderr] ${msg}`);
      });

      this.childProcess.on('exit', (code, signal) => {
        console.error(`[WhisperCoreML] Server exited with code ${code}, signal ${signal}`);
        this.childProcess = null;
        this.setStatus('offline', 'Process exited');
        // Only the health-check path below schedules restarts. Restarting from
        // here as well produced two restart chains per failure, and each of
        // those spawned two more — a process storm on every bad launch.
      });

      this.childProcess.on('error', (err) => {
        console.error('[WhisperCoreML] Process error:', err.message);
        this.emit('error', err);
      });

      const healthy = await this.waitForHealth(10, 1000);
      if (healthy) {
        this.restartAttempts = 0;
        this.isStarting = false;
        this.setStatus('ready', 'Whisper server ready');
        this.startHealthCheckLoop();
        return;
      }

      throw new Error('Health check timed out');
    } catch (error) {
      console.error('[WhisperCoreML] Startup failed:', error.message);
      this.setStatus('error', error.message);
      this.isStarting = false;
      this.killChild();
      this.handleUnexpectedExit();
    }
  }

  killChild() {
    if (this.childProcess) {
      try {
        this.childProcess.kill('SIGTERM');
      } catch (_) {
        // already gone
      }
      this.childProcess = null;
    }
  }

  async waitForHealth(maxRetries = 10, intervalMs = 1000) {
    for (let i = 0; i < maxRetries; i++) {
      const isHealthy = await this.checkHealth();
      if (isHealthy) return true;
      await new Promise(res => setTimeout(res, intervalMs));
    }
    return false;
  }

  checkHealth() {
    return new Promise((resolve) => {
      const req = http.get(`http://${this.host}:${this.port}/health`, (res) => {
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(800, () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  startHealthCheckLoop() {
    this.stopHealthCheckLoop();
    this.healthCheckTimer = setInterval(async () => {
      const ok = await this.checkHealth();
      if (!ok && this.status === 'ready') {
        console.warn('[WhisperCoreML] Health check failed during runtime.');
        this.setStatus('error', 'Health check failed');
        // killChild, not stop() — stop() marks the service as deliberately
        // stopped, which would suppress the restart we want here.
        this.stopHealthCheckLoop();
        this.killChild();
        this.handleUnexpectedExit();
      }
    }, constants.HEALTH_CHECK_INTERVAL_MS);
  }

  stopHealthCheckLoop() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  async handleUnexpectedExit() {
    this.stopHealthCheckLoop();

    if (this.isStopped || this.restartTimer) {
      return;
    }

    if (this.restartAttempts < this.maxRestartAttempts) {
      this.restartAttempts++;
      console.log(`[WhisperCoreML] Attempting auto-restart (${this.restartAttempts}/${this.maxRestartAttempts}) in ${constants.RESTART_DELAY_MS}ms...`);
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this.start();
      }, constants.RESTART_DELAY_MS);
    } else {
      console.error('[WhisperCoreML] Maximum restart threshold reached. Manual restart required.');
      this.setStatus('error', 'Max restart limit reached');
      this.emit('fault', 'Whisper Core ML server failed after 3 restart attempts.');
    }
  }

  setStatus(status, message = '') {
    this.status = status;
    this.emit('status-change', { status, message });
  }

  async stop() {
    this.isStopped = true;
    this.stopHealthCheckLoop();

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (this.childProcess) {
      console.log('[WhisperCoreML] Stopping server process...');
      this.killChild();
    }

    this.setStatus('offline', 'Stopped');
  }
}

module.exports = WhisperCoreMLService;
