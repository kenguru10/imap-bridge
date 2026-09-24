const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');
const config = require('./config');

async function sendViaResend(parsed, fromAddress, fromName, toAddresses, ccAddresses, bccAddresses) {
  const transporter = nodemailer.createTransport({
    host: config.resendSmtpHost,
    port: config.resendSmtpPort,
    secure: config.resendSmtpSecure,
    auth: {
      user: config.resendSmtpUser,
      pass: config.resendApiKey,
    },
  });

  const attachments = (parsed.attachments || []).map((att) => ({
    filename: att.filename,
    content: att.content,
    contentType: att.contentType,
    contentDisposition: att.contentDisposition,
    cid: att.cid || undefined,
  }));

  const info = await transporter.sendMail({
    from: fromName ? { name: fromName, address: fromAddress } : fromAddress,
    to: toAddresses,
    cc: ccAddresses,
    bcc: bccAddresses,
    subject: parsed.subject || '',
    text: parsed.text || '',
    html: parsed.html || parsed.textAsHtml || '',
    attachments,
  });

  // Return a synthetic email result for the local Sent folder copy.
  return {
    emailId: Date.now(),
    sendEmail: fromAddress,
    createTime: new Date().toISOString(),
    messageId: info.messageId,
  };
}

function createSMTPServer(getSessionStore) {
  const hasTls = !!(config.tlsKeyPath && config.tlsCertPath);
  const options = {
    secure: false,
    allowInsecureAuth: !config.smtpRequireTls,
    authOptional: false,
    authMethods: config.smtpAuthMethods,
    disabledCommands: hasTls ? [] : ['STARTTLS'],
    size: config.smtpMaxMessageSize,
    maxClients: config.smtpMaxClients,
    banner: 'cloud-mail-bridge ESMTP',
    onAuth: async (auth, session, callback) => {
      try {
        const { store } = await getSessionStore(auth.username, auth.password);
        session.user = { username: auth.username, store };
        callback(null, { user: session.user });
      } catch {
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

        // Resolve the sender display name: explicit override > account name > client-supplied name.
        const fromName =
          config.senderNameOverrides[(fromAddress || '').toLowerCase()] ||
          account.name ||
          (fromObj && fromObj.name) ||
          '';
        if (fromName && fromObj) {
          fromObj.name = fromName; // so the local Sent copy matches
        }

        const toAddresses = ((parsed.to && parsed.to.value) || []).map((a) => a.address);
        const ccAddresses = ((parsed.cc && parsed.cc.value) || []).map((a) => a.address);
        const bccAddresses = ((parsed.bcc && parsed.bcc.value) || []).map((a) => a.address);
        const rcptAddresses = session.envelope.rcptTo.map((r) => r.address);
        const receiveEmail = [...new Set([...toAddresses, ...ccAddresses, ...bccAddresses, ...rcptAddresses])].filter(Boolean);

        if (!receiveEmail.length) {
          return callback(new Error('No recipients'));
        }

        let emailResult;

        const relay = config.smtpRelayProvider === 'resend' ? 'resend' : 'worker';

        if (relay === 'resend') {
          emailResult = await sendViaResend(parsed, fromAddress, fromName, toAddresses, ccAddresses, bccAddresses);
        } else {
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
            sendName: fromName || undefined,
            receiveEmail,
            subject: parsed.subject || '',
            text: parsed.text || '',
            content: parsed.html || parsed.textAsHtml || '',
            attachments,
          };

          const result = await store.client.sendEmail(payload);
          emailResult = Array.isArray(result) ? result[0] : result;
        }

        // Save a copy to the local Sent folder so Outlook sees it.
        if (config.smtpSaveSentCopy) {
          try {
            await store.appendSentCopy(parsed, emailResult, relay === 'resend');
          } catch {
            // ignore
          }
        }

        callback(null, 'Message accepted');
      } catch (err) {
        callback(new Error(err.message || 'Message rejected'));
      }
    },
  };

  if (config.tlsKeyPath && config.tlsCertPath) {
    const fs = require('fs');
    const key = fs.readFileSync(config.tlsKeyPath);
    const cert = fs.readFileSync(config.tlsCertPath);
    const tlsBase = { key, cert, passphrase: config.tlsKeyPassphrase };
    if (config.smtpPort === 465) {
      options.secure = true;
      Object.assign(options, tlsBase);
    } else {
      Object.assign(options, tlsBase);
    }
  }

  const server = new SMTPServer(options);

  return server;
}

module.exports = { createSMTPServer };
