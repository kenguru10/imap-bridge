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
  smtpRequireTls: boolish(process.env.SMTP_REQUIRE_TLS),
  smtpAuthMethods: (process.env.SMTP_AUTH_METHODS || 'PLAIN,LOGIN')
    .split(',')
    .map((m) => m.trim().toUpperCase())
    .filter(Boolean),
  smtpMaxMessageSize: Number(process.env.SMTP_MAX_MESSAGE_SIZE || 52428800),
  smtpMaxClients: Number(process.env.SMTP_MAX_CLIENTS || 100),
  smtpSaveSentCopy: !['0', 'false', 'no', 'off'].includes((process.env.SMTP_SAVE_SENT_COPY || 'true').toLowerCase()),

  smtpRelayProvider: (process.env.SMTP_RELAY_PROVIDER || 'worker').toLowerCase(),
  resendSmtpHost: process.env.RESEND_SMTP_HOST || 'smtp.resend.com',
  resendSmtpPort: Number(process.env.RESEND_SMTP_PORT || 587),
  resendSmtpSecure: boolish(process.env.RESEND_SMTP_SECURE),
  resendSmtpUser: process.env.RESEND_SMTP_USER || 'resend',
  resendApiKey: process.env.RESEND_API_KEY || '',

  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 30000),
  maxInitialMessages: Number(process.env.MAX_INITIAL_MESSAGES || 500),

  tlsKeyPath: process.env.TLS_KEY_PATH || '',
  tlsCertPath: process.env.TLS_CERT_PATH || '',
};
