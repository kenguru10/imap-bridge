import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import { readFileSync } from 'fs';
import config from './config.js';
import { ensureMaildir, writeMessage } from './maildir.js';
import { randomUUID } from 'crypto';

// Resolve the owning Cloud Mail account by from address.
// accountMap values: { login, account, imapUser, maildirBase }
function resolveAccount(from, accountMap) {
  const fromText = typeof from === 'string' ? from : from?.text || '';
  const match = fromText.match(/<([^>]+)>/);
  const addr = (match ? match[1] : fromText).toLowerCase().trim();
  for (const entry of Object.values(accountMap)) {
    if (entry.account?.email.toLowerCase() === addr) {
      return entry;
    }
  }
  return null;
}

export function startSmtpServer(accountMapProvider, knownUsersProvider) {
  const server = new SMTPServer({
    authMethods: ['PLAIN', 'LOGIN'],
    authOptional: false,
    allowInsecureAuth: !config.smtp.tls,
    hideSTARTTLS: config.smtp.tls ? false : true,
    secure: config.smtp.secure || false,
    key: config.smtp.tls ? readFileSync(config.smtp.keyPath) : undefined,
    cert: config.smtp.tls ? readFileSync(config.smtp.certPath) : undefined,
    ca: config.smtp.tls && config.smtp.caPath ? readFileSync(config.smtp.caPath) : undefined,

    onAuth(auth, session, callback) {
      const knownUsers = knownUsersProvider ? knownUsersProvider() : [config.imap.user];
      const allUsers = new Set([config.imap.user, ...knownUsers]);
      if (allUsers.has(auth.username) && auth.password === config.imap.password) {
        return callback(null, { user: auth.username });
      }
      return callback(new Error('Invalid username or password'));
    },

    onData(stream, session, callback) {
      const chunks = [];
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', async () => {
        try {
          const raw = Buffer.concat(chunks);
          const parsed = await simpleParser(raw);

          const entry = resolveAccount(parsed.from || session.envelope.mailFrom?.address, accountMapProvider());

          if (!entry) {
            return callback(new Error('From address is not a known Cloud Mail account'));
          }

          const { login, account, maildirBase } = entry;

          const toList = parsed.to?.value || [];
          const ccList = parsed.cc?.value || [];
          const bccList = parsed.bcc?.value || [];
          const allRecipients = [...toList, ...ccList, ...bccList];

          const sendBody = {
            accountId: account.accountId,
            name: parsed.from?.value?.[0]?.name || '',
            receiveEmail: allRecipients.map(a => a.address),
            subject: parsed.subject || '',
            content: parsed.html || parsed.textAsHtml || parsed.text || '',
            text: parsed.text || '',
            attachments: []
          };

          // Convert attachments to Cloud Mail format
          if (parsed.attachments && parsed.attachments.length > 0) {
            sendBody.attachments = parsed.attachments.map(att => ({
              filename: att.filename || 'attachment',
              type: att.contentType,
              content: att.content.toString('base64')
            }));
          }

          const result = await login.client.sendEmail(sendBody);
          console.log(`[smtp] Sent email via Cloud Mail (${account.email}): ${result.data?.emailId || 'ok'}`);

          // Save copy to Sent Maildir (in the account's own Maildir tree)
          ensureMaildir('Sent', maildirBase);
          const sentEml = raw.toString('utf8');
          const emailId = result.data?.emailId || Math.floor(Date.now() / 1000);
          writeMessage('Sent', emailId, sentEml, ['S'], maildirBase);

          callback(null, 'Message accepted');
        } catch (err) {
          console.error('[smtp] Error handling message:', err);
          callback(new Error(`Failed to send: ${err.message}`));
        }
      });
    },

    onMailFrom(address, session, callback) {
      callback();
    },

    onRcptTo(address, session, callback) {
      callback();
    }
  });

  server.listen(config.smtp.port, config.smtp.host, () => {
    console.log(`[smtp] Server listening on ${config.smtp.host}:${config.smtp.port}`);
  });

  return server;
}
