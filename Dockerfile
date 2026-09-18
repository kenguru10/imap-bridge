# syntax=docker/dockerfile:1
FROM node:20-alpine

WORKDIR /app

# Install dependencies first so the layer can be cached.
COPY package*.json ./
RUN npm install --omit=dev

# Copy the application source.
COPY src ./src

# Common ports: plain IMAP/SMTP and TLS variants.
EXPOSE 143 587 993 465

CMD ["node", "src/index.js"]
