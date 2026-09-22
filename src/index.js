const config = require('./config');
const WorkerClient = require('./worker-client');
const { MailStore } = require('./store');
const { createIMAPServer } = require('./imap-server');
const { createSMTPServer } = require('./smtp-server');

const storeCache = new Map(); // username -> { store, lastAuth }

function persistKeyFor(username) {
  return username.replace(/[^a-zA-Z0-9@._-]/g, '_');
}

async function getSessionStore(username, password) {
  const cached = storeCache.get(username);
  if (cached) {
    // Avoid a worker /api/login round-trip (a KV write) on every
    // IMAP/SMTP reconnect: only re-verify credentials after authRecheckMs.
    if (Date.now() - cached.lastAuth < config.authRecheckMs) {
      return { store: cached.store, isNew: false };
    }
    const probe = new WorkerClient(config.workerUrl);
    await probe.login(username, password);
    cached.lastAuth = Date.now();
    return { store: cached.store, isNew: false };
  }

  const client = new WorkerClient(config.workerUrl);
  await client.login(username, password);

  const store = new MailStore(client, persistKeyFor(username));
  await store.init();
  storeCache.set(username, { store, lastAuth: Date.now() });

  return { store, isNew: true };
}

const imapServer = createIMAPServer(getSessionStore);
const smtpServer = createSMTPServer(getSessionStore);

imapServer.listen(config.imapPort, config.imapHost, () => {
  if (config.verbose) console.log(`IMAP server listening on ${config.imapHost}:${config.imapPort}`);
});

smtpServer.listen(config.smtpPort, config.smtpHost, () => {
  if (config.verbose) console.log(`SMTP server listening on ${config.smtpHost}:${config.smtpPort}`);
});

process.on('SIGINT', () => {
  if (config.verbose) console.log('\nShutting down...');
  for (const entry of storeCache.values()) entry.store.stop();
  imapServer.close(() => {
    smtpServer.close(() => {
      process.exit(0);
    });
  });
});
