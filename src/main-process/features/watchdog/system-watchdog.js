'use strict';

const http = require('http');
const EventEmitter = require('events');

/**
 * SystemWatchdog
 * 10-second background heartbeat watchdog for whisper.cpp, Ollama, and audio services.
 * Handles auto-recovery and tray icon status alerts.
 */
class SystemWatchdog extends EventEmitter {
  constructor(options = {}) {
    super();
    this.checkIntervalMs = options.checkIntervalMs || 10000;
    this.whisperService = options.whisperService || null;
    this.ollamaService = options.ollamaService || null;
    this.timer = null;
    this.isHealthy = true;
  }

  start() {
    this.stop();
    console.log('[SystemWatchdog] Background health monitor started (10s interval).');
    this.timer = setInterval(() => this.performHealthCheck(), this.checkIntervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async performHealthCheck() {
    let whisperOk = true;
    let ollamaOk = true;

    // 1. Check Whisper.cpp Health
    if (this.whisperService && typeof this.whisperService.checkHealth === 'function') {
      whisperOk = await this.whisperService.checkHealth();
    }

    // 2. Check Ollama Metal Health
    if (this.ollamaService && typeof this.ollamaService.checkHealth === 'function') {
      ollamaOk = await this.ollamaService.checkHealth();
    }

    const overallOk = whisperOk && ollamaOk;
    if (overallOk !== this.isHealthy) {
      this.isHealthy = overallOk;
      console.log(`[SystemWatchdog] Health state change: ${overallOk ? 'HEALTHY 🟢' : 'FAULT 🔴'}`);
      this.emit('health-change', {
        healthy: overallOk,
        whisperOk,
        ollamaOk
      });
    }

    // Auto-recovery trigger
    if (!whisperOk && this.whisperService && typeof this.whisperService.start === 'function') {
      console.warn('[SystemWatchdog] Triggering auto-restart for Whisper.cpp...');
      this.whisperService.start().catch(err => console.error('[Watchdog] Whisper restart failed:', err.message));
    }

    if (!ollamaOk && this.ollamaService && typeof this.ollamaService.initialize === 'function') {
      console.warn('[SystemWatchdog] Triggering auto-restart for Ollama Metal...');
      this.ollamaService.initialize().catch(err => console.error('[Watchdog] Ollama restart failed:', err.message));
    }
  }
}

module.exports = SystemWatchdog;
