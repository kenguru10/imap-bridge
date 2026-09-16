import config from './config.js';
import { CloudMailClient } from './cloud-mail-client.js';

// Build Cloud Mail logins:
//   - primary login: config.cloudMail (required)
//   - additional logins: config.cloudMailLogins[] (optional)
//
// Each login gets its own CloudMailClient (own token cache). Sub-accounts are
// discovered later via /account/list and get their own IMAP identity (see
// imapUsersForAccounts).
export function buildLogins() {
  const primaryEmail = (config.cloudMail.email || '').toLowerCase();
  const primaryImapUser = config.imap.user || 'cloudmail';
  const primaryBase = config.imap.maildirBase || `${baseDir()}/${primaryImapUser}/Maildir`;

  const logins = [{
    key: primaryEmail,
    email: primaryEmail,
    imapUser: primaryImapUser,
    maildirBase: primaryBase,
    client: new CloudMailClient(config.cloudMail)
  }];

  const usedImapUsers = new Set([primaryImapUser]);
  const usedEmails = new Set([primaryEmail]);
  const additional = Array.isArray(config.cloudMailLogins) ? config.cloudMailLogins : [];

  additional.forEach((creds, i) => {
    const email = (creds.email || '').toLowerCase();
    if (!email || !creds.password) {
      console.warn(`[accounts] Skipping cloudMailLogins[${i}]: missing email or password`);
      return;
    }
    if (usedEmails.has(email)) {
      console.warn(`[accounts] Skipping duplicate login ${email}`);
      return;
    }
    usedEmails.add(email);

    // Dovecot username: explicit creds.imapUser wins (e.g. b@example.com),
    // otherwise derived from the email: b@example.com -> login.b.example.com
    let imapUser = creds.imapUser
      ? sanitizeImapUser(creds.imapUser)
      : `login.${sanitizeImapUser(email)}`;
    let n = 2;
    while (usedImapUsers.has(imapUser)) {
      imapUser = `login${n++}.${sanitizeImapUser(email)}`;
    }
    usedImapUsers.add(imapUser);

    // Default Maildir follows the Dovecot user (dovecot serves /var/mail/%u/Maildir)
    const maildirBase = creds.maildirBase || `${baseDir()}/${imapUser}/Maildir`;

    logins.push({
      key: email,
      email,
      imapUser,
      maildirBase,
      client: new CloudMailClient(creds)
    });
  });

  return logins;
}

// IMAP identity for a Cloud Mail account. The account matching a login's own
// email keeps that login's user (e.g. `cloudmail` / `login.b@example.com`);
// any other sub-account gets its own user named after its email
// (e.g. `admin@amilora.net`).
export function imapUserForAccount(login, account) {
  if (account.email.toLowerCase() === login.email) {
    return login.imapUser;
  }
  return sanitizeImapUser(account.email);
}

export function sanitizeImapUser(email) {
  return email.toLowerCase().replace(/[^a-zA-Z0-9.@_-]/g, '_');
}

// IMAP users used for auth: the configured user plus any per-account users
// declared in config.imap.users.
export function allImapUsers(extraUsers = []) {
  const users = [config.imap.user || 'cloudmail'];
  for (const u of extraUsers) {
    if (u && !users.includes(u)) users.push(u);
  }
  return users;
}

function baseDir() {
  // Derive the mail root (e.g. /var/mail) from the primary maildirBase,
  // which is <baseDir>/<user>/Maildir by convention.
  const base = (config.imap.maildirBase || '/var/mail/cloudmail/Maildir');
  const parts = base.split('/');
  if (parts.length >= 3 && parts[parts.length - 1] === 'Maildir') {
    return parts.slice(0, -2).join('/');
  }
  return '/var/mail';
}
