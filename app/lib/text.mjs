import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';
import { extractPdfText, extractDocxText, docToDocx, renderPdfPages, pdfPageCount } from './extract.mjs';
import { callVisionJson, callText } from './ai.mjs';
import { SYSTEM_OCR } from './prompt.mjs';

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

// 对扫描页做视觉识别，结果合并进缓存
export async function ocrPages(fileRow, absPath, pageNumbers) {
  const cache = readTextCache(fileRow.id) || (await ensureText(fileRow, absPath));
  const buf = fs.readFileSync(absPath);
  const images = await renderPdfPages(buf, pageNumbers, 2);
  const results = [];
  for (const [pageNo, img] of images) {
    try {
      const r = await callVisionJson(
        SYSTEM_OCR,
        '这是招标文件第 ' + pageNo + ' 页的图片。请把这一页上的全部文字逐行转写出来，保持原有顺序与层级；表格请按「行1列1 | 行1列2」的格式逐行输出；如果页面是空白页，返回 {"text":"","blank":true}。',
        [img]
      );
      const text = String(r.text || '').trim();
      const idx = cache.pages.findIndex((p) => p.page === pageNo);
      const entry = { page: pageNo, text, source: 'vision' };
      if (idx >= 0) cache.pages[idx] = entry; else cache.pages.push(entry);
      if (!cache.visionPages.includes(pageNo)) cache.visionPages.push(pageNo);
      results.push({ page: pageNo, chars: text.length });
    } catch (e) {
      results.push({ page: pageNo, error: String(e && e.message || e) });
    }
  }
  cache.pages.sort((a, b) => a.page - b.page);
  cache.chars = cache.pages.reduce((n, p) => n + (p.text ? p.text.length : 0), 0);
  cache.emptyPages = cache.pages.filter((p) => !p.text || !p.text.trim()).map((p) => p.page);
  cache.scanned = cache.pages.length > 0 && cache.emptyPages.length === cache.pages.length;
  writeTextCache(fileRow.id, cache);
  return { cache, results };
}
