# Cloud Mail IMAP/SMTP Bridge

Use **macOS Mail** (or any IMAP/SMTP email client) with the [Cloud Mail](../README.md) project.

This bridge runs as Docker containers on a server and translates between Cloud Mail's REST API and standard IMAP/SMTP protocols.

```
┌─────────────┐      IMAP       ┌──────────┐     Maildir      ┌──────────────┐
│ macOS Mail  │ ◄──────────────► │ Dovecot  │ ◄──────────────► │ Sync Bridge  │
└─────────────┘                  └──────────┘                  └──────┬───────┘
                                                                      │ HTTPS
                                                                      ▼
                                                             ┌─────────────────┐
                                                             │  Cloud Mail API │
                                                             └─────────────────┘

┌─────────────┐      SMTP       ┌──────────────────────────────────────────────┐
│ macOS Mail  │ ───────────────►│  SMTP Bridge  ──►  Cloud Mail /email/send    │
└─────────────┘                 └──────────────────────────────────────────────┘
```

## Features

- 📬 **Read mail** via IMAP with per-address folders.
- ✉️ **Send mail** via SMTP through Cloud Mail.
- 🗂️ Mailboxes: `INBOX`, per-account folders, `Sent`, `Trash`, `Starred`, `Drafts`.
- 🔒 TLS support for both IMAP and SMTP.
- 🐳 Runs entirely in Docker.

## Quick Start

### Option A: Interactive setup

```bash
cd imap-bridge
cp bridge/config.json.example bridge/config.json
# Edit bridge/config.json with your credentials
./setup.sh
```

### Option B: Manual setup

```bash
cd imap-bridge

# 1. Configure
cp bridge/config.json.example bridge/config.json
# Edit bridge/config.json with your Cloud Mail URL and credentials

# 2. Generate IMAP password hash (requires OpenSSL)
node generate-passwd.js cloudmail "your-local-password" >> dovecot/passwd

# 3. Run
docker compose up --build -d
```

Then add an account in macOS Mail:

| Setting | Value |
|---|---|
| Incoming host | your-server |
| IMAP user | `cloudmail` |
| IMAP port | `993` (SSL) or `143` (STARTTLS) |
| Outgoing host | your-server |
| SMTP port | `587` (STARTTLS) or `465` (SSL) |

For detailed installation steps, firewall setup, certificate configuration, and macOS Mail screenshots, see **[INSTALL.md](INSTALL.md)**.

## How It Works

1. **Dovecot** serves a Maildir mailbox over IMAP.
2. The **bridge** periodically logs into Cloud Mail, lists your accounts and emails, and writes them into the shared Maildir.
3. When you send mail from macOS Mail, the **SMTP bridge** forwards it to Cloud Mail's send API.

## Folder Mapping

| Cloud Mail | IMAP folder |
|---|---|
| `a@example.com` | `a@example.com` |
| `b@example.com` | `b@example.com` |
| Sent mail | `Sent` |
| Deleted mail | `Trash` |
| Starred mail | `Starred` |

## Two-Way Sync

| Action in macOS Mail | Result in Cloud Mail |
|---|---|
| New email arrives | Pulled to Maildir on next sync |
| Mark read/unread | Read state synced from Cloud Mail → Maildir |
| Move to Trash | Calls `/email/delete` |
| Send message | Forwarded via `/email/send` |

## Configuration

See `bridge/config.json.example` for all options. Key fields:

```json
{
  "cloudMail": {
    "baseUrl": "https://your-worker.workers.dev",
    "apiBaseUrl": "https://your-worker.workers.dev/api",
    "email": "your-cloud-mail-user@example.com",
    "password": "your-cloud-mail-password"
  },
  "cloudMailLogins": [
    {
      "email": "second-cloud-mail-login@example.com",
      "password": "second-cloud-mail-password"
    }
  ],
  "imap": {
    "user": "cloudmail",
    "password": "your-local-imap-password",
    "users": [ "admin@amilora.net" ]
  }
}
```

### Multiple Cloud Mail logins

`cloudMail` is the primary login. Add any number of **additional** Cloud Mail
logins (different email/password pairs) under `cloudMailLogins`.

Each Cloud Mail **account** (the login's own address plus every sub-account
discovered via `/account/list`) is isolated:

- it has its own IMAP identity — the login's own address uses the login's
  user (e.g. `cloudmail` or `login.b@example.com`), sub-accounts use their
  email address as the user (e.g. `admin@amilora.net`),
- it syncs its own Inbox/Sent/Trash only (cursors are per account, mail is
  never mixed between accounts),
- it gets its own Maildir tree under `/var/mail/<imap-user>/Maildir`.

By default an additional login's Dovecot user is `login.<email>` (e.g.
`login.b@example.com`). To serve it under a different username (e.g. the bare
email), set `imapUser` in the login entry — the synced Maildir follows it
(`maildirBase` may still override explicitly):

```json
"cloudMailLogins": [
  {
    "email": "b@example.com",
    "password": "...",
    "imapUser": "b@example.com"
  }
]
```

So in macOS Mail / Outlook you log in once per Cloud Mail address and only
see that address's mail.

Sub-accounts are discovered at runtime, so the bridge cannot know their names
at setup. Declare them in `config.json` (`imap.users`) so they get Dovecot
users (all share the local IMAP password), then regenerate `dovecot/passwd`:

```json
"imap": { "users": [ "admin@amilora.net" ] }
```

```bash
node generate-passwd.js --all --password <imap-password> > dovecot/passwd
docker compose up -d
```

## Requirements

- Docker + Docker Compose
- OpenSSL (for password hashing)
- A deployed Cloud Mail worker
- A Cloud Mail user account with at least one email address

## Troubleshooting

### Cannot connect from macOS Mail

- Open ports `143`, `993`, and `587` in your firewall.
- Check Dovecot logs: `docker logs cloud-mail-dovecot`
- Verify `dovecot/passwd` contains a valid SHA512-CRYPT hash.

### Emails not syncing

- Check bridge logs: `docker logs cloud-mail-bridge`
- Verify `cloudMail.apiBaseUrl`, `email`, and `password`.
- Ensure the Cloud Mail user can call `/account/list` and `/email/list`.

### Sending fails

- Confirm the `From` address in macOS Mail matches a Cloud Mail account you own.
- Check SMTP auth uses the same user/password as `bridge/config.json`.

## Security Notes

- Replace the auto-generated self-signed certificates with real ones for production.
- Use a strong local IMAP/SMTP password.
- Consider running the server behind a VPN or restricting access by IP.

## Limitations

- One Cloud Mail user per bridge instance.
- Sync is pull-based polling (default every 60s), not push/IDLE.
- Read-state sync is currently one-way (Cloud Mail → Maildir).

## License

MIT — same as the Cloud Mail project.
