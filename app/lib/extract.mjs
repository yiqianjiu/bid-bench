import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const POWERSHELL = 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const WINRAR = 'C:\\Program Files\\WinRAR\\WinRAR.exe';

// v1.2.1：把 Word COM 的英文报错翻成用户看得懂的话
function wordHint(e) {
  const s = String((e && (e.stderr || e.message)) || e || '');
  if (/800401F3|Invalid class string|ProgID|0x80080005/i.test(s)) {
    return '这台电脑没有装 Microsoft Word（或 Word 打不开），读不了 .doc。请用 Word 打开这个文件，另存为 .docx 再上传。';
  }
  if (/找不到您的文件|cannot be found|isn't found|无法打开/i.test(s)) {
    return 'Word 打不开这个 .doc 文件（可能已损坏，或路径里有特殊字符）。请用 Word 打开后另存为 .docx 再上传。';
  }
  const first = s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0] || '未知错误';
  return '转换 .doc 失败：' + first.slice(0, 200);
}

export function hasWinRar() {
  try { return fs.existsSync(WINRAR); } catch { return false; }
}

// ---------- PDF ----------
// pdfjs 6.x：getDocument() 返回 loadingTask，只有 task 上有 destroy()，PDFDocumentProxy 没有
async function safeDestroy(task, doc) {
  try { if (task && typeof task.destroy === 'function') await task.destroy(); } catch {}
  try { if (doc && typeof doc.destroy === 'function') await doc.destroy(); } catch {}
}

export async function extractPdfText(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, isEvalSupported: false });
  let doc = null;
  try {
    doc = await task.promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      const text = tc.items.map((it) => (it.str || '') + (it.hasEOL ? '\n' : '')).join('').trim();
      pages.push({ page: i, text });
    }
    return pages;
  } finally {
    await safeDestroy(task, doc);
  }
}

export async function pdfPageCount(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, isEvalSupported: false });
  let doc = null;
  try {
    doc = await task.promise;
    return doc.numPages;
  } finally {
    await safeDestroy(task, doc);
  }
}

export async function renderPdfPages(buf, pageNumbers, scale = 2) {
  const tmp = path.join(os.tmpdir(), 'twb_pdf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) + '.pdf');
  fs.writeFileSync(tmp, buf);
  const want = new Set(pageNumbers.filter((n) => n >= 1));
  const out = new Map();
  const maxPage = want.size ? Math.max(...want) : Infinity;
  try {
    const { pdf } = await import('pdf-to-img');
    const doc = await pdf(tmp, { scale });
    let n = 0;
    for await (const img of doc) {
      n++;
      if (want.has(n)) out.set(n, Buffer.from(img));
      if (want.size && n >= maxPage) break;
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
  return out;
}

// ---------- DOCX ----------
export async function extractDocxText(buf) {
  const mammoth = await import('mammoth');
  const res = await mammoth.extractRawText({ buffer: buf });
  return res.value || '';
}

// ---------- DOC (legacy) / DOCX -> PDF ----------
// v1.2.3：真正的转换逻辑搬到 convert.mjs 了（子进程 + 异步，不再冻住服务）。
// 这里保留同名导出，调用方加上 await 即可，其它不用改。
export function docToDocx(docPath, outPath, opts) {
  return import('./convert.mjs').then((m) => m.docToDocxAsync(docPath, outPath, opts));
}

export function docxToPdf(docxPath, pdfPath, opts) {
  return import('./convert.mjs').then((m) => m.docxToPdfAsync(docxPath, pdfPath, opts));
}

// 每页的图片数量（用于区分「真空白页」与「整页扫描/截图」）
export async function getPageInfo(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, isEvalSupported: false });
  const doc = await task.promise;
  const out = [];
  const OPS = pdfjs.OPS;
  const imgOps = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintJpegXObject, OPS.paintImageXObjectRepeat].filter((x) => x !== undefined));
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      let images = 0;
      try {
        const ops = await page.getOperatorList();
        for (const fn of ops.fnArray) if (imgOps.has(fn)) images++;
      } catch { images = 0; }
      out.push({ page: i, images });
      try { page.cleanup(); } catch {}
    }
  } finally {
    await safeDestroy(task, doc);
  }
  return out;
}

// v1.1.3：带坐标的 PDF 文字（用于把建议配图对齐到正文对应段落的右侧）
export async function getPdfTextPos(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true, isEvalSupported: false });
  let doc = null;
  try {
    doc = await task.promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const items = [];
      for (const it of tc.items) {
        const str = String(it.str || '');
        if (!str.trim()) continue;
        const tr = it.transform || [1, 0, 0, 1, 0, 0];
        items.push({ str, x: tr[4], y: tr[5] });
      }
      pages.push({ page: i, width: vp.width, height: vp.height, items });
      try { page.cleanup(); } catch {}
    }
    return pages;
  } finally {
    await safeDestroy(task, doc);
  }
}

// ---------- 压缩包 ----------
export function extractArchive(archivePath, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  if (hasWinRar()) {
    execFileSync(WINRAR, ['x', '-y', '-ibck', archivePath, outDir + '\\'], { timeout: 180000 });
    return;
  }
  // 没有 WinRAR 时只支持 zip
  const ps = 'Expand-Archive -LiteralPath "' + archivePath + '" -DestinationPath "' + outDir + '" -Force';
  const psFile = path.join(os.tmpdir(), 'twb_unzip_' + Date.now() + '.ps1');
  fs.writeFileSync(psFile, ps, 'utf8');
  try {
    execFileSync(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile], { timeout: 180000 });
  } finally {
    try { fs.unlinkSync(psFile); } catch {}
  }
}

export function listFilesRecursive(dir, max = 300) {
  const out = [];
  const walk = (d, depth) => {
    if (out.length >= max || depth > 6) return;
    let names = [];
    try { names = fs.readdirSync(d); } catch { return; }
    for (const name of names) {
      const p = path.join(d, name);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p, depth + 1);
      else out.push({ path: p, name, size: st.size });
      if (out.length >= max) return;
    }
  };
  walk(dir, 0);
  return out;
}
