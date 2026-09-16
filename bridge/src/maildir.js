import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import config from './config.js';
import { ensureDir, sanitizeFolderName, parseMaildirFlags, setMaildirFlags } from './utils.js';

const DEFAULT_MAILDIR_BASE = config.sync.maildirBase || config.imap.maildirBase;

export function getMaildirRoot(base = DEFAULT_MAILDIR_BASE) {
  return base;
}

export function getFolderPath(folderName = 'INBOX', base = DEFAULT_MAILDIR_BASE) {
  const root = base;
  if (folderName === 'INBOX') {
    return root;
  }
  return join(root, `.${sanitizeFolderName(folderName)}`);
}

export function ensureMaildir(folderName = 'INBOX', base = DEFAULT_MAILDIR_BASE) {
  const path = getFolderPath(folderName, base);
  for (const sub of ['cur', 'new', 'tmp']) {
    ensureDir(join(path, sub));
  }
  return path;
}

export function listMaildirMessages(folderName = 'INBOX', base = DEFAULT_MAILDIR_BASE) {
  const path = ensureMaildir(folderName, base);
  const messages = [];
  for (const sub of ['cur', 'new']) {
    const dir = join(path, sub);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      messages.push({
        folder: folderName,
        filename: file,
        path: join(dir, file),
        flags: parseMaildirFlags(file)
      });
    }
  }
  return messages;
}

export function findMessageById(emailId, folderName = 'INBOX', base = DEFAULT_MAILDIR_BASE) {
  const messages = listMaildirMessages(folderName, base);
  const prefix = `${emailId}_`;
  return messages.find(m => m.filename.startsWith(prefix));
}

export function writeMessage(folderName, emailId, emlContent, flags = [], base = DEFAULT_MAILDIR_BASE) {
  const path = ensureMaildir(folderName, base);
  const tmpDir = join(path, 'tmp');
  const newDir = join(path, 'new');

  const timestamp = Date.now();
  const baseName = `${emailId}_${timestamp}`;
  const tmpFile = join(tmpDir, baseName);
  const newFile = join(newDir, setMaildirFlags(baseName, flags));

  writeFileSync(tmpFile, emlContent);
  renameSync(tmpFile, newFile);

  return newFile;
}

export function updateMessageFlags(folderName, emailId, flags, base = DEFAULT_MAILDIR_BASE) {
  const msg = findMessageById(emailId, folderName, base);
  if (!msg) return null;

  const newFilename = setMaildirFlags(msg.filename, flags);
  if (newFilename === msg.filename) return msg.path;

  const newPath = join(dirname(msg.path), newFilename);
  renameSync(msg.path, newPath);
  return newPath;
}

export function moveMessage(emailId, fromFolder, toFolder, flags = [], base = DEFAULT_MAILDIR_BASE, toBase = base) {
  const msg = findMessageById(emailId, fromFolder, base);
  if (!msg) return null;

  // Cross-Maildir-tree move (different base roots): copy + delete
  if (toBase !== base) {
    const content = readFileSync(msg.path, 'utf8');
    writeMessage(toFolder, emailId, content, flags, toBase);
    unlinkSync(msg.path);
    return true;
  }

  const toPath = ensureMaildir(toFolder, base);
  const curDir = join(toPath, 'cur');
  const newDir = join(toPath, 'new');
  const targetDir = msg.path.includes('/cur/') ? curDir : newDir;

  const baseName = `${emailId}_${Date.now()}`;
  const newFilename = setMaildirFlags(baseName, flags);
  const targetPath = join(targetDir, newFilename);

  renameSync(msg.path, targetPath);
  return targetPath;
}

export function deleteMessage(emailId, folderName = 'INBOX', base = DEFAULT_MAILDIR_BASE) {
  const msg = findMessageById(emailId, folderName, base);
  if (!msg) return false;
  unlinkSync(msg.path);
  return true;
}
