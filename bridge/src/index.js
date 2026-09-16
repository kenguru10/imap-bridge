import config from './config.js';
import { buildLogins, imapUserForAccount, allImapUsers } from './accounts.js';
import { SyncEngine } from './sync-engine.js';
import { startSmtpServer } from './smtp-server.js';
import { ensureMaildir } from './maildir.js';
import cron from 'node-cron';

const logins = buildLogins();

// One entry per Cloud Mail account (across all logins):
//   { login, account, imapUser, maildirBase }
const accountEntries = {}; // keyed by imapUser

async function loadAccounts() {
  const baseDir = (config.imap.maildirBase || '/var/mail/cloudmail/Maildir');
  const mailRoot = baseDir.endsWith('/Maildir')
    ? baseDir.slice(0, -'/Maildir'.length)
    : '/var/mail';

  const next = {};

  for (const login of logins) {
    const accounts = {};
    try {
      const result = await login.client.listAccounts({ size: '100' });
      accountsList(result).forEach(a => { accounts[a.accountId] = a; });
    } catch (err) {
      console.error(`[bridge] Login ${login.email}: failed to load accounts:`, err.message);
      continue;
    }

    for (const account of Object.values(accounts)) {
      const imapUser = imapUserForAccount(login, account);
      // The login's own account keeps the configured/login maildirBase;
      // sub-accounts get their own tree under the mail root.
      const maildirBase = imapUser === login.imapUser
        ? login.maildirBase
        : `${mailRoot}/${imapUser}/Maildir`;
      next[imapUser] = { login, account, imapUser, maildirBase };
    }
    console.log(`[bridge] Login ${login.email}: ${Object.keys(accounts).length} account(s)`);
  }

  for (const [imapUser, entry] of Object.entries(next)) {
    accountEntries[imapUser] = entry;
    ensureMaildir('INBOX', entry.maildirBase);
    ensureMaildir('Sent', entry.maildirBase);
    ensureMaildir('Trash', entry.maildirBase);
    ensureMaildir('Starred', entry.maildirBase);
  }

  return next;
}

function accountsList(result) {
  const data = result?.data;
  if (Array.isArray(data)) return data;
  if (data?.list) return data.list;
  if (Array.isArray(result?.list)) return result.list;
  return [];
}

async function main() {
  console.log('[bridge] Cloud Mail IMAP Bridge starting with ' + logins.length + ' login(s)');

  await loadAccounts();

  // Initial sync
  const syncEngine = new SyncEngine(logins, Object.values(accountEntries));
  await syncEngine.syncAll();

  // Schedule periodic sync (cron expression for every N minutes)
  const intervalMinutes = Math.max(1, Math.floor((config.sync.intervalSeconds || 60) / 60));
  cron.schedule(`*/${intervalMinutes} * * * *`, async () => {
    await loadAccounts();
    syncEngine.accounts = Object.values(accountEntries);
    await syncEngine.syncAll();
  });

  // Start SMTP server for sending (auth: login users + any declared account users)
  const declaredUsers = allImapUsers([...logins.map(l => l.imapUser), ...(config.imap.users || [])]);
  startSmtpServer(() => accountEntries, () => declaredUsers);

  console.log('[bridge] Bridge is running');
}

main().catch(err => {
  console.error('[bridge] Fatal error:', err);
  process.exit(1);
});
