FROM node:20-alpine

WORKDIR /app

# Install OpenSSL for generating self-signed SMTP certificates
RUN apk add --no-cache openssl

COPY package.json ./
RUN npm install --production

COPY src ./src
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Ensure mail directory is writable by UID 1000 (matches Dovecot vmail user)
RUN mkdir -p /var/mail && chown -R node:node /var/mail && chmod 755 /var/mail

# Certs directory (backed by the bridge-certs Docker volume; ownership must be
# "node" because the container does not run as root)
RUN mkdir -p /app/certs && chown node:node /app/certs

USER node

EXPOSE 587

ENTRYPOINT ["/entrypoint.sh"]
CMD ["npm", "start"]
