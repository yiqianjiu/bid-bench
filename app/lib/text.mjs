import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';
import { extractPdfText, extractDocxText, docToDocx, renderPdfPages, pdfPageCount } from './extract.mjs';
import { callVisionJson, callText } from './ai.mjs';
import { SYSTEM_OCR } from './prompt.mjs';
import { detectOcr, ocrImageFile } from './ocr.mjs';

export const TEXT_DIR = path.join(DATA_DIR, '文本');
export const RENDER_DIR = path.join(DATA_DIR, '预览');

export function ensureTextDirs() {
  fs.mkdirSync(TEXT_DIR, { recursive: true });
  fs.mkdirSync(RENDER_DIR, { recursive: true });
}

function cacheFile(fileId) {
  return path.join(TEXT_DIR, fileId + '.json');
}

export function readTextCache(fileId) {
  const f = cacheFile(fileId);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

export function writeTextCache(fileId, obj) {
  ensureTextDirs();
  fs.writeFileSync(cacheFile(fileId), JSON.stringify(obj), 'utf8');
}

export function buildFullText(pages) {
  return pages
    .filter((p) => p && p.text && p.text.trim())
    .map((p) => '【第 ' + p.page + ' 页】\n' + p.text.trim())
    .join('\n\n');
}

// 抽取文本（PDF / DOCX / DOC），返回缓存对象
// 旧版本 bug 会写出 pageCount=0 的坏缓存（PDF 明明有多页），这种缓存必须丢掉重读
function cacheUsable(c) {
  if (!c || !Array.isArray(c.pages) || !c.pages.length) return false;
  if (c.kind === 'pdf' && !c.pageCount) return false;
  return true;
}

export async function ensureText(fileRow, absPath) {
  const cached = readTextCache(fileRow.id);
  if (cacheUsable(cached)) return cached;

  const ext = path.extname(fileRow.originalName).toLowerCase();
  const buf = fs.readFileSync(absPath);
  let pages = [];
  let kind = '';

  if (ext === '.pdf') {
    kind = 'pdf';
    try {
      pages = await extractPdfText(buf);
    } catch (e) {
      const err = new Error('这份 PDF 没能读出文字：' + (e && e.message || e));
      err.code = 'PDF_EXTRACT_FAILED';
      throw err;
    }
    if (!pages.length) {
      const n = await pdfPageCount(buf).catch(() => 0);
      const err = new Error('这份 PDF 一页文字都没读出来（共 ' + n + ' 页），文件可能已损坏。');
      err.code = 'PDF_EMPTY';
      throw err;
    }
  } else if (ext === '.docx') {
    kind = 'docx';
    const text = await extractDocxText(buf);
    pages = [{ page: 1, text }];
  } else if (ext === '.doc') {
    kind = 'doc';
    const tmpOut = path.join(TEXT_DIR, fileRow.id + '.converted.docx');
    try {
      docToDocx(absPath, tmpOut);
      const text = await extractDocxText(fs.readFileSync(tmpOut));
      pages = [{ page: 1, text }];
    } catch (e) {
      const err = new Error('这个 .doc 文件没能读出来（需要电脑里装有 Word）：' + (e && e.message || e));
      err.code = 'DOC_EXTRACT_FAILED';
      throw err;
    } finally {
      try { fs.unlinkSync(tmpOut); } catch {}
    }
  } else {
    kind = ext.replace('.', '') || 'other';
    pages = [];
  }

  const empty = pages.filter((p) => !p.text || !p.text.trim()).map((p) => p.page);
  const chars = pages.reduce((n, p) => n + (p.text ? p.text.length : 0), 0);
  const obj = {
    fileId: fileRow.id,
    kind,
    pages,
    pageCount: pages.length,
    chars,
    emptyPages: empty,
    scanned: pages.length > 0 && empty.length === pages.length,
    visionPages: [],
    extractedAt: new Date().toISOString()
  };
  writeTextCache(fileRow.id, obj);
  return obj;
}

// 对扫描页做文字识别：先用本机 OCR（免费、快、不外传），识别不出再交给 AI 看图。
// 结果合并进缓存。
export async function ocrPages(fileRow, absPath, pageNumbers) {
  const cache = readTextCache(fileRow.id) || (await ensureText(fileRow, absPath));
  const buf = fs.readFileSync(absPath);
  const images = await renderPdfPages(buf, pageNumbers, 2);
  const results = [];
  const local = detectOcr();
  for (const [pageNo, img] of images) {
    let text = '';
    let engine = '';
    if (local.available) {
      let tmpImg = '';
      try {
        ensureTextDirs();
        tmpImg = path.join(RENDER_DIR, fileRow.id + '_p' + pageNo + '_ocr.png');
        fs.writeFileSync(tmpImg, img);
        const o = ocrImageFile(tmpImg);
        text = String(o.text || '').trim();
        engine = o.engine;
      } catch (e) {
        results.push({ page: pageNo, localError: String(e && e.message || e) });
      } finally {
        if (tmpImg) { try { fs.unlinkSync(tmpImg); } catch {} }
      }
    }
    // 本机识别出来的字太少，说明这页可能是图片/图表，交回 AI 看图
    if (text.length < 20) {
      try {
        const r = await callVisionJson(
          SYSTEM_OCR,
          '这是招标文件第 ' + pageNo + ' 页的图片。请把这一页上的全部文字逐行转写出来，保持原有顺序与层级；表格请按「行1列1 | 行1列2」的格式逐行输出；如果页面是空白页，返回 {"text":"","blank":true}。',
          [img]
        );
        const vt = String(r.text || '').trim();
        if (vt.length > text.length) { text = vt; engine = 'vision'; }
      } catch (e) {
        if (!text) results.push({ page: pageNo, error: String(e && e.message || e) });
      }
    }
    const idx = cache.pages.findIndex((p) => p.page === pageNo);
    const entry = { page: pageNo, text, source: engine === 'vision' ? 'vision' : 'ocr' };
    if (idx >= 0) cache.pages[idx] = entry; else cache.pages.push(entry);
    if (engine === 'vision' && !cache.visionPages.includes(pageNo)) cache.visionPages.push(pageNo);
    results.push({ page: pageNo, chars: text.length, engine });
  }
  cache.pages.sort((a, b) => a.page - b.page);
  cache.chars = cache.pages.reduce((n, p) => n + (p.text ? p.text.length : 0), 0);
  cache.emptyPages = cache.pages.filter((p) => !p.text || !p.text.trim()).map((p) => p.page);
  cache.scanned = cache.pages.length > 0 && cache.emptyPages.length === cache.pages.length;
  writeTextCache(fileRow.id, cache);
  return { cache, results };
}


// ---------- v1.1.5：把投标文件（PDF / Word）切成章节 ----------
// 规则：先按标题行切；一个标题都切不出来时按页切，保证内容不丢。
function headingOf(line) {
  let s = String(line || '').trim();
  if (!s || s.length > 90) return null;
  // PDF 抽出来的文字常在汉字之间插空格（「本 采 购 项 目」），先压掉再判断，
  // 否则「第 一 章」这种永远匹配不上，正文里的数字行反倒被当成标题。
  s = s.replace(/([\u4e00-\u9fa5])\s+(?=[\u4e00-\u9fa5])/g, '$1').replace(/\s{2,}/g, ' ').trim();
  if (!s || s.length > 60) return null;
  // 标题不像正文：不能以句读标点结尾，也不能太长
  const ok = (title) => {
    const x = String(title || '').trim();
    if (!x || x.length > 40) return false;
    // 标题里一般不带句读标点；带逗号句号的十有八九是被误当成标题的正文
    if (/[，。；：,;]/.test(x)) return false;
    if (!/[\u4e00-\u9fa5A-Za-z]/.test(x)) return false;
    if (/[、]$/.test(x)) return false;
    if (/^(本|该|如|若|经|按照|根据|供应|采购人|甲方|乙方)/.test(x) && x.length > 14) return false;
    return true;
  };
  // 第X章 / 第X部分 / 一、 / 1. / 1.2.3 形式
  let m = /^(第[一二三四五六七八九十百]+[章节部分篇])\s*(.*)$/.exec(s);
  if (m) { const title = (m[2] || '').trim() || s; return ok(title) ? { level: 1, number: m[1], title } : null; }
  m = /^([一二三四五六七八九十]+)[、.．]\s*(.*)$/.exec(s);
  if (m) { const title = (m[2] || '').trim() || s; return ok(title) ? { level: 1, number: m[1], title } : null; }
  m = /^(\d+(?:\.\d+){0,3})[、.．]?\s+(.{2,60})$/.exec(s);
  if (m) {
    const title = m[2].trim();
    if (!ok(title)) return null;
    const dots = (m[1].match(/\./g) || []).length;
    return { level: Math.min(dots + 1, 3), number: m[1], title };
  }
  return null;
}

// 从整段文字里按标题行切章节
export function splitTextByHeading(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  let cur = null;
  const push = () => {
    if (cur) {
      cur.body = cur.buf.join('\n').trim();
      delete cur.buf;
      if (cur.body.length > 20 || cur.title) out.push(cur);
    }
  };
  lines.forEach((ln) => {
    const h = headingOf(ln);
    if (h) {
      push();
      cur = { title: h.title, level: h.level, number: h.number || '', buf: [] };
      return;
    }
    if (cur) cur.buf.push(ln);
  });
  push();
  return out;
}

// 去掉目录行（「第一章 xxx ...... 3」这种）和孤立页码，否则 PDF 会被切成几百段
function stripTocLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter((ln) => {
      const s = ln.trim();
      if (!s) return true;
      if (/^.{2,80}(\.{2,}|…{1,}|·{2,}|-{3,}|_{3,})\s*\d+\s*$/.test(s)) return false; // 目录条目
      if (/^(第[一二三四五六七八九十百]+[章节部分篇]|[一二三四五六七八九十]+、|\d+(\.\d+)*)\s*\S.{0,50}\s{2,}\d{1,4}$/.test(s)) return false; // 目录：标题 + 空格 + 页码
      if (/^[-—\s]*\d{1,4}[-—\s]*$/.test(s)) return false;                 // 只有页码
      if (/^\d{1,4}\s*\/\s*\d{1,4}$/.test(s)) return false;                  // 页脚「3 / 52」
      if (/^第\s*\d+\s*页\s*(共\s*\d+\s*页)?$/.test(s)) return false;        // 页脚「第 3 页」
      return true;
    })
    .join('\n');
}

