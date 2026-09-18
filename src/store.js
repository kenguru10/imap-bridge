const { buildRaw } = require('./mime-builder');
const { simpleParser } = require('mailparser');
const config = require('./config');

function createFolder(path, specialUse) {
  return {
    path,
    specialUse,
    uidValidity: 1,
    uidNext: 1,
    modifyIndex: 0,
    messages: [],
    journal: [],
    flags: specialUse ? [] : [],
  };
}

function binaryInsert(arr, message) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].uid < message.uid) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, message);
}

class MailStore {
  constructor(client) {
    this.client = client;
    this.baseUrl = config.workerUrl;
    this.folders = new Map();
    this.accounts = [];
    this.accountMap = new Map();
    this.emailMap = new Map(); // emailId -> { folder, index }
    this.lastReceivedIds = new Map(); // accountId -> emailId
    this.pollTimer = null;
  }

  async init() {
    this.accounts = await this.client.listAllAccounts();
    for (const acc of this.accounts) {
      this.accountMap.set(acc.accountId, acc);
      this.lastReceivedIds.set(acc.accountId, 0);
    }

    this.folders.set('INBOX', createFolder('INBOX', '\\Inbox'));
    this.folders.set('Sent', createFolder('Sent', '\\Sent'));
    this.folders.set('Trash', createFolder('Trash', '\\Trash'));

    // Load recent received mail into INBOX.
    for (const account of this.accounts) {
      await this._loadTypeForAccount(account, 0, 'INBOX');
    }

    this._recomputeUidNext();
    this._startPolling();
  }

  findAccountByEmail(email) {
    const lower = (email || '').toLowerCase();
    return this.accounts.find((a) => a.email.toLowerCase() === lower);
  }

  async _loadTypeForAccount(account, type, folderName, max = config.maxInitialMessages) {
    const folder = this.folders.get(folderName);
    if (!folder) return;

    let emailId = 0;
    let loaded = 0;
    while (loaded < max) {
      const data = await this.client.listEmails({
        accountId: account.accountId,
        type,
        size: 50,
        full: 1,
        emailId,
        timeSort: 0,
      });

      if (!data || !data.list || !data.list.length) break;

      for (const row of data.list) {
        const msg = await this._buildMessage(row);
        if (msg) {
          binaryInsert(folder.messages, msg);
          this.emailMap.set(row.emailId, { folder, message: msg });
          if (type === 0) {
            const current = this.lastReceivedIds.get(account.accountId) || 0;
            if (row.emailId > current) this.lastReceivedIds.set(account.accountId, row.emailId);
          }
        }
      }

      loaded += data.list.length;
      const last = data.list[data.list.length - 1];
      emailId = last.emailId;
      if (data.list.length < 50) break;
    }
  }

  async _buildMessage(row, attachmentOverride) {
    let attachments = attachmentOverride;
    if (!attachments && row.attList && row.attList.length) {
      attachments = await Promise.all(
        row.attList.map(async (att) => {
          const url = `${this.baseUrl}/${att.key}`;
          const content = await this.client.fetchBuffer(url);
          return { ...att, content };
        })
      );
    }

    const raw = await buildRaw(row, attachments || [], this.baseUrl);
    return {
      uid: row.emailId,
      flags: row.unread === 1 ? ['\\Seen'] : [],
      date: row.createTime ? new Date(row.createTime) : new Date(),
      internaldate: row.createTime ? new Date(row.createTime) : new Date(),
      modseq: row.emailId,
      raw,
    };
  }

  _recomputeUidNext() {
    for (const folder of this.folders.values()) {
      let max = 1;
      for (const m of folder.messages) {
        if (m.uid >= max) max = m.uid + 1;
      }
      folder.uidNext = max;
    }
  }

