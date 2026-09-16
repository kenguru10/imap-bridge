import { createHash } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export function ensureDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function sha256(str) {
  return createHash('sha256').update(str).digest('hex');
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function parseEmailAddress(addr) {
  if (!addr) return { name: '', address: '' };
  const match = addr.match(/^(?:"?([^"]*?)"?\s*)?<?([^>]+)>?$/);
  if (match) {
    return { name: match[1]?.trim() || '', address: match[2].trim() };
  }
  return { name: '', address: addr.trim() };
}

export function formatEmailAddress({ name, address }) {
  if (name) {
    const safeName = name.replace(/"/g, '\\"');
    return `"${safeName}" <${address}>`;
  }
  return address;
}

export function sanitizeFolderName(email) {
  return email.replace(/[^a-zA-Z0-9._@-]/g, '_');
}

export function parseMaildirFlags(filename) {
  const match = filename.match(/:2,([A-Za-z]*)$/);
  return match ? match[1].split('') : [];
}

export function setMaildirFlags(filename, flags) {
  const base = filename.replace(/:2,[A-Za-z]*$/, '');
  const flagStr = [...new Set(flags)].sort().join('');
  return flagStr ? `${base}:2,${flagStr}` : base;
}

export function nowIso() {
  return new Date().toISOString();
}
