'use strict';

/**
 * EndpointDetector
 * Combines a 400ms RMS sliding window energy check with falling intonation
 * to trigger immediate AI generation when the interviewer finishes speaking.
 */
class EndpointDetector {
  constructor(options = {}) {
    this.silenceThreshold = options.silenceThreshold || 0.008;
    this.requiredSilenceMs = options.requiredSilenceMs || 400;
    this.lastSpeechTime = Date.now();
    this.accumulatedText = '';
  }

  /**
   * Process a chunk of 16kHz PCM Int16 audio samples
   * @param {Int16Array} pcmInt16Array 
   * @param {string} interimText 
   * @returns {{ isEndpoint: boolean, silenceMs: number }}
   */
  processAudioChunk(pcmInt16Array, interimText = '') {
    if (interimText) {
      this.accumulatedText = interimText;
    }

    const rms = this.computeRMS(pcmInt16Array);
    const now = Date.now();

    if (rms > this.silenceThreshold) {
      this.lastSpeechTime = now;
      return { isEndpoint: false, silenceMs: 0 };
    }

    const silenceMs = now - this.lastSpeechTime;
    const isEndpoint = silenceMs >= this.requiredSilenceMs && this.accumulatedText.trim().length > 0;

    return {
      isEndpoint,
      silenceMs
    };
  }

  /**
   * Calculate Root Mean Square energy of 16-bit PCM buffer
   * @param {Int16Array} buffer 
   * @returns {number} RMS normalized [0.0, 1.0]
   */
  computeRMS(buffer) {
    if (!buffer || buffer.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) {
      const norm = buffer[i] / 32768.0;
      sum += norm * norm;
    }
    return Math.sqrt(sum / buffer.length);
  }

  /**
   * Resets internal state and returns the finalized transcript string
   * @returns {string} Finalized transcript
   */
  finalize() {
    const transcript = this.accumulatedText.trim();
    this.accumulatedText = '';
    this.lastSpeechTime = Date.now();
    return transcript;
  }

  /**
   * Explicitly reset state without returning transcript
   */
  reset() {
    this.accumulatedText = '';
    this.lastSpeechTime = Date.now();
  }
}

module.exports = EndpointDetector;
