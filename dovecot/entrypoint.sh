#!/bin/sh
set -e

# Ensure mail directory ownership
chown -R vmail:vmail /var/mail
chmod 755 /var/mail

# Ensure log directory exists
mkdir -p /var/log/dovecot

# Ensure Dovecot runtime directory exists
mkdir -p /run/dovecot
chown root:root /run/dovecot
chmod 755 /run/dovecot

# Provide self-signed certs if none mounted
mkdir -p /etc/dovecot/certs
if [ ! -s /etc/dovecot/certs/cert.pem ] || [ ! -s /etc/dovecot/certs/key.pem ]; then
    echo "Generating self-signed TLS certificate..."
    rm -f /etc/dovecot/certs/cert.pem /etc/dovecot/certs/key.pem
    openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
        -keyout /etc/dovecot/certs/key.pem \
        -out /etc/dovecot/certs/cert.pem \
        -subj "/CN=cloud-mail-dovecot" \
        -addext "subjectAltName=DNS:cloud-mail-dovecot,DNS:localhost,IP:127.0.0.1" 2>/dev/null || \
    openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
        -keyout /etc/dovecot/certs/key.pem \
        -out /etc/dovecot/certs/cert.pem \
        -subj "/CN=cloud-mail-dovecot"
    chmod 644 /etc/dovecot/certs/cert.pem
    chmod 600 /etc/dovecot/certs/key.pem
    echo "Self-signed certificate generated."
fi

exec "$@"
