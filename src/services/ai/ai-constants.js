'use strict';

module.exports = {
  DEFAULT_OLLAMA_MODEL: 'codeqwen:7b-chat-v1.5-q4_K_M',
  OLLAMA_CTX_SIZE: 2048,
  OLLAMA_MIROSTAT: 2,
  OLLAMA_TEMPERATURE: 0.15,
  OLLAMA_NUM_PREDICT: 384,
  KEEP_ALIVE_PING_INTERVAL_MS: 3 * 60 * 1000, // 3 minutes
  EMBEDDING_MODEL_NAME: 'Xenova/all-MiniLM-L6-v2'
};
