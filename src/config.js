require('dotenv').config();

function boolish(val) {
  if (!val) return false;
  return !['0', 'false', 'no', 'off'].includes(val.toLowerCase());
}

module.exports = {
  workerUrl: (process.env.CLOUD_MAIL_WORKER_URL || '').replace(/\/$/, ''),

  imapHost: process.env.IMAP_HOST || '0.0.0.0',
  imapPort: Number(process.env.IMAP_PORT || 143),
  smtpHost: process.env.SMTP_HOST || '0.0.0.0',
  smtpPort: Number(process.env.SMTP_PORT || 587),

  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 30000),
  maxInitialMessages: Number(process.env.MAX_INITIAL_MESSAGES || 500),

  tlsKeyPath: process.env.TLS_KEY_PATH || '',
  tlsCertPath: process.env.TLS_CERT_PATH || '',
};
