'use strict';

const path = require('path');
const { SECRET_PATTERNS } = require('./config');

/**
 * Security & Privacy Scrubber
 *
 * Prevents confidential credentials, private keys, API secrets,
 * and database passwords from being indexed or passed to any AI model.
 */

const SENSITIVE_FILENAME_PATTERNS = [
  /^\.env(?:\..+)?$/i,
  /id_rsa(?:\.pub)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /credentials\.json$/i,
  /service-account.*\.json$/i,
  /secrets?\.(?:json|ya?ml)$/i
];

function isSensitiveFile(filePath) {
  if (!filePath) return false;
  const basename = path.basename(filePath);
  return SENSITIVE_FILENAME_PATTERNS.some((pattern) => pattern.test(basename));
}

function hasSecrets(content) {
  if (typeof content !== 'string' || !content) return false;
  return SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(content);
  });
}

function scrubSecrets(content) {
  if (typeof content !== 'string' || !content) return '';
  let scrubbed = content;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    scrubbed = scrubbed.replace(pattern, '[REDACTED_CREDENTIAL]');
  }
  return scrubbed;
}

module.exports = {
  isSensitiveFile,
  hasSecrets,
  scrubSecrets
};

