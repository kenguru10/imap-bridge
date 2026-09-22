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
    this.resendSyncedIds = new Set(); // Resend email ids already synced into Sent
    this.resendNextPage = null; // pagination cursor for incremental sync
    this.resendUidSeq = null; // numeric uid allocator for Resend-synced messages
    this.resendSentUidMax = 0;
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

    if (this.resendSyncEnabled()) {
      try {
        await this.syncResendSent();
      } catch (e) {
        if (config.verbose) console.error('Initial Resend sent sync failed:', e.message);
      }
    }

    this._recomputeUidNext();
    this._startPolling();
  }

  resendSyncEnabled() {
    // Enabled by default when an API key is configured; opt out with
    // RESEND_SYNC_SENT=false (the key may also be used for SMTP relay alone).
    if (!config.resendApiKey) return false;
    const raw = (process.env.RESEND_SYNC_SENT || 'true').toLowerCase();
    return !['0', 'false', 'no', 'off'].includes(raw);
  }

  // GET https://api.resend.com/emails
  async resendRequest(path, params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    const suffix = qs.size ? `?${qs.toString()}` : '';
    const res = await fetch(`${config.resendApiBase}${path}${suffix}`, {
      headers: { Authorization: `Bearer ${config.resendApiKey}` },
    });
    if (!res.ok) {
      throw new Error(`Resend API ${path} failed: ${res.status} ${await res.text()}`);
    }
    return res.json();
  }

  // Pull real sent emails from the Resend API into the local Sent folder.
  // Initial run loads the first page(s); subsequent runs fetch only the
  // saved next-page cursor so newly sent mail appears between polls.
  async syncResendSent() {
    if (!this.resendSyncEnabled()) return;
    const sent = this.folders.get('Sent');
    if (!sent) return;

    const page = this.resendNextPage || 1;
    const json = await this.resendRequest('/emails', {
      limit: config.resendSentPageSize,
      page,
    });

    const emails = (json.data || []).slice().reverse(); // oldest first
    for (const em of emails) {
      if (this.resendSyncedIds.has(em.id)) continue;
      const uid = this._nextResendSentUid();
      const raw = await this._resendEmailToRaw(em);
      const msg = {
        uid,
        flags: ['\\Seen'],
        date: em.createdAt ? new Date(em.createdAt) : new Date(),
        internaldate: em.createdAt ? new Date(em.createdAt) : new Date(),
        modseq: uid,
        raw,
      };
      binaryInsert(sent.messages, msg);
      this.emailMap.set(uid, { folder: sent, message: msg });
      this.resendSyncedIds.add(em.id);
      if (config.verbose) {
        console.log(`[Resend] synced sent email ${em.id}: ${em.subject || '(no subject)'}`);
      }
    }

    this.resendNextPage = json.has_next_page ? json.next_page : null;
    this._recomputeUidNext();
  }

  _nextResendSentUid() {
    const sent = this.folders.get('Sent');
    if (this.resendUidSeq === null) {
      let max = 1;
      for (const m of sent.messages) if (m.uid >= max) max = m.uid + 1;
      this.resendUidSeq = max;
    }
    const uid = this.resendUidSeq++;
    if (uid >= sent.uidNext) sent.uidNext = uid + 1;
    return uid;
  }

  // Convert a Resend email object into a raw MIME message using buildRaw.
  async _resendEmailToRaw(em) {
    const fromStr = em.from || '';
    const m = fromStr.match(/^(.*?)\s*<([^>]+)>$/);
    const sendEmail = m ? m[2].trim() : fromStr;
    const rawName = m ? m[1].trim() : fromStr;
    const name = rawName.replace(/^"|"$/g, '');
    const toMap = (arr) =>
      (arr || []).map((a) => (typeof a === 'string' ? a : a ? { address: a.email, name: a.name || '' } : null)).filter(Boolean);
    const row = {
      emailId: 0,
      sendEmail,
      name,
      subject: em.subject || '',
      text: em.text || '',
      content: em.html || '',
      recipient: JSON.stringify(toMap(em.to)),
      cc: JSON.stringify(toMap(em.cc)),
      bcc: JSON.stringify(toMap(em.bcc)),
      createTime: em.createdAt || new Date().toISOString(),
      unread: 1,
    };
    // NOTE: attachment files referenced in the list response are not
    // downloaded here (would need a GET /files/{id} per attachment).
    return buildRaw(row, [], this.baseUrl);
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
    this.pollTimer = setInterval(() => this._poll().catch((e) => { if (config.verbose) console.error('Poll error', e); }), config.pollIntervalMs);
  }

  async _poll() {
    if (this.resendSyncEnabled() && this.resendNextPage) {
      await this.syncResendSent();
    }

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

  async appendSentCopy(parsed, emailResult, viaResend = false) {
    // When the message went through Resend and sent-sync is active, the real
    // email is pulled from the Resend API instead, so skip the synthetic
    // local copy.
    if (viaResend && this.resendSyncEnabled()) return;

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
