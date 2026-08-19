'use strict';

/**
 * MicCaptureWorklet (AudioWorkletProcessor)
 * Captures 16kHz PCM audio from candidate's built-in microphone
 * and streams 16-bit Int16 mono chunks over local WebSocket to whisper.cpp (Port 8081).
 */
class MicCaptureWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 2048;
    this.buffer = new Float32Array(this.bufferSize);
    this.bufferIndex = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channelData = input[0];
    for (let i = 0; i < channelData.length; i++) {
      this.buffer[this.bufferIndex++] = channelData[i];
      if (this.bufferIndex >= this.bufferSize) {
        this.sendBuffer();
        this.bufferIndex = 0;
      }
    }

    return true;
  }

  sendBuffer() {
    // Convert Float32 [-1.0, 1.0] to Int16 [-32768, 32767]
    const pcmInt16 = new Int16Array(this.bufferSize);
    for (let i = 0; i < this.bufferSize; i++) {
      const s = Math.max(-1, Math.min(1, this.buffer[i]));
      pcmInt16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }

    this.port.postMessage(pcmInt16.buffer, [pcmInt16.buffer]);
  }
}

registerProcessor('mic-capture-worklet', MicCaptureWorklet);
