const config = require('./config');
const WorkerClient = require('./worker-client');
const { MailStore } = require('./store');
const { createIMAPServer } = require('./imap-server');
const { createSMTPServer } = require('./smtp-server');

const storeCache = new Map();

async function getSessionStore(username, password) {
  const cached = storeCache.get(username);
  if (cached) {
    // Re-authenticate to verify credentials without creating a new store.
    const probe = new WorkerClient(config.workerUrl);
    await probe.login(username, password);
    return { store: cached, isNew: false };
  }

  const client = new WorkerClient(config.workerUrl);
  await client.login(username, password);

  const store = new MailStore(client);
  await store.init();
  storeCache.set(username, store);

  return { store, isNew: true };
}

const imapServer = createIMAPServer(getSessionStore);
const smtpServer = createSMTPServer(getSessionStore);

imapServer.listen(config.imapPort, config.imapHost, () => {
  console.log(`IMAP server listening on ${config.imapHost}:${config.imapPort}`);
});

smtpServer.listen(config.smtpPort, config.smtpHost, () => {
  console.log(`SMTP server listening on ${config.smtpHost}:${config.smtpPort}`);
});

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  for (const store of storeCache.values()) store.stop();
  imapServer.close(() => {
    smtpServer.close(() => {
      process.exit(0);
    });
  });
});