// 章节太碎时合并：先合并空壳小节，再合并最短的相邻段，直到段数不超过 maxChunks
export function tidyChunks(chunks, opt = {}) {
  const maxChunks = opt.maxChunks || 60;
  const minBody = opt.minBody || 120;
  let list = (chunks || []).filter((c) => c && (String(c.body || '').trim() || String(c.title || '').trim()))
    .map((c) => ({
      title: (() => {
        let s = String(c.title || '').replace(/\s*(\.{3,}|…{2,}).*$/, '').replace(/\s+\d{1,4}$/, '').trim();
        // PDF 抽出来的标题常是一整句（中间还有字间空格），太长就截断，避免章节名变成一段话
        s = s.replace(/\s{2,}/g, ' ').trim();
        if (s.length > 34) s = s.slice(0, 34) + '…';
        return s || '未命名';
      })(),
      level: c.level || 1,
      number: c.number || '',
      body: String(c.body || '').trim()
    }))
    .filter((c) => !(c.body.length < 8 && c.title.length < 4));
  // 第一轮：空壳小节并到上一节
  const pass1 = [];
  list.forEach((c) => {
    const prev = pass1[pass1.length - 1];
    if (c.body.length < minBody && prev) {
      prev.body = (prev.body + '\n' + c.title + '\n' + c.body).trim();
      return;
    }
    pass1.push(c);
  });
  list = pass1;
  // 第一段如果是空壳（比如封面标题下没有正文），并到下一段，别留一个 0 字的章节
  while (list.length > 1 && String(list[0].body || '').trim().length < minBody) {
    const first = list.shift();
    list[0].body = (String(first.title || '') + '\n' + String(first.body || '') + '\n' + String(list[0].body || '')).trim();
    break;
  }
  // 第二轮：段数还是太多，就从最短的段开始并到相邻段
  while (list.length > maxChunks) {
    let idx = 0; let best = Infinity;
    for (let i = 1; i < list.length; i++) {
      const n = list[i].body.length;
      if (n < best) { best = n; idx = i; }
    }
    const cur = list[idx];
    const target = list[idx - 1] || list[idx + 1];
    if (!target) break;
    const keep = list[idx - 1] ? idx - 1 : idx + 1;
    list[keep].body = (list[keep].body + '\n' + cur.title + '\n' + cur.body).trim();
    list.splice(idx, 1);
  }
  return list;
}

