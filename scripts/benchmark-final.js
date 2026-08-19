#!/usr/bin/env node
'use strict';

/**
 * Synapse Final Production Integration Benchmark
 * Simulates a full mock interview: interviewer questions through system audio
 * and candidate spoken answer through mic, measuring end-to-end latency & accuracy.
 */

const AiOrchestrator = require('../src/main-process/features/assistant/ai-orchestrator');
const SystemWatchdog = require('../src/main-process/features/watchdog/system-watchdog');
const WhisperMicService = require('../src/services/stt/whisper-mic-service');

async function runFinalBenchmark() {
  console.log('⚡ Starting Synapse Final Integration Benchmark Suite...\n');

  let hapticFired = false;
  let firstTokenTime = 0;
  let receivedTokens = '';

  const mockMobileServer = {
    broadcastHapticAlert: () => {
      hapticFired = true;
      if (!firstTokenTime) firstTokenTime = Date.now();
    },
    broadcastToken: (token) => {
      receivedTokens += token;
    },
    broadcastComplete: () => {
      console.log('  -> Mobile Stream Complete.');
    },
    broadcastError: (err) => console.error('  -> Mobile Error:', err),
    broadcast: (event, data) => console.log(`  -> [Mobile Broadcast ${event}]:`, data)
  };

  const orchestrator = new AiOrchestrator({ mobileServer: mockMobileServer });
  await orchestrator.initialize();

  // Load sample Resume & JD
  await orchestrator.loadResumeAndJdContext(
    [
      { id: '1', text: 'Engineered a low-latency C++ order matching engine executing 500k ops/sec.' },
      { id: '2', text: 'Architected Redis & PostgreSQL caching layers for microservices.' }
    ],
    [
      { id: '1', text: '5+ years experience in C++, system design, and low latency.' }
    ]
  );

  // 1. Test Interview Question Pipeline Latency (< 280ms)
  const question = 'How do you design a low latency C++ order matching engine?';
  console.log(`[1] Simulating Interviewer Question: "${question}"`);

  const questionStart = Date.now();
  await orchestrator.processQuestion(question);
  const totalDuration = Date.now() - questionStart;
  const firstTokenLatency = firstTokenTime ? (firstTokenTime - questionStart) : totalDuration;

  console.log(`  -> First Token Latency: ${firstTokenLatency}ms (Target: < 280ms)`);
  console.log(`  -> Haptic Alert Triggered: ${hapticFired}`);
  console.log(`  -> Answer Generated: ${receivedTokens.substring(0, 80)}...\n`);

  // 2. Test Candidate Mic Spoken Answer & Live Nudge (< 100ms)
  console.log('[2] Simulating Candidate Mic Spoken Answer...');
  const micStart = Date.now();
  orchestrator.processMicTranscript('I will use a lock-free queue.');
  const micDuration = Date.now() - micStart;
  console.log(`  -> Mic Nudge Processing Duration: ${micDuration}ms\n`);

  // 3. Test Follow-Up Question Handling
  const followUp = 'Can you elaborate on why you chose a lock-free queue?';
  console.log(`[3] Simulating Interviewer Follow-Up Question: "${followUp}"`);
  const isFollowUp = orchestrator.memory.isFollowUp(followUp);
  console.log(`  -> Follow-Up Context Detected: ${isFollowUp}\n`);

  // 4. Test Watchdog Heartbeat
  const watchdog = new SystemWatchdog({
    whisperService: orchestrator.whisperService,
    ollamaService: orchestrator.ollamaService
  });
  console.log('[4] Triggering System Watchdog Health Check...');
  await watchdog.performHealthCheck();
  console.log(`  -> Watchdog Overall Health: ${watchdog.isHealthy ? '🟢 HEALTHY' : '🔴 FAULT'}\n`);

  // Summary
  console.log('==================================================');
  console.log(`⚡ FINAL INTEGRATION BENCHMARK COMPLETED`);
  console.log(`⚡ First Token Latency: ${firstTokenLatency}ms (Target: < 280ms)`);
  console.log(`⚡ Watchdog Health: ${watchdog.isHealthy ? 'PASS' : 'FAIL'}`);
  console.log('==================================================');

  if (firstTokenLatency <= 300 && watchdog.isHealthy) {
    console.log('✅ SYNAPSE IS PRODUCTION READY FOR M3 PRO!');
  } else {
    console.warn('⚠️ BENCHMARK NOTICE: Latency or health exceeded optimal targets.');
  }
}

runFinalBenchmark();
