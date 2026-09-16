# Cloud Mail IMAP Bridge — Installation Guide

This guide walks through installing and configuring the IMAP/SMTP bridge on a server so you can read and send Cloud Mail messages from macOS Mail.

## Table of Contents

1. [Before You Start](#before-you-start)
2. [Server Requirements](#server-requirements)
3. [Prepare Cloud Mail](#prepare-cloud-mail)
4. [Install the Bridge](#install-the-bridge)
5. [Configure macOS Mail](#configure-macos-mail)
6. [Verify Everything](#verify-everything)
7. [Upgrading](#upgrading)
8. [Uninstalling](#uninstalling)

---

## Before You Start

You need:

- A deployed Cloud Mail worker with a public HTTPS URL.
- A Cloud Mail user account (email + password).
- At least one Cloud Mail email address (account) created for that user.
- A Linux/macOS server with Docker and Docker Compose installed.
- Open ports: **143** (IMAP STARTTLS), **993** (IMAP SSL), **587** (SMTP STARTTLS).
- OpenSSL installed on the server (for password hashing).

> **Note:** This bridge currently supports **one Cloud Mail user** per installation. If you need multiple users, run separate bridge instances on different ports/hosts.

---

## Server Requirements

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| CPU | 1 core | 2 cores |
| RAM | 512 MB | 1 GB |
| Disk | 1 GB | Depends on mailbox size |
| OS | Linux/macOS with Docker 20.10+ | Ubuntu 22.04 LTS |

---

## Prepare Cloud Mail

1. Deploy Cloud Mail and note your worker URL, e.g.
   ```
   https://cloud-mail.your-subdomain.workers.dev
   ```

2. Create or identify the user account you will bridge. You need:
   - Cloud Mail login email
   - Cloud Mail login password

3. In the Cloud Mail web UI, create at least one email address (e.g. `a@yourdomain.com`). The bridge will create matching IMAP folders automatically.

---

## Install the Bridge

### 1. Clone or copy the bridge files

```bash
cd /opt
mkdir -p cloud-mail-bridge
cd cloud-mail-bridge

# If you have the full repo:
cp -r /path/to/cloud-mail/imap-bridge/* .
```

### 2. Configure the bridge

#### Option A: Interactive setup

```bash
cp bridge/config.json.example bridge/config.json
# Edit bridge/config.json with your Cloud Mail credentials
./setup.sh
```

#### Option B: Manual setup

Copy the example configuration and edit it:

```bash
cp bridge/config.json.example bridge/config.json
nano bridge/config.json
```

Fill in at least these fields:

```json
{
  "cloudMail": {
    "baseUrl": "https://cloud-mail.your-subdomain.workers.dev",
    "apiBaseUrl": "https://cloud-mail.your-subdomain.workers.dev/api",
    "email": "your-cloud-mail-user@example.com",
    "password": "your-cloud-mail-password"
  },
  "imap": {
    "user": "cloudmail",
    "password": "a-strong-local-password"
  },
  "smtp": {
    "host": "0.0.0.0",
    "port": 587,
    "tls": true,
    "secure": false,
    "certPath": "/app/certs/cert.pem",
    "keyPath": "/app/certs/key.pem"
  },
  "sync": {
    "intervalSeconds": 60,
    "pageSize": 50,
    "stateFile": "/var/mail/cloudmail/bridge-state.json"
  }
}
```

Field meanings:

| Field | Description |
|-------|-------------|
| `baseUrl` | Public root URL of your Cloud Mail worker. Used for attachment downloads. |
| `apiBaseUrl` | Same URL with `/api` path. Used for login, list, send, etc. |
| `email` / `password` | Your Cloud Mail user credentials. |
| `imap.user` / `imap.password` | Local credentials macOS Mail will use to connect. Choose a strong password. |
| `smtp.tls` | Enable STARTTLS on port 587. Recommended. |
| `sync.intervalSeconds` | How often the bridge polls Cloud Mail (default 60s). |

### 3. Generate the Dovecot password file

> **If you ran `./setup.sh` in step 2, skip this step and step 5.** The script handles password hashing and starting the containers.

The `imap.user` and `imap.password` from `bridge/config.json` must be added to `dovecot/passwd` as a SHA512-CRYPT hash.

```bash
cd /opt/cloud-mail-bridge
node generate-passwd.js cloudmail "a-strong-local-password" >> dovecot/passwd
```

> Replace `cloudmail` and the password with the values you chose in `bridge/config.json`.

The resulting file should contain one line like:

```
cloudmail:$6$rounds=5000$...hash...:1000:1000::/var/mail/cloudmail::userdb_mail=maildir:/var/mail/cloudmail/Maildir
```

If OpenSSL is not available on your host, generate the hash inside the Dovecot container after the first start:

```bash
docker exec cloud-mail-dovecot openssl passwd -6 "a-strong-local-password"
```

Then paste the output into `dovecot/passwd` in the format above and restart Dovecot:

```bash
docker compose restart dovecot
```

### 4. (Optional) Provide real TLS certificates

For production, place your real certificate and key in:

```bash
# Dovecot certs: bind-mounted from ./dovecot/certs
mkdir -p dovecot/certs
cp your-cert.pem dovecot/certs/cert.pem
cp your-key.pem  dovecot/certs/key.pem

# Bridge certs: stored in the "bridge-certs" Docker volume (not a host directory)
docker compose up -d bridge   # creates the volume on first start
docker cp your-cert.pem cloud-mail-bridge:/app/certs/cert.pem
docker cp your-key.pem  cloud-mail-bridge:/app/certs/key.pem
docker compose restart bridge
```

If you skip this step, both Dovecot and the SMTP bridge will generate self-signed certificates on first start. macOS Mail will warn you about them.

### 5. Start the services

```bash
docker compose up --build -d
```

Watch the logs to confirm both services start:

```bash
docker compose logs -f
```

You should see:

```
cloud-mail-dovecot  | Generating self-signed TLS certificate...
cloud-mail-dovecot  | Self-signed certificate generated.
cloud-mail-bridge   | Generating self-signed SMTP TLS certificate...
cloud-mail-bridge   | Self-signed certificate generated.
cloud-mail-bridge   | [bridge] Cloud Mail IMAP Bridge starting...
cloud-mail-bridge   | [smtp] Server listening on 0.0.0.0:587
```

If the bridge cannot reach Cloud Mail, it will restart until the API is available.

### 6. Open firewall ports

```bash
# Ubuntu/Debian with ufw
sudo ufw allow 143/tcp
sudo ufw allow 993/tcp
sudo ufw allow 587/tcp
```

Or configure your cloud provider's security group accordingly.

---

## Configure macOS Mail

1. Open **Mail → Settings → Accounts → Add Account → Other Mail Account**.

2. Fill in:
   - **Name:** Your display name.
   - **Email Address:** One of your Cloud Mail addresses, e.g. `a@yourdomain.com`.
   - **Password:** The local IMAP password from `bridge/config.json`.

3. When macOS Mail asks for server details, enter:

   **Incoming Mail Server (IMAP):**
   - Host: `your-server-ip-or-hostname`
   - User: `cloudmail`
   - Password: your local IMAP password
   - Port: `993`
   - SSL: **Enabled**

   **Outgoing Mail Server (SMTP):**
   - Host: `your-server-ip-or-hostname`
   - User: `cloudmail`
   - Password: your local IMAP password
   - Port: `587`
   - TLS/SSL: **Enabled (STARTTLS)**

4. If macOS warns about a self-signed certificate:
   - Click **Show Certificate**.
   - Check **Always trust ...** and click **Continue**.
   - You may need to enter your Mac password.

5. macOS Mail will create the account. After the first sync interval (up to 60 seconds), your Cloud Mail folders and messages will appear.

---

## Verify Everything

### Test IMAP

```bash
# From any machine
openssl s_client -connect your-server:993 -servername your-server </dev/null
```

Then manually log in:

```
a1 LOGIN cloudmail your-password
a2 LIST "" "*"
a3 LOGOUT
```

### Test SMTP

```bash
telnet your-server 587
```

You should see an SMTP greeting like:

```
220 cloud-mail-bridge ESMTP
```

### Check bridge sync

```bash
docker logs cloud-mail-bridge -f
```

Look for:

```
[bridge] Loaded N accounts
[sync] Starting sync...
[sync] Completed
```

---

## Upgrading

To update the bridge after pulling new code:

```bash
cd /opt/cloud-mail-bridge
git pull          # or copy new files
docker compose down
docker compose up --build -d
```

Your mail and state are preserved in the Docker volume `imap-bridge_maildir`.

---

## Uninstalling

```bash
cd /opt/cloud-mail-bridge
docker compose down -v   # -v removes the maildir volume
```

To also remove the images:

```bash
docker image rm imap-bridge-bridge imap-bridge-dovecot
```

---

## Next Steps

- See `README.md` for architecture, folder mapping, and troubleshooting.
- For multiple Cloud Mail users, duplicate the bridge directory and adjust ports in `docker-compose.yml`.