// 读一份投标文件，返回 [{title, level, number, body}]
// 支持 .docx / .doc / .pdf（PDF 走 ensureText，扫描件由调用方先 OCR）
export async function outlineOfBidFile(fileRow, absPath) {
  const ext = path.extname(fileRow.originalName || absPath).toLowerCase();
  if (ext !== '.docx' && ext !== '.doc' && ext !== '.pdf') {
    const err = new Error('目前只能读 PDF 或 Word 格式的投标文件（.pdf / .docx / .doc），这份是 ' + (ext || '未知格式'));
    err.code = 'BAD_FORMAT';
    throw err;
  }
  let pages = [];
  if (ext === '.pdf') {
    const cache = await ensureText(fileRow, absPath);
    pages = (cache.pages || []).slice();
    if (cache.scanned || !pages.some((p) => p.text && p.text.trim().length > 20)) {
      const nums = pages.length ? pages.map((p) => p.page) : [1];
      const r = await ocrPages(fileRow, absPath, nums);
      pages = (r.cache && r.cache.pages) || pages;
    }
  } else {
    const buf = fs.readFileSync(absPath);
    let text = '';
    if (ext === '.doc') {
      const tmpIn = path.join(TEXT_DIR, fileRow.id + '.in.doc');
      const tmpOut = path.join(TEXT_DIR, fileRow.id + '.out.docx');
      fs.writeFileSync(tmpIn, buf);
      try { docToDocx(tmpIn, tmpOut); text = await extractDocxText(fs.readFileSync(tmpOut)); }
      finally { try { fs.unlinkSync(tmpIn); } catch {} try { fs.unlinkSync(tmpOut); } catch {} }
    } else {
      text = await extractDocxText(buf);
    }
    pages = [{ page: 1, text }];
  }

  const full = stripTocLines(pages.map((p) => String(p.text || '')).join('\n'));
  let chunks = splitTextByHeading(full);
  if (chunks.length < 2) {
    // 切不出章节（整份是一段流水文字）：按页切，标题用「第 N 页」
    chunks = pages
      .filter((p) => String(p.text || '').trim())
      .map((p) => {
        const t0 = String(p.text).trim();
        const first = t0.split(/\r?\n/)[0] || '';
        return { title: '第 ' + p.page + ' 页 ' + (first.length > 2 && first.length <= 30 ? first : ''), level: 1, number: String(p.page), body: t0 };
      });
  }
  return tidyChunks(chunks, { maxChunks: 60 });
}
