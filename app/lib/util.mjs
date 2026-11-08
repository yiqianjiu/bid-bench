import fs from 'node:fs';
import crypto from 'node:crypto';

export function uid(prefix) {
  return (prefix || '') + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function nowIso() { return new Date().toISOString(); }

export function safeName(name, fallback) {
  let s = String(name || '').replace(/[\\/:*?"<>|\r\n\t]/g, ' ').trim();
  s = s.replace(/\s+/g, ' ');
  if (!s) s = fallback || '未命名';
  if (s.length > 80) s = s.slice(0, 80);
  return s;
}

export function shortName(name) {
  let s = String(name || '').replace(/[\\/:*?"<>|]/g, '').trim();
  if (!s) return '项目';
  return s.length > 24 ? s.slice(0, 24) : s;
}

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function daysLeft(deadline) {
  if (!deadline) return null;
  const t = Date.parse(deadline.replace(' ', 'T'));
  if (Number.isNaN(t)) return null;
  const diff = t - Date.now();
  return Math.floor(diff / 86400000);
}