  _startPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => this._poll().catch((e) => console.error('Poll error', e)), config.pollIntervalMs);
  }

  async _poll() {
    for (const account of this.accounts) {
      const lastId = this.lastReceivedIds.get(account.accountId) || 0;
      const data = await this.client.latestEmails({
        accountId: account.accountId,
        emailId: lastId,
        allReceive: 0,
      });

      if (!data || !data.list || !data.list.length) continue;

      const inbox = this.folders.get('INBOX');
      for (const row of data.list) {
        if (this.emailMap.has(row.emailId)) continue;
        const msg = await this._buildMessage(row);
        if (msg) {
          binaryInsert(inbox.messages, msg);
          this.emailMap.set(row.emailId, { folder: inbox, message: msg });
        }
        if (row.emailId > lastId) this.lastReceivedIds.set(account.accountId, row.emailId);
      }
      inbox.uidNext = Math.max(inbox.uidNext, (this.lastReceivedIds.get(account.accountId) || 0) + 1);
    }
  }

  async appendSentCopy(parsed, emailResult) {
    const sent = this.folders.get('Sent');
    if (!sent) return;

    const emailId = emailResult.emailId;
    if (this.emailMap.has(emailId)) return;

    const from = parsed.from && parsed.from.value && parsed.from.value[0];
    const row = {
      emailId,
      sendEmail: from ? from.address : emailResult.sendEmail,
      name: from ? from.name || '' : emailResult.name || '',
      subject: parsed.subject || '',
      text: parsed.text || '',
      content: parsed.html || '',
      recipient: JSON.stringify((parsed.to && parsed.to.value) || []),
      cc: JSON.stringify((parsed.cc && parsed.cc.value) || []),
      bcc: JSON.stringify((parsed.bcc && parsed.bcc.value) || []),
      messageId: parsed.messageId || emailResult.messageId,
      createTime: emailResult.createTime || new Date().toISOString(),
      unread: 1,
    };

    const attachments = (parsed.attachments || []).map((att) => ({
      filename: att.filename,
      content: att.content,
      mimeType: att.contentType,
      contentId: att.cid,
      disposition: att.contentDisposition,
      type: att.cid ? 1 : 0,
      key: '',
    }));

    const raw = await buildRaw(row, attachments, this.baseUrl);
    const msg = {
      uid: emailId,
      flags: ['\\Seen'],
      date: row.createTime ? new Date(row.createTime) : new Date(),
      internaldate: row.createTime ? new Date(row.createTime) : new Date(),
      modseq: emailId,
      raw,
    };

    binaryInsert(sent.messages, msg);
    this.emailMap.set(emailId, { folder: sent, message: msg });
    if (emailId >= sent.uidNext) sent.uidNext = emailId + 1;
  }

  async appendRaw(mailbox, rawBuffer, flags, date) {
    const folder = this.folders.get(mailbox);
    if (!folder || mailbox !== 'Sent') return null;

    const parsed = await simpleParser(rawBuffer, { keepCidLinks: true });
    const emailId = Date.now();
    const from = parsed.from && parsed.from.value && parsed.from.value[0];
    const row = {
      emailId,
      sendEmail: from ? from.address : '',
      name: from ? from.name || '' : '',
      subject: parsed.subject || '',
      text: parsed.text || '',
      content: parsed.html || '',
      recipient: JSON.stringify((parsed.to && parsed.to.value) || []),
      cc: JSON.stringify((parsed.cc && parsed.cc.value) || []),
      bcc: JSON.stringify((parsed.bcc && parsed.bcc.value) || []),
      messageId: parsed.messageId,
      createTime: date ? new Date(date).toISOString() : new Date().toISOString(),
      unread: 1,
    };

    const attachments = (parsed.attachments || []).map((att) => ({
      filename: att.filename,
      content: att.content,
      mimeType: att.mimeType,
      contentId: att.cid,
      disposition: att.contentDisposition,
      type: att.cid ? 1 : 0,
      key: '',
    }));

    const raw = await buildRaw(row, attachments, this.baseUrl);
    const msg = {
      uid: emailId,
      flags: flags && flags.length ? flags : ['\\Seen'],
      date: row.createTime ? new Date(row.createTime) : new Date(),
      internaldate: row.createTime ? new Date(row.createTime) : new Date(),
      modseq: emailId,
      raw,
    };

    binaryInsert(folder.messages, msg);
    this.emailMap.set(emailId, { folder, message: msg });
    if (emailId >= folder.uidNext) folder.uidNext = emailId + 1;
    return { uidValidity: folder.uidValidity, uid: emailId };
  }

  async markSeen(emailIds) {
    const ids = emailIds.filter((id) => {
      const rec = this.emailMap.get(id);
      return rec && !rec.message.flags.includes('\\Seen');
    });
    if (!ids.length) return;
    await this.client.readEmails(ids);
    for (const id of ids) {
      const rec = this.emailMap.get(id);
      if (rec && !rec.message.flags.includes('\\Seen')) {
        rec.message.flags.push('\\Seen');
      }
    }
  }

  async deleteMessages(emailIds) {
    if (!emailIds.length) return;
    await this.client.deleteEmails(emailIds);
    for (const id of emailIds) {
      const rec = this.emailMap.get(id);
      if (!rec) continue;
      const folder = rec.folder;
      const idx = folder.messages.findIndex((m) => m.uid === id);
      if (idx >= 0) folder.messages.splice(idx, 1);
      this.emailMap.delete(id);
    }
  }

  stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }
}

module.exports = { MailStore };
