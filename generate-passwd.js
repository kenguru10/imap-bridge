#!/usr/bin/env node

/**
 * Helper to generate Dovecot passwd-file entries.
 *
 * Single user:
 *   node generate-passwd.js <username> <password> >> dovecot/passwd
 *
 * All logins from config (one line per Cloud Mail login — primary user plus
 * one per entry in cloudMailLogins, all using the IMAP password):
 *   node generate-passwd.js --all --password <imap-password>
 *
 * Uses OpenSSL's SHA512-CRYPT (`openssl passwd -6`), which is compatible
 * with Dovecot's default SHA512-CRYPT scheme.
 */

const { spawnSync } = require('child_process');

function generateHash(password) {
  const openssl = spawnSync('openssl', ['passwd', '-6', password], { encoding: 'utf8' });
  if (openssl.status !== 0 || !openssl.stdout) {
    throw new Error(
      'OpenSSL is required to generate the password hash. ' +
      'Install it or run inside the Dovecot container: ' +
      'docker exec cloud-mail-dovecot openssl passwd -6 <password>'
    );
  }
  return openssl.stdout.trim();
}

const username = process.argv[2];
const password = process.argv[3];

function passwdLine(user, hash) {
  return `${user}:${hash}:1000:1000::/var/mail/${user}::userdb_mail=maildir:/var/mail/${user}/Maildir`;
}

if (process.argv[2] === '--all') {
  // Generate one line per Cloud Mail login from bridge/config.json
  const configPath = process.env.CONFIG_PATH || './bridge/config.json';
  const c = JSON.parse(require('fs').readFileSync(configPath, 'utf8'));
  const imapPass = process.argv[3];
  if (!imapPass) {
    console.error('Usage: node generate-passwd.js --all --password <imap-password>');
    process.exit(1);
  }
  const hash = generateHash(imapPass);
  const users = [];
  users.push((c.imap && c.imap.user) || 'cloudmail');
  for (const l of (c.cloudMailLogins || [])) {
    const email = (l.email || '').trim();
    if (!email) continue;
    // Explicit imapUser in config wins; otherwise derive login.<email>
    let u = (l.imapUser || 'login.' + email).toLowerCase().replace(/[^a-z0-9.@_-]/g, '_');
    if (!u) u = 'login.' + email;
    let n = 2;
    while (users.includes(u)) u = 'login' + (n++) + '.' + email;
    users.push(u);
  }
  // Additional per-account Dovecot users (sub-accounts discovered at runtime)
  for (const u of (c.imap && c.imap.users) || []) {
    if (u && !users.includes(u)) users.push(u);
  }
  for (const u of users) console.log(passwdLine(u, hash));
  process.exit(0);
}

if (!username || !password) {
  console.error('Usage: node generate-passwd.js <username> <password>  (or --all --password <imap-password>)');
  process.exit(1);
}

let hash;
try {
  hash = generateHash(password);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

console.log(passwdLine(username, hash));
console.error('\nAppend the above line to dovecot/passwd');
