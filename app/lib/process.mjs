// v1.1.2 项目过程记录：把每个环节做了什么结构化留下来
// 与 events 表的区别：events 只记一句流水；这里记「动作 + 结果 + 耗时 + 消耗」，归档时进 06过程记录/
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';
import { nowIso } from './util.mjs';

export const PROC_DIR = path.join(DATA_DIR, '过程');
const MAX_ENTRIES = 2000;

function procFile(pid) { return path.join(PROC_DIR, pid + '.json'); }

export function ensureProcDirs() { fs.mkdirSync(PROC_DIR, { recursive: true }); }

export function loadProcess(pid) {
  try { return JSON.parse(fs.readFileSync(procFile(pid), 'utf8')); }
  catch { return { projectId: pid, updatedAt: '', entries: [] }; }
}

/**
 * 记一条过程
 * @param {string} pid 项目 id
 * @param {object} e { kind, title, detail, meta }
 * kind: create/upload/analysis/draft/studio/check/submit/export/archive/reopen/settings
 */
export function appendProcess(pid, e) {
  if (!pid) return null;
  ensureProcDirs();
  const p = loadProcess(pid);
  const rec = {
    id: 'pr_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7),
    at: nowIso(),
    kind: String((e && e.kind) || 'other'),
    title: String((e && e.title) || '').slice(0, 200),
    detail: String((e && e.detail) || '').slice(0, 4000),
    meta: (e && e.meta) || null
  };
  p.entries.push(rec);
  if (p.entries.length > MAX_ENTRIES) p.entries = p.entries.slice(-MAX_ENTRIES);
  p.updatedAt = rec.at;
  try {
    fs.mkdirSync(PROC_DIR, { recursive: true });
    fs.writeFileSync(procFile(pid), JSON.stringify(p, null, 1), 'utf8');
  } catch { /* 记录失败不影响主流程 */ }
  return rec;
}

// 归档时复制进 06过程记录/
export function copyProcessTo(pid, dstDir) {
  const p = loadProcess(pid);
  fs.mkdirSync(dstDir, { recursive: true });
  const f = path.join(dstDir, '过程记录.json');
  fs.writeFileSync(f, JSON.stringify(p, null, 2), 'utf8');
  // 同时给一份人能直接看的文本版
  const lines = ['项目过程记录（由投标业务工作台自动记录）', ''];
  (p.entries || []).forEach((x) => {
    lines.push('[' + String(x.at || '').replace('T', ' ').slice(0, 19) + '] ' + x.title);
    if (x.detail) lines.push('    ' + String(x.detail).replace(/\n/g, '\n    '));
  });
  fs.writeFileSync(path.join(dstDir, '过程记录.txt'), lines.join('\r\n'), 'utf8');
  return (p.entries || []).length;
}

// 清理历史遗留的大文件：分析备份只留最近 N 个、核查转换 PDF 只留最近 N 份
export function pruneData(opt = {}) {
  const keepBak = opt.keepBak || 3;
  const keepConv = opt.keepConv || 2;
  const dry = opt.dryRun === true || opt.dryRun === '1';
  const del = (f) => { try { report.bytes += fs.statSync(f).size; } catch {} if (!dry) { try { fs.unlinkSync(f); } catch {} } };
  const report = { bakRemoved: 0, convRemoved: 0, previewRemoved: 0, bytes: 0 };
  const anDir = path.join(DATA_DIR, '分析');
  try {
    const byPid = {};
    for (const n of fs.readdirSync(anDir)) {
      const m = /^(.+)\.bak-(\d+)\.json$/.exec(n);
      if (!m) continue;
      (byPid[m[1]] = byPid[m[1]] || []).push({ n, t: Number(m[2]) });
    }
    Object.values(byPid).forEach((arr) => {
      arr.sort((a, b) => b.t - a.t);
      arr.slice(keepBak).forEach((x) => {
        try { del(path.join(anDir, x.n)); report.bakRemoved++; } catch {}
      });
    });
  } catch {}
  const convDir = path.join(DATA_DIR, '核查', '.conv');
  try {
    if (fs.existsSync(convDir)) {
      const files = fs.readdirSync(convDir).map((n) => {
        const f = path.join(convDir, n);
        try { return { f, t: fs.statSync(f).mtimeMs }; } catch { return null; }
      }).filter(Boolean).sort((a, b) => b.t - a.t);
      files.slice(keepConv).forEach((x) => {
        try { del(x.f); report.convRemoved++; } catch {}
      });
    }
  } catch {}
  // 预览目录是开发调试截图，不属于用户数据
  const prevDir = path.join(DATA_DIR, '预览');
  try {
    if (fs.existsSync(prevDir)) {
      for (const n of fs.readdirSync(prevDir)) {
        const f = path.join(prevDir, n);
        try { const st = fs.statSync(f); if (st.isFile()) report.bytes += st.size; if (!dry) fs.rmSync(f, { recursive: true, force: true }); report.previewRemoved++; } catch {}
      }
      if (!dry) { try { fs.rmdirSync(prevDir); } catch {} }
    }
  } catch {}
  return report;
}
