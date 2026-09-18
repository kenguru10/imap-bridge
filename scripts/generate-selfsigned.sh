#!/usr/bin/env bash
set -e

# Generate a self-signed certificate for testing IMAPS/SMTPS.
# Outlook/macOS/iOS will show a warning and ask you to trust the certificate.

DOMAIN="${1:-imap.local}"
DAYS=365
OUT_DIR="${2:-$(dirname "$0")/../certs}"

mkdir -p "$OUT_DIR"

echo "Generating self-signed certificate for $DOMAIN -> $OUT_DIR"

openssl req -x509 -nodes -days "$DAYS" \
  -newkey rsa:2048 \
  -keyout "$OUT_DIR/key.pem" \
  -out "$OUT_DIR/cert.pem" \
  -subj "/CN=$DOMAIN" \
  -addext "subjectAltName=DNS:$DOMAIN,IP:127.0.0.1"

echo "Done."
echo ""
echo "Add these lines to .env:"
echo "  IMAP_PORT=993"
echo "  TLS_KEY_PATH=$OUT_DIR/key.pem"
echo "  TLS_CERT_PATH=$OUT_DIR/cert.pem"
