const { IMAPServer } = require('imap-core');
const config = require('./config');

class NoopNotifier {
  addListener() {}
  removeListener() {}
  addEntries(username, mailbox, entries, callback) {
    setImmediate(() => callback(null, true));
  }
  fire() {}
  getUpdates(session, mailbox, modifyIndex, callback) {
    setImmediate(() => callback(null, []));
  }
}

function createIMAPServer(getSessionStore) {
  const hasTls = !!(config.tlsKeyPath && config.tlsCertPath);
  const options = {
    secure: false,
    ignoreSTARTTLS: !hasTls,
    id: { name: 'cloud-mail-bridge' },
  };

  if (hasTls) {
    const fs = require('fs');
    const key = fs.readFileSync(config.tlsKeyPath);
    const cert = fs.readFileSync(config.tlsCertPath);
    if (config.imapPort === 993) {
      options.secure = true;
      options.key = key;
      options.cert = cert;
    } else {
      options.tls = { key, cert };
    }
  }

  const server = new IMAPServer(options);
  server.notifier = new NoopNotifier();

  server.onAuth = async (login, session, callback) => {
    try {
      const { store } = await getSessionStore(login.username, login.password);
      callback(null, {
        user: {
          username: login.username,
          store,
        },
      });
    } catch (err) {
      console.error('IMAP auth failed:', err.message);
      callback(new Error('Authentication failed'));
    }
  };

  server.onList = (query, session, callback) => {
    const folders = session.user.store.folders;
    const list = [];
    folders.forEach((folder) => {
      const item = { path: folder.path, flags: folder.flags || [] };
      if (folder.specialUse) item.specialUse = folder.specialUse;
      list.push(item);
    });
    callback(null, list);
  };

  server.onLsub = server.onList;

  server.onStatus = (mailbox, session, callback) => {
    const folder = session.user.store.folders.get(mailbox);
    if (!folder) return callback(null, 'NONEXISTENT');
    const unseen = folder.messages.filter((m) => !m.flags.includes('\\Seen')).length;
    callback(null, {
      messages: folder.messages.length,
      uidNext: folder.uidNext,
      uidValidity: folder.uidValidity,
      unseen,
    });
  };

  server.onOpen = (mailbox, session, callback) => {
    const folder = session.user.store.folders.get(mailbox);
    if (!folder) return callback(null, 'NONEXISTENT');
    callback(null, {
      specialUse: folder.specialUse,
      uidValidity: folder.uidValidity,
      uidNext: folder.uidNext,
      modifyIndex: folder.modifyIndex,
      uidList: folder.messages.map((m) => m.uid),
    });
  };

  server.onFetch = async (mailbox, options, session, callback) => {
    const folder = session.user.store.folders.get(mailbox);
    if (!folder) return callback(null, 'NONEXISTENT');

    if (options.markAsSeen) {
      const toMark = folder.messages
        .filter((m) => options.messages.includes(m.uid) && !m.flags.includes('\\Seen'))
        .map((m) => m.uid);
      if (toMark.length) {
        try {
          await session.user.store.markSeen(toMark);
          for (const m of folder.messages) {
            if (toMark.includes(m.uid) && !m.flags.includes('\\Seen')) {
              m.flags.push('\\Seen');
            }
          }
        } catch (e) {
          console.error('Failed to mark seen:', e.message);
        }
      }
    }

    folder.messages.forEach((message) => {
      if (options.messages.includes(message.uid)) {
        session.writeStream.write(
          session.formatResponse('FETCH', message.uid, {
            query: options.query,
            values: session.getQueryResponse(options.query, message),
          })
        );
      }
    });

    callback(null, true);
  };

  server.onSearch = (mailbox, options, session, callback) => {
    const folder = session.user.store.folders.get(mailbox);
    if (!folder) return callback(null, 'NONEXISTENT');
    const uidList = folder.messages
      .filter((message) => session.matchSearchQuery(message, options.query))
      .map((message) => message.uid);
    callback(null, { uidList, highestModseq: folder.modifyIndex });
  };

  server.onUpdate = async (mailbox, update, session, callback) => {
    const folder = session.user.store.folders.get(mailbox);
    if (!folder) return callback(null, 'NONEXISTENT');

    const changedIds = [];

    for (const message of folder.messages) {
      if (!update.messages.includes(message.uid)) continue;

      let updated = false;
      switch (update.action) {
        case 'set':
          if (
            message.flags.length !== update.value.length ||
            update.value.some((f) => !message.flags.includes(f))
          ) {
            updated = true;
          }
          message.flags = [].concat(update.value);
          break;
        case 'add':
          for (const f of update.value) {
            if (!message.flags.includes(f)) {
              message.flags.push(f);
              updated = true;
            }
          }
          break;
        case 'remove':
          const before = message.flags.length;
          message.flags = message.flags.filter((f) => !update.value.includes(f));
          if (message.flags.length !== before) updated = true;
          break;
      }

      if (updated) changedIds.push(message.uid);
    }

    // Persist \Seen changes to the worker.
    const seenIds = changedIds.filter((id) => {
      const rec = session.user.store.emailMap.get(id);
      return rec && rec.message.flags.includes('\\Seen');
    });
    if (seenIds.length) {
      try {
        await session.user.store.markSeen(seenIds);
      } catch (e) {
        console.error('Failed to persist read state:', e.message);
      }
    }

    if (!update.silent) {
      for (const message of folder.messages) {
        if (changedIds.includes(message.uid)) {
          session.writeStream.write(
            session.formatResponse('FETCH', message.uid, {
              uid: update.isUid ? message.uid : false,
              flags: message.flags,
            })
          );
        }
      }
    }

    callback(null, true);
  };

  server.onExpunge = async (mailbox, update, session, callback) => {
    const folder = session.user.store.folders.get(mailbox);
    if (!folder) return callback(null, 'NONEXISTENT');

    const deletedIds = [];
    for (let i = folder.messages.length - 1; i >= 0; i--) {
      const message = folder.messages[i];
      const inSet = update.isUid ? update.messages.includes(message.uid) : true;
      if (inSet && message.flags.includes('\\Deleted')) {
        deletedIds.unshift(message.uid);
        folder.messages.splice(i, 1);
        session.user.store.emailMap.delete(message.uid);
      }
    }

    if (deletedIds.length) {
      try {
        await session.user.store.deleteMessages(deletedIds);
      } catch (e) {
        console.error('Failed to delete messages:', e.message);
      }
    }

    callback(null, true);
  };

  server.onAppend = (mailbox, flags, date, raw, session, callback) => {
    const folder = session.user.store.folders.get(mailbox);
    if (!folder) return callback(null, 'TRYCREATE');
    // We accept APPEND (e.g. Outlook saving a sent copy) but do not duplicate it,
    // because sent mail is already stored by the worker when SMTP sends it.
    callback(null, true);
  };

  server.onCreate = (mailbox, session, callback) => callback(null, true);
  server.onDelete = (mailbox, session, callback) => callback(null, 'CANNOT');
  server.onRename = (mailbox, newname, session, callback) => callback(null, 'CANNOT');
  server.onSubscribe = (mailbox, session, callback) => callback(null, true);
  server.onUnsubscribe = (mailbox, session, callback) => callback(null, true);
  server.onClose = (session, callback) => callback(null, true);
  server.onCopy = (mailbox, update, session, callback) => callback(null, true);

  server.on('error', (err) => {
    console.error('IMAP server error:', err.stack || err.message);
  });

  return server;
}

module.exports = { createIMAPServer };
