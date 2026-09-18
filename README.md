# Cloud Mail IMAP/SMTP Bridge

This is a small bridge that turns your [cloud-mail](https://github.com/maillab/cloud-mail) Cloudflare Worker into a regular IMAP + SMTP server, so you can add it to Outlook (or any other desktop/mobile mail client).

## Why a bridge?

Cloudflare Workers can receive email via the `email` event and store it in D1/R2, but Workers cannot expose a long-lived TCP IMAP/SMTP server. This bridge runs on a normal server (or your laptop) and:

- logs into the worker using your cloud-mail credentials
- polls the worker REST API for new mail
- reconstructs real RFC 2822 MIME messages from the worker's parsed data
- serves them over IMAP (`imap-core`)
- accepts outbound mail over SMTP (`smtp-server`) and forwards it through the worker's `/api/email/send`

## What works

- Outlook IMAP account setup against port `143`
- INBOX, Sent and Trash folders
- Fetching headers, bodies, attachments and full raw messages
- Marking messages read/unread (synced back to the worker)
- Deleting messages (synced back to the worker)
- Sending mail through SMTP submission (`587`)
- Sent copies appear in the Sent folder

## Quick start

```bash
cp .env.example .env
# edit .env and set CLOUD_MAIL_WORKER_URL to your deployed worker URL
npm install
npm start
```

Then add an account to Outlook:

| Setting | Value |
|---------|-------|
| Email address | the cloud-mail account/alias you want to send from |
| Account type | IMAP |
| Incoming mail server | `your-bridge-host` port `143` |
| Outgoing mail server (SMTP) | `your-bridge-host` port `587` |
| Username | your cloud-mail login email |
| Password | your cloud-mail login password |

> The IMAP account will show a **unified INBOX** containing mail for every alias owned by that user. When you send, Outlook supplies the `From` address and the bridge picks the matching cloud-mail account automatically.

## Using a secure connection

By default the bridge runs in plain text. For Outlook on a remote host you should enable TLS:

1. Obtain a certificate/key pair (e.g. from Let's Encrypt, or generate a self-signed pair).
2. Set `TLS_KEY_PATH` and `TLS_CERT_PATH` in `.env`.
3. Use the matching Outlook port/encryption mode:

| Protocol | Port | Outlook encryption | What the bridge does |
|----------|------|--------------------|----------------------|
| IMAP     | 993  | SSL/TLS            | implicit TLS (IMAPS) |
| IMAP     | 143  | STARTTLS / TLS     | opportunistic TLS upgrade |
| SMTP     | 465  | SSL/TLS            | implicit TLS (SMTPS) |
| SMTP     | 587  | STARTTLS / TLS     | opportunistic TLS upgrade |

A self-signed certificate will work, but Outlook will show a certificate warning that must be accepted.

## Configuration

See `.env.example` for all options. The most important ones are:

- `CLOUD_MAIL_WORKER_URL` – public URL of your deployed `mail-worker`
- `IMAP_HOST` / `IMAP_PORT`
- `SMTP_HOST` / `SMTP_PORT`
- `POLL_INTERVAL_MS` – how often new mail is fetched from the worker
- `MAX_INITIAL_MESSAGES` – how many messages to load per account on first login
- `TLS_KEY_PATH` / `TLS_CERT_PATH` – enable TLS for IMAP/SMTP (recommended for remote hosts)

## Project layout

```
src/
  index.js          # entry point, starts IMAP + SMTP and caches user stores
  worker-client.js  # REST client for the cloud-mail worker
  store.js          # in-memory mail cache + polling
  mime-builder.js   # rebuilds RFC 2822 messages from worker data
  imap-server.js    # IMAP server handlers (imap-core)
  smtp-server.js    # SMTP submission handlers (smtp-server)
  config.js         # .env loading
```

## Limitations & future improvements

- **Plain text by default**: the server listens in plain text. Use a reverse proxy or provide `TLS_KEY_PATH`/`TLS_CERT_PATH` for encryption.
- **In-memory cache**: message metadata and raw MIME are held in memory. Restarting the bridge clears the cache and Outlook will re-sync. For production use you may want to persist the cache to disk or a local Maildir.
- **Cc/Bcc**: the current cloud-mail `/api/email/send` only supports a `receiveEmail` list, so Cc recipients are currently included as envelope recipients rather than as a separate Cc header in the worker UI.
- **Folder mapping**: the bridge exposes a single unified INBOX. Per-alias folders can be added by extending `store.js`.

## License

MIT
