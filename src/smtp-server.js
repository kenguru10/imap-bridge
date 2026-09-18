const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');
const config = require('./config');

function createSMTPServer(getSessionStore) {
  const hasTls = !!(config.tlsKeyPath && config.tlsCertPath);
  const options = {
    secure: false,
    allowInsecureAuth: true,
    authOptional: false,
    disabledCommands: hasTls ? [] : ['STARTTLS'],
    banner: 'cloud-mail-bridge ESMTP',
    onAuth: async (auth, session, callback) => {
      try {
        const { store } = await getSessionStore(auth.username, auth.password);
        session.user = { username: auth.username, store };
        callback(null, { user: session.user });
      } catch (err) {
        console.error('SMTP auth failed:', err.message);
        callback(new Error('Authentication failed'));
      }
    },
    onData: async (stream, session, callback) => {
      try {
        const parsed = await simpleParser(stream, { keepCidLinks: true });
        const store = session.user.store;

        const fromObj = parsed.from && parsed.from.value && parsed.from.value[0];
        const fromAddress = (fromObj && fromObj.address) || session.envelope.mailFrom.address;

        const account = store.findAccountByEmail(fromAddress);
        if (!account) {
          return callback(new Error(`No cloud-mail account matches ${fromAddress}`));
        }

        const toAddresses = [
          ...((parsed.to && parsed.to.value) || []),
          ...((parsed.cc && parsed.cc.value) || []),
        ].map((a) => a.address);

        const rcptAddresses = session.envelope.rcptTo.map((r) => r.address);
        const receiveEmail = [...new Set([...toAddresses, ...rcptAddresses])].filter(Boolean);

        if (!receiveEmail.length) {
          return callback(new Error('No recipients'));
        }

        const attachments = (parsed.attachments || []).map((att) => ({
          filename: att.filename,
          content: att.content.toString('base64'),
          contentType: att.contentType,
          contentId: att.cid || undefined,
          disposition: att.contentDisposition,
          type: att.cid ? 1 : 0,
        }));

        const payload = {
          accountId: account.accountId,
          receiveEmail,
          subject: parsed.subject || '',
          text: parsed.text || '',
          content: parsed.html || parsed.textAsHtml || '',
          attachments,
        };

        const result = await store.client.sendEmail(payload);
        const emailResult = Array.isArray(result) ? result[0] : result;

        // Save a copy to the local Sent folder so Outlook sees it.
        await store.appendSentCopy(parsed, emailResult);

        callback(null, 'Message accepted');
      } catch (err) {
        console.error('SMTP onData error:', err.stack || err.message);
        callback(new Error(err.message || 'Message rejected'));
      }
    },
  };

  if (config.tlsKeyPath && config.tlsCertPath) {
    const fs = require('fs');
    const key = fs.readFileSync(config.tlsKeyPath);
    const cert = fs.readFileSync(config.tlsCertPath);
    if (config.smtpPort === 465) {
      options.secure = true;
      options.key = key;
      options.cert = cert;
    } else {
      options.key = key;
      options.cert = cert;
    }
  }

  const server = new SMTPServer(options);
  server.on('error', (err) => {
    console.error('SMTP server error:', err.stack || err.message);
  });

  return server;
}

module.exports = { createSMTPServer };
