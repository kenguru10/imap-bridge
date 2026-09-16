import { existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import config from './config.js';
import { buildEml } from './eml-builder.js';
import {
  ensureMaildir,
  listMaildirMessages,
  findMessageById,
  writeMessage,
  moveMessage,
  deleteMessage
} from './maildir.js';
import { sanitizeFolderName, ensureDir, parseMaildirFlags } from './utils.js';

const STATE_FILE = config.sync.stateFile;
const INBOX = 'INBOX';
const SENT = 'Sent';
const TRASH = 'Trash';
const STARRED = 'Starred';

function emptyState() {
  return { accounts: {}, lastEmailIds: {} };
}

function loadState() {
  const state = { accounts: {}, lastRun: null, legacyMail: null };

  if (!existsSync(STATE_FILE)) {
    ensureDir(dirname(STATE_FILE));
    return state;
  }

  const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'));

  // Fresh state
  if (!raw.accounts && !raw.logins) {
    return state;
  }

  // Per-login layout: { logins: { email: { accounts, lastEmailIds } } }
  // Flatten into per-account sections; remember old trees for mail migration.
  if (raw.logins) {
    for (const [loginEmail, ls] of Object.entries(raw.logins || {})) {
      for (const [accountId, account] of Object.entries(ls?.accounts || {})) {
        const key = `${loginEmail}/${accountId}`;
        const ids = {};
        for (const [k, v] of Object.entries(ls?.lastEmailIds || {})) {
          if (k.endsWith(`_${accountId}`)) ids[k] = v;
        }
        state.accounts[key] = {
          accounts: { [accountId]: account },
          lastEmailIds: ids
        };
        // Old per-account folder in the login's tree (if the account has its own tree now)
        state.legacyMail = state.legacyMail || {};
        state.legacyMail[`${loginEmail}/${accountId}`] = true;
      }
    }
    state.lastRun = raw.lastRun || null;
    return state;
  }

  // Legacy single-login layout: top-level accounts/lastEmailIds.
  const primaryEmail = (config.cloudMail.email || 'primary').toLowerCase();
  for (const [accountId, account] of Object.entries(raw.accounts || {})) {
    const key = `${primaryEmail}/${accountId}`;
    state.accounts[key] = {
      accounts: { [accountId]: account },
      lastEmailIds: raw.lastEmailIds || {}
    };
    state.legacyMail = state.legacyMail || {};
    state.legacyMail[key] = true;
  }
  state.lastRun = raw.lastRun || null;
  return state;
}

function saveState(state) {
  ensureDir(dirname(STATE_FILE));
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export class SyncEngine {
  // accounts: [{ login, account, imapUser, maildirBase }]
  constructor(logins, accounts) {
    this.logins = logins;
    this.accounts = accounts;
    this.state = loadState();
  }

  accountState(entry) {
    const key = `${entry.login.email}/${entry.account.accountId}`;
    if (!this.state.accounts[key]) {
      this.state.accounts[key] = emptyState();
    }
    return this.state.accounts[key];
  }

  async syncAll() {
    console.log(`[sync] Starting sync of ${this.accounts.length} account(s) at ${new Date().toISOString()}`);

    const configuredTimeSort = String(config.sync?.timeSort ?? '1');
    const forceFullSync = config.sync?.forceFullSync === true;

    if (forceFullSync || this.state.timeSort !== configuredTimeSort) {
      if (this.state.timeSort) {
        console.log(`[sync] Sort order or full-sync flag changed (${this.state.timeSort} -> ${configuredTimeSort}); resetting email cursors for full re-sync`);
      }
      for (const key of Object.keys(this.state.accounts)) {
        this.state.accounts[key].lastEmailIds = {};
      }
      this.state.timeSort = configuredTimeSort;
      saveState(this.state);
    }

    await this.migrateLegacyMail();
    for (const entry of this.accounts) {
      try {
        await this.syncAccount(entry);
      } catch (err) {
        console.error(`[sync] Failed to sync account ${entry.account.email}:`, err.message);
      }
    }
    this.state.lastRun = new Date().toISOString();
    saveState(this.state);
    console.log(`[sync] Completed at ${new Date().toISOString()}`);
  }

  // One-time migration: under the old layout, sub-account mail was stored in
  // the *login's* Maildir tree (folder .<account-email>). Accounts now have
  // their own trees, so move any such mail into the account's own INBOX.
  async migrateLegacyMail() {
    const pending = this.state.legacyMail;
    if (!pending) return;

    let moved = 0;
    for (const key of Object.keys(pending)) {
      const entry = this.accounts.find(e => `${e.login.email}/${e.account.accountId}` === key);
      if (!entry) continue;

      const login = this.logins.find(l => l.email === entry.login.email);
      const oldBase = login ? login.maildirBase : null;
      if (!oldBase || oldBase === entry.maildirBase) continue; // same tree -> mergeAccountInboxes handles it

      const folder = sanitizeFolderName(entry.account.email);
      const oldFolderPath = join(oldBase, `.${folder}`);
      const hasMail = existsSync(join(oldFolderPath, 'cur')) || existsSync(join(oldFolderPath, 'new'));
      if (!existsSync(oldFolderPath) || !hasMail) continue;

      for (const msg of listMaildirMessages(folder, oldBase)) {
        const emailId = this.extractEmailId(msg.filename);
        if (!emailId) continue;
        if (findMessageById(emailId, INBOX, entry.maildirBase)) {
          deleteMessage(emailId, folder, oldBase);
          continue;
        }
        if (moveMessage(emailId, folder, INBOX, parseMaildirFlags(msg.filename), oldBase, entry.maildirBase)) {
          moved++;
        }
      }
      delete this.state.legacyMail[key];
    }

    if (moved > 0) {
      console.log(`[sync] Migrated ${moved} message(s) from old login trees into account INBOXes`);
    }
    if (Object.keys(this.state.legacyMail || {}).length === 0) {
      this.state.legacyMail = null;
    }
  }

  async syncAccount(entry) {
    const { login, account, maildirBase } = entry;
    const as = this.accountState(entry);
    as.accounts[account.accountId] = account;
    const base = maildirBase;

    ensureMaildir(INBOX, base);
    ensureMaildir(SENT, base);
    ensureMaildir(TRASH, base);
    ensureMaildir(STARRED, base);

    await this.pullFolderEmails(entry, base, as, INBOX, '0', {});
    await this.pullFolderEmails(entry, base, as, SENT, '1', {});
    await this.pullFolderEmails(entry, base, as, TRASH, '0', { isDel: 1 });

    // Legacy migration: any per-account subfolder inside this tree
    // (e.g. .a@amilora.net from the old layout) gets merged into the INBOX.
    await this.mergeAccountInboxes(base);

    await this.pushLocalChanges(entry, base);
    saveState(this.state);
  }

  async pullFolderEmails(entry, base, as, folderName, type, extraFilters = {}) {
    const { login, account } = entry;
    const accountId = String(account.accountId);
    const lastKey = `${folderName.toLowerCase()}_${accountId}`;
    let lastEmailId = as.lastEmailIds[lastKey] || 0;
    const pageSize = config.sync.pageSize || 50;
    let page = 0;

    let hasMore = true;
    while (hasMore) {
      page += 1;
      console.log(`[sync] folder=${folderName} account=${account.email} (${accountId}) page=${page} cursor=${lastEmailId}`);

      const result = await login.client.listEmails({
        accountId,
        type,
        size: String(pageSize),
        emailId: String(lastEmailId),
        timeSort: String(config.sync?.timeSort ?? '1'), // ascending order so max-ID cursor pagination works
        full: '1',
        ...extraFilters
      });

      const emails = result.data?.list || result.data || [];
      console.log(`[sync] folder=${folderName} account=${account.email} page=${page} returned=${emails.length}`);

      if (emails.length === 0) break;

      let saved = 0;
      let skipped = 0;
      for (const email of emails) {
        if (folderName === TRASH && email.isDel !== 1) { skipped += 1; continue; }
        if (folderName === SENT && email.type !== 1) { skipped += 1; continue; }

        await this.saveEmailToMaildir(login, base, email, account, folderName);
        saved += 1;
        if (email.emailId > lastEmailId) {
          lastEmailId = email.emailId;
        }
      }

      console.log(`[sync] folder=${folderName} account=${account.email} page=${page} saved=${saved} skipped=${skipped} newCursor=${lastEmailId}`);
      hasMore = emails.length === pageSize;
    }

    as.lastEmailIds[lastKey] = lastEmailId;
    console.log(`[sync] folder=${folderName} account=${account.email} finalCursor=${lastEmailId}`);
  }

  async saveEmailToMaildir(login, base, email, account, forceFolder) {
    const folder = forceFolder || this.folderForEmail(email, account);

    // Skip if already exists locally
    if (findMessageById(email.emailId, folder, base)) {
      return;
    }

    // Also check known folders if not found
    if (!forceFolder) {
      for (const f of [INBOX, SENT, TRASH, STARRED, sanitizeFolderName(account.email)]) {
        if (findMessageById(email.emailId, f, base)) return;
      }
    }

    const eml = await buildEml(email, login.client);
    const flags = [];
    if (email.unread === 1) {
      flags.push('S'); // seen (Cloud Mail: 1 = read)
    }
    if (email.isDel === 1) {
      flags.push('T');
    }

    writeMessage(folder, email.emailId, eml, flags, base);
  }

  folderForEmail(email, account) {
    if (email.type === 1) {
      return SENT;
    }
    return INBOX;
  }

  // One-time (idempotent) migration: move messages from per-account subfolders
  // that were previously synced inside this tree (folders named after a Cloud
  // Mail address) into the INBOX. User-created folders are left untouched.
  async mergeAccountInboxes(base) {
    const knownFolders = new Set([
      ...this.accounts.map(e => sanitizeFolderName(e.account.email)),
      ...this.logins.map(l => sanitizeFolderName(l.email))
    ]);
    let moved = 0;
    const dirEntries = existsSync(base) ? readdirSync(base) : [];

    for (const entry of dirEntries) {
      if (!entry.startsWith('.')) continue;
      const folder = entry.slice(1);
      if ([SENT, TRASH, STARRED].includes(folder)) continue;
      if (!knownFolders.has(folder)) continue;

      const folderPath = join(base, `.${folder}`);
      if (!existsSync(folderPath)) continue;
      if (!existsSync(join(folderPath, 'cur')) && !existsSync(join(folderPath, 'new'))) continue;

      for (const msg of listMaildirMessages(folder, base)) {
        const emailId = this.extractEmailId(msg.filename);
        if (!emailId) continue;

        if (findMessageById(emailId, INBOX, base)) {
          deleteMessage(emailId, folder, base);
          continue;
        }

        if (moveMessage(emailId, folder, INBOX, parseMaildirFlags(msg.filename), base)) {
          moved++;
        }
      }
    }

    if (moved > 0) {
      console.log(`[sync] Merged ${moved} message(s) from account folders into INBOX in ${base}`);
    }
  }

  async pushLocalChanges(entry, base) {
    const { login } = entry;
    const folders = [INBOX, SENT, TRASH, STARRED];

    for (const folder of folders) {
      const messages = listMaildirMessages(folder, base);
      for (const msg of messages) {
        const emailId = this.extractEmailId(msg.filename);
        if (!emailId) continue;

        const flags = parseMaildirFlags(msg.filename);
        const isTrashed = flags.includes('T') || folder === TRASH;

        // We don't have a remote endpoint for per-email unread in this MVP,
        // so we only push deletes.
        if (isTrashed && folder !== TRASH) {
          // Message moved to trash locally -> delete in Cloud Mail
          try {
            await login.client.deleteEmail([String(emailId)]);
            moveMessage(emailId, folder, TRASH, flags, base);
          } catch (e) {
            console.error(`[sync] Failed to delete email ${emailId} (${login.email}):`, e.message);
          }
        }
      }
    }
  }

  extractEmailId(filename) {
    const match = filename.match(/^(\d+)_/);
    return match ? Number(match[1]) : null;
  }
}
