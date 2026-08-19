'use strict';

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const EventEmitter = require('events');
const capabilities = require('../system-capabilities');

const PROJECT_ROOT = path.join(__dirname, '..', '..', '..');

/**
 * WhisperMicService
 * Spawns a secondary whisper.cpp server instance on port 8081 using ggml-tiny.en.bin
 * for fast transcription of your own microphone.
 */
class WhisperMicService extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port || 8081;
    this.host = options.host || '127.0.0.1';
    this.model = options.model || 'ggml-tiny.en.bin';
    this.binaryPath = options.binaryPath || path.join(PROJECT_ROOT, 'bin', 'whisper.cpp', 'server');
    this.modelPath = options.modelPath || path.join(PROJECT_ROOT, 'bin', 'whisper.cpp', 'models', this.model);
    this.childProcess = null;
  }

  async start() {
    if (this.childProcess) {
      console.log('[WhisperMicService] Mic STT server already running.');
      return;
    }

    const assets = capabilities.checkWhisperAssets(this.binaryPath, this.modelPath);
    if (!assets.available) {
      console.warn(`[WhisperMicService] Not starting — ${assets.missing.join('; ')}`);
      if (assets.hint) console.warn(`[WhisperMicService] ${assets.hint}`);
      return;
    }

    // `server` does not accept --step/--length/-vAD (those are whisper-stream).
    const args = [
      '-m', this.modelPath,
      '--port', String(this.port),
      '--host', this.host,
      '-t', '2'
    ];

    console.log(`[WhisperMicService] Spawning candidate mic STT server on port ${this.port}...`);
    try {
      this.childProcess = spawn('nice', ['-n', '10', this.binaryPath, ...args], { stdio: 'ignore' });

      this.childProcess.on('exit', (code, signal) => {
        console.warn(`[WhisperMicService] Candidate mic STT process exited with code ${code}, signal ${signal}`);
        this.childProcess = null;
      });

      this.childProcess.on('error', (err) => {
        console.error('[WhisperMicService] Process error:', err.message);
      });
    } catch (err) {
      console.error('[WhisperMicService] Failed to spawn candidate mic server:', err.message);
    }
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

  async stop() {
    if (this.childProcess) {
      console.log('[WhisperMicService] Stopping candidate mic STT server...');
      this.childProcess.kill('SIGTERM');
      this.childProcess = null;
    }
  }
}

module.exports = WhisperMicService;
