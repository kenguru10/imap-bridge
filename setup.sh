#!/usr/bin/env bash
set -e

# Interactive setup for Cloud Mail IMAP/SMTP Bridge

echo "Cloud Mail IMAP Bridge Setup"
echo "============================"

if [ ! -f bridge/config.json ]; then
    echo "Creating bridge/config.json from example..."
    cp bridge/config.json.example bridge/config.json
    echo ""
    echo "Please edit bridge/config.json with your Cloud Mail credentials, then rerun this script."
    exit 0
else
    echo "Using existing bridge/config.json."
fi

IMAP_USER=$(node -e "const c=require('./bridge/config.json'); console.log((c.imap && c.imap.user) || 'cloudmail')")
read -p "Local IMAP/SMTP username [${IMAP_USER}]: " input_user
IMAP_USER=${input_user:-$IMAP_USER}

read -s -p "Local IMAP/SMTP password: " IMAP_PASS
echo ""

if [ -z "$IMAP_PASS" ]; then
    echo "ERROR: Password cannot be empty."
    exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
    echo "ERROR: OpenSSL is required for password hashing. Install OpenSSL and rerun."
    exit 1
fi

HASH=$(openssl passwd -6 "$IMAP_PASS")

# One Dovecot user per Cloud Mail login: the primary user plus a user per
# entry in config.cloudMailLogins (named login.<email>), all sharing $IMAP_PASS.
PASSWD_ENTRIES=$(node -e "
const c=require('./bridge/config.json');
const users=[];
users.push((c.imap && c.imap.user) || 'cloudmail');
for (const l of (c.cloudMailLogins || [])) {
  const email=(l.email || '').trim();
  if (!email) continue;
  let u=(l.imapUser || 'login.'+email).toLowerCase().replace(/[^a-z0-9.@_-]/g,'_');
  if (!u) u='login.'+email;
  let n=2;
  while (users.includes(u)) u='login'+(n++)+'.'+email;
  users.push(u);
}
for (const u of (c.imap && c.imap.users) || []) {
  if (u && !users.includes(u)) users.push(u);
}
console.log(users.join(' '));
")

: > dovecot/passwd
for U in $PASSWD_ENTRIES; do
    echo "${U}:${HASH}:1000:1000::/var/mail/${U}::userdb_mail=maildir:/var/mail/${U}/Maildir" >> dovecot/passwd
done

# Ensure config.json maildirBase matches the username
node -e "
const fs=require('fs');
const path='./bridge/config.json';
const c=JSON.parse(fs.readFileSync(path,'utf8'));
const base='/var/mail/${IMAP_USER}/Maildir';
if (c.imap) c.imap.maildirBase = base;
if (c.sync) c.sync.stateFile = '/var/mail/${IMAP_USER}/bridge-state.json';
// Keep per-login maildirBase in sync with the Dovecot users
if (Array.isArray(c.cloudMailLogins)) {
  const users = [];
  users.push((c.imap && c.imap.user) || 'cloudmail');
  for (const l of c.cloudMailLogins) {
    const email = (l.email || '').trim();
    if (!email) continue;
    let u;
    if (l.imapUser) {
      // Explicit Dovecot user: force the Maildir to match it
      u = String(l.imapUser).toLowerCase().replace(/[^a-z0-9.@_-]/g, '_') || 'login.' + email;
      let n = 2;
      while (users.includes(u)) u = 'login' + (n++) + '.' + email;
      users.push(u);
      l.maildirBase = '/var/mail/' + u + '/Maildir';
    } else {
      u = 'login.' + email;
      let n = 2;
      while (users.includes(u)) u = 'login' + (n++) + '.' + email;
      users.push(u);
      if (!l.maildirBase) l.maildirBase = '/var/mail/' + u + '/Maildir';
    }
  }
}
fs.writeFileSync(path, JSON.stringify(c, null, 2) + '\\n');
console.log('Updated maildirBase to ' + base);
"

echo ""
echo "Dovecot password file updated."
echo "Starting services..."
docker compose up --build -d

echo ""
echo "Done. Containers are starting."
echo "Check status: docker compose ps"
echo "View logs:    docker compose logs -f"
