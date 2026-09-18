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

### Run with Node.js

```bash
cp .env.example .env
# edit .env and set CLOUD_MAIL_WORKER_URL to your deployed worker URL
npm install
npm start
```

### Run with Docker Compose

```bash
cp .env.example .env
# edit .env, then
mkdir -p certs          # put key.pem / cert.pem here if you use TLS
docker compose up -d
```

The compose file exposes ports `143`, `587`, `993` and `465`. If you change `IMAP_PORT` or `SMTP_PORT` in `.env`, update the published ports in `docker-compose.yml` accordingly.

If you use TLS inside Docker, put the certificate files in the `certs/` folder and reference them with the container path in `.env`, e.g.:

```env
TLS_KEY_PATH=/app/certs/key.pem
TLS_CERT_PATH=/app/certs/cert.pem
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

### Getting a certificate for IMAPS (port 993)

#### Option 1: Let's Encrypt (recommended for production)

If you own a domain and the bridge is reachable on the public internet, get a free trusted certificate:

```bash
# Install certbot, then run:
sudo certbot certonly --standalone -d mail.yourdomain.com
```

This creates:

```
/etc/letsencrypt/live/mail.yourdomain.com/fullchain.pem
/etc/letsencrypt/live/mail.yourdomain.com/privkey.pem
```

Use them in `.env`:

```env
IMAP_PORT=993
SMTP_PORT=465
TLS_CERT_PATH=/etc/letsencrypt/live/mail.yourdomain.com/fullchain.pem
TLS_KEY_PATH=/etc/letsencrypt/live/mail.yourdomain.com/privkey.pem
```

Certbot renews automatically. If you run the bridge in Docker, mount `/etc/letsencrypt` into the container and restart it after renewal.

#### Option 2: Self-signed certificate (testing only)

A quick self-signed cert is fine for local testing:

```bash
./scripts/generate-selfsigned.sh mail.yourdomain.com
```

Then set:

```env
IMAP_PORT=993
TLS_CERT_PATH=/app/certs/cert.pem
TLS_KEY_PATH=/app/certs/key.pem
```

Outlook will warn about the certificate; accept/trust it to continue.

## Sending via Resend instead of the worker

If you have a Resend SMTP API key, you can keep the bridge IMAP for incoming mail but let Resend handle outbound delivery. Set in `.env`:

```env
SMTP_RELAY_PROVIDER=resend
RESEND_API_KEY=re_xxxxxxxx
# Optional overrides:
# RESEND_SMTP_HOST=smtp.resend.com
# RESEND_SMTP_PORT=587
# RESEND_SMTP_USER=resend
```

Outlook still talks to the bridge on `SMTP_PORT` for outgoing mail; the bridge authenticates the user, relays the message to Resend's SMTP server, and adds a copy to the local Sent folder.

## Troubleshooting

### Sent emails do not appear in the Sent folder

1. **Make sure Outlook is sending through the bridge, not directly through Resend.**  
   If you put `smtp.resend.com` in Outlook's outgoing server settings, the bridge never sees the message and cannot add a copy to the IMAP Sent folder. Either:
   - point Outlook SMTP to the bridge (`SMTP_HOST:SMTP_PORT`) and set `SMTP_RELAY_PROVIDER=resend`, or
   - configure Outlook to save sent copies in the IMAP Sent folder (some Outlook versions do this automatically).

2. **Check the bridge logs** when you send. If the worker or Resend rejects the message, no copy is saved.

3. **Avoid duplicate copies.** If your client appends its own sent copy and the bridge also adds one, you will see duplicates. Set `SMTP_SAVE_SENT_COPY=false` to let the client handle it.

## Configuration

See `.env.example` for all options. The most important ones are:

- `CLOUD_MAIL_WORKER_URL` – public URL of your deployed `mail-worker`
- `IMAP_HOST` / `IMAP_PORT`
- `SMTP_HOST` / `SMTP_PORT`
- `SMTP_REQUIRE_TLS` – require TLS before allowing SMTP authentication
- `SMTP_AUTH_METHODS` – allowed mechanisms, e.g. `PLAIN,LOGIN`
- `SMTP_MAX_MESSAGE_SIZE` – max message size in bytes
- `SMTP_MAX_CLIENTS` – max concurrent SMTP connections
- `SMTP_SAVE_SENT_COPY` – whether the bridge adds a copy to Sent (default `true`)
- `SENDER_NAME_OVERRIDES` – force the sender display name for specific addresses, e.g. `admin@amilora.net=Amilora`
- `SMTP_RELAY_PROVIDER` – `worker` (default) or `resend`
- `RESEND_SMTP_HOST` / `RESEND_SMTP_PORT` / `RESEND_SMTP_SECURE`
- `RESEND_SMTP_USER` (usually `resend`)
- `RESEND_API_KEY`
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
