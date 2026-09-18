const nodemailer = require('nodemailer');

const streamTransport = nodemailer.createTransport({ streamTransport: true });

function safeJson(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function normalizeAddress(input) {
  if (!input) return undefined;
  if (typeof input === 'string') return input;
  if (input.address) {
    return input.name ? { name: input.name, address: input.address } : input.address;
  }
  return undefined;
}

function normalizeAddresses(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input.map(normalizeAddress).filter(Boolean);
  const single = normalizeAddress(input);
  return single ? [single] : [];
}

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function rewriteInlineImages(html, attachments, placeholder) {
  if (!html) return html;
  let out = html;
  for (const att of attachments || []) {
    if (!att.contentId || !att.key) continue;
    const needle = `${placeholder}${att.key}`;
    const cid = att.contentId.replace(/^<|>$/g, '');
    out = out.split(needle).join(`cid:${cid}`);
  }
  return out.split(placeholder).join(`${placeholder.replace(/\{\{domain\}\}\/?$/, '')}/`);
}

async function buildRaw(emailRow, attachments, workerBaseUrl) {
  const placeholder = '{{domain}}';

  // Prefer the structured recipient list, fall back to the single recipient fields.
  let to = normalizeAddresses(safeJson(emailRow.recipient, null));
  if (!to.length && emailRow.toEmail) {
    to = normalizeAddresses([{ address: emailRow.toEmail, name: emailRow.toName || '' }]);
  }

  const cc = normalizeAddresses(safeJson(emailRow.cc, []));
  const bcc = normalizeAddresses(safeJson(emailRow.bcc, []));

  let html = emailRow.content || '';
  html = rewriteInlineImages(html, attachments, placeholder);

  // Replace any remaining {{domain}} placeholders with the public worker URL.
  const publicBase = workerBaseUrl.replace(/\/$/, '') + '/';
  html = html.split(placeholder).join(publicBase);

  const mail = {
    from: normalizeAddress({
      address: emailRow.sendEmail,
      name: emailRow.name || '',
    }),
    to,
    cc,
    bcc,
    subject: emailRow.subject || '',
    text: emailRow.text || '',
    html: html || undefined,
    date: emailRow.createTime ? new Date(emailRow.createTime) : new Date(),
  };

  if (emailRow.messageId) {
    mail.messageId = emailRow.messageId;
  }

  if (attachments && attachments.length) {
    mail.attachments = attachments.map((att) => {
      const isInline = att.contentId || att.disposition === 'inline' || att.type === 1;
      const out = {
        filename: att.filename,
        content: att.content,
        contentType: att.mimeType || att.contentType || 'application/octet-stream',
        contentDisposition: isInline ? 'inline' : 'attachment',
      };
      if (isInline && att.contentId) {
        out.cid = att.contentId.replace(/^<|>$/g, '');
      }
      return out;
    });
  }

  const info = await streamTransport.sendMail(mail);
  return streamToBuffer(info.message);
}

module.exports = { buildRaw, normalizeAddresses, safeJson };
