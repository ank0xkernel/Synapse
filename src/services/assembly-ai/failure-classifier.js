'use strict';

/**
 * Classifies an AssemblyAI v3 streaming failure into what the app should do.
 *
 * Source: AssemblyAI "Common session errors and closures"
 * (https://www.assemblyai.com/docs/streaming/common-session-errors-and-closures).
 * Before closing on an error the server sends an `Error` frame
 * ({type: "Error", error_code, error}) and then closes with the same code.
 * The close reason is often just "See Error message for details", so the
 * frame text is the reliable signal. A failed upgrade (no WebSocket at all)
 * surfaces from the `ws` library as "Unexpected server response: <status>".
 *
 * kinds:
 *   auth        key missing, invalid, disabled or deleted      permanent
 *   billing     insufficient funds / no billing account         permanent
 *   rate-limit  too many new sessions this minute (1008), 429   retry with backoff
 *   config      bad message, chunk size, send rate, old URL     permanent (a bug)
 *   expired     3 h session cap reached (3008)                  retry (new session)
 *   inactivity  inactivity_timeout reached                      retry
 *   server      1011, 3005, 5xx                                 retry with backoff
 *   network     socket dropped, DNS, timeout (1006, ECONN*)     retry with backoff
 *   normal      clean close                                     nothing to do
 */

const MESSAGES = {
  auth: 'AssemblyAI rejected the API key: it is invalid, disabled or deleted. Create a new key in your AssemblyAI dashboard and paste it into Settings.',
  billing: 'AssemblyAI refused the session because of the account\'s billing status. Check your balance or billing setup in the AssemblyAI dashboard.',
  'rate-limit': 'AssemblyAI is limiting how many sessions can start per minute. Reconnecting shortly.',
  config: 'AssemblyAI rejected the audio stream format. This is a Synapse bug; copy diagnostics from the Session panel and report it.',
  expired: 'The transcription session reached AssemblyAI\'s 3-hour limit. Starting a new session.',
  inactivity: 'The transcription session closed after a long silence. Reconnecting.',
  server: 'AssemblyAI had a server error. Reconnecting.',
  network: 'Lost the connection to AssemblyAI. Reconnecting.',
  normal: ''
};

function result(kind, retryable, detail = '') {
  return { kind, retryable, message: MESSAGES[kind], detail: String(detail || '').slice(0, 200) };
}

function classifyHttpStatus(status) {
  if (status === 401 || status === 403 || status === 409) return result('auth', false, `HTTP ${status}`);
  if (status === 402) return result('billing', false, `HTTP ${status}`);
  if (status === 429) return result('rate-limit', true, `HTTP ${status}`);
  if (status === 410 || status === 400 || status === 404) return result('config', false, `HTTP ${status}`);
  if (status >= 500) return result('server', true, `HTTP ${status}`);
  return result('config', false, `HTTP ${status}`);
}

/**
 * @param {object} failure
 * @param {number} [failure.code]       WebSocket close code, or the Error frame's error_code
 * @param {string} [failure.errorText]  Error frame text, or the close reason
 * @param {string} [failure.socketError] message of a ws 'error' event (handshake/network)
 * @returns {{kind: string, retryable: boolean, message: string, detail: string}}
 */
function classifyStreamingFailure({ code, errorText = '', socketError = '' } = {}) {
  const text = String(errorText || '');

  if (socketError) {
    const status = /Unexpected server response: (\d{3})/.exec(socketError);
    if (status) return classifyHttpStatus(Number(status[1]));
    return result('network', true, socketError);
  }

  switch (code) {
    case 1000:
    case 1005:
      return result('normal', false, text);
    case 1008:
      if (/too many concurrent/i.test(text)) return result('rate-limit', true, text);
      if (/insufficient funds|metronome|billing/i.test(text)) return result('billing', false, text);
      return result('auth', false, text || 'Unauthorized connection');
    case 1011:
      return result('server', true, text);
    case 3005:
      return result('server', true, text);
    case 3006:
      return /inactivity/i.test(text) ? result('inactivity', true, text) : result('config', false, text);
    case 3007:
      return result('config', false, text);
    case 3008:
      return result('expired', true, text);
    case 1006:
    case 1001:
    case 1012:
    case 1013:
    case 1014:
      return result('network', true, text || `close ${code}`);
    default:
      return result(code >= 4000 ? 'config' : 'network', code < 4000, text || `close ${code}`);
  }
}

module.exports = { classifyStreamingFailure, FAILURE_MESSAGES: MESSAGES };
