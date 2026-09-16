import { randomUUID } from 'crypto';
import { cloudMail } from './cloud-mail-client.js';
import { formatEmailAddress, parseEmailAddress } from './utils.js';

function formatAddressList(list) {
  if (!list) return '';
  let items = [];
  try {
    items = typeof list === 'string' ? JSON.parse(list) : list;
  } catch {
    return list;
  }
  return items.map(item => formatEmailAddress(item)).join(', ');
}

function generateBoundary() {
  return `----=_Part_${randomUUID().replace(/-/g, '')}`;
}

function encodeHeaderValue(value) {
  if (!value) return '';
  // Simple ASCII check; encode non-ASCII as quoted-printable-ish base64
  if (/^[\x00-\x7F]*$/.test(value)) {
    return value;
  }
  return `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=`;
}

function buildHeaders(email) {
  const headers = [];
  const messageId = email.messageId || `<${randomUUID()}@cloudmail.bridge>`;

  headers.push(`Message-ID: ${messageId}`);
  headers.push(`Date: ${email.createTime ? new Date(email.createTime).toUTCString() : new Date().toUTCString()}`);
  headers.push(`From: ${formatAddressList([{ name: email.name, address: email.sendEmail }])}`);
  headers.push(`To: ${formatAddressList(email.recipient || email.toEmail)}`);

  if (email.cc) {
    const cc = formatAddressList(email.cc);
    if (cc) headers.push(`Cc: ${cc}`);
  }
  if (email.bcc) {
    const bcc = formatAddressList(email.bcc);
    if (bcc) headers.push(`Bcc: ${bcc}`);
  }

  headers.push(`Subject: ${encodeHeaderValue(email.subject || '')}`);

  if (email.inReplyTo) {
    headers.push(`In-Reply-To: ${email.inReplyTo}`);
  }
  if (email.relation) {
    headers.push(`References: ${email.relation}`);
  }

  return headers;
}

export async function buildEml(email, client = cloudMail) {
  const attachments = [];
  let inlineAttachments = [];

  if (email.attList && email.attList.length > 0) {
    for (const att of email.attList) {
      const content = await client.fetchAttachment(att.key);
      attachments.push({ ...att, content });
    }
  }

  const hasHtml = !!(email.content && email.content.trim());
  const hasText = !!(email.text && email.text.trim());
  const hasAttachments = attachments.length > 0;

  let body = '';
  const headers = buildHeaders(email);
  const boundary = generateBoundary();

  if (!hasHtml && !hasText && !hasAttachments) {
    headers.push('Content-Type: text/plain; charset=UTF-8');
    headers.push('Content-Transfer-Encoding: 7bit');
    headers.push('');
    headers.push('');
    return headers.join('\r\n');
  }

  if (!hasAttachments) {
    if (hasHtml && hasText) {
      headers.push(`Content-Type: multipart/alternative;\r\n\tboundary="${boundary}"`);
      headers.push('');
      body += `--${boundary}\r\n`;
      body += `Content-Type: text/plain; charset=UTF-8\r\n`;
      body += `Content-Transfer-Encoding: base64\r\n\r\n`;
      body += Buffer.from(email.text).toString('base64') + '\r\n';
      body += `--${boundary}\r\n`;
      body += `Content-Type: text/html; charset=UTF-8\r\n`;
      body += `Content-Transfer-Encoding: base64\r\n\r\n`;
      body += Buffer.from(email.content).toString('base64') + '\r\n';
      body += `--${boundary}--\r\n`;
    } else if (hasHtml) {
      headers.push('Content-Type: text/html; charset=UTF-8');
      headers.push('Content-Transfer-Encoding: base64');
      headers.push('');
      body += Buffer.from(email.content).toString('base64') + '\r\n';
    } else {
      headers.push('Content-Type: text/plain; charset=UTF-8');
      headers.push('Content-Transfer-Encoding: base64');
      headers.push('');
      body += Buffer.from(email.text).toString('base64') + '\r\n';
    }
    return headers.join('\r\n') + body;
  }

  // Multipart mixed for attachments
  headers.push(`Content-Type: multipart/mixed;\r\n\tboundary="${boundary}"`);
  headers.push('');

  let htmlContent = email.content || '';

  // If HTML references inline attachments by cid, include them
  const partBoundary = generateBoundary();
  body += `--${boundary}\r\n`;

  if (hasHtml && hasText) {
    body += `Content-Type: multipart/alternative;\r\n\tboundary="${partBoundary}"\r\n\r\n`;
    body += `--${partBoundary}\r\n`;
    body += `Content-Type: text/plain; charset=UTF-8\r\n`;
    body += `Content-Transfer-Encoding: base64\r\n\r\n`;
    body += Buffer.from(email.text).toString('base64') + '\r\n';
    body += `--${partBoundary}\r\n`;
    body += `Content-Type: text/html; charset=UTF-8\r\n`;
    body += `Content-Transfer-Encoding: base64\r\n\r\n`;
    body += Buffer.from(htmlContent).toString('base64') + '\r\n';
    body += `--${partBoundary}--\r\n`;
  } else if (hasHtml) {
    body += `Content-Type: text/html; charset=UTF-8\r\n`;
    body += `Content-Transfer-Encoding: base64\r\n\r\n`;
    body += Buffer.from(htmlContent).toString('base64') + '\r\n';
  } else {
    body += `Content-Type: text/plain; charset=UTF-8\r\n`;
    body += `Content-Transfer-Encoding: base64\r\n\r\n`;
    body += Buffer.from(email.text || '').toString('base64') + '\r\n';
  }

  for (const att of attachments) {
    const filename = encodeHeaderValue(att.filename || 'attachment');
    const disposition = att.contentId ? 'inline' : 'attachment';
    body += `--${boundary}\r\n`;
    body += `Content-Type: ${att.mimeType || 'application/octet-stream'}; name="${filename}"\r\n`;
    body += `Content-Disposition: ${disposition}; filename="${filename}"\r\n`;
    if (att.contentId) {
      body += `Content-ID: <${att.contentId}>\r\n`;
    }
    body += `Content-Transfer-Encoding: base64\r\n\r\n`;
    body += att.content.toString('base64') + '\r\n';
  }

  body += `--${boundary}--\r\n`;
  return headers.join('\r\n') + body;
}
