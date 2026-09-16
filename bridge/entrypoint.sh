#!/bin/sh
set -e

# Generate self-signed SMTP TLS certificates if TLS is enabled and none are mounted
CONFIG_FILE=${CONFIG_FILE:-/app/config.json}

if [ -f "$CONFIG_FILE" ]; then
    TLS_ENABLED=$(node -e "const c=require('$CONFIG_FILE'); console.log(c.smtp?.tls ? 'true' : 'false')" 2>/dev/null || echo 'false')
    CERT_PATH=$(node -e "const c=require('$CONFIG_FILE'); console.log(c.smtp?.certPath || '')" 2>/dev/null || echo '')
    KEY_PATH=$(node -e "const c=require('$CONFIG_FILE'); console.log(c.smtp?.keyPath || '')" 2>/dev/null || echo '')

    if [ "$TLS_ENABLED" = "true" ] && [ -n "$CERT_PATH" ] && [ -n "$KEY_PATH" ]; then
        CERT_DIR=$(dirname "$CERT_PATH")
        mkdir -p "$CERT_DIR"
        if [ ! -s "$CERT_PATH" ] || [ ! -s "$KEY_PATH" ]; then
            echo "Generating self-signed SMTP TLS certificate..."
            rm -f "$CERT_PATH" "$KEY_PATH"
            openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
                -keyout "$KEY_PATH" \
                -out "$CERT_PATH" \
                -subj "/CN=cloud-mail-bridge" \
                -addext "subjectAltName=DNS:cloud-mail-bridge,DNS:localhost,IP:127.0.0.1" 2>/dev/null || \
            openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
                -keyout "$KEY_PATH" \
                -out "$CERT_PATH" \
                -subj "/CN=cloud-mail-bridge"
            chmod 644 "$CERT_PATH"
            chmod 600 "$KEY_PATH"
            echo "Self-signed SMTP certificate generated."
        fi
    fi
fi

exec "$@"
