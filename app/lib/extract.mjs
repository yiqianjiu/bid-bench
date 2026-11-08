import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const POWERSHELL = 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const WINRAR = 'C:\\Program Files\\WinRAR\\WinRAR.exe';

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

// ---------- DOC (legacy) via Word COM ----------
export function docToDocx(docPath, outPath) {
  const ps = [
    '$ErrorActionPreference = "Stop"',
    '$w = New-Object -ComObject Word.Application',
    '$w.Visible = $false',
    '$w.DisplayAlerts = 0',
    '$d = $w.Documents.Open("' + docPath.replace(/"/g, '""') + '", $false, $true)',
    '$d.SaveAs2("' + outPath.replace(/"/g, '""') + '", 16)',
    '$d.Close(0)',
    '$w.Quit()',
    'Write-Output "OK"'
  ].join('\r\n');
  const psFile = path.join(os.tmpdir(), 'twb_conv_' + Date.now() + '.ps1');
  fs.writeFileSync(psFile, ps, 'utf8');
  try {
    execFileSync(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile], { timeout: 180000 });
  } finally {
    try { fs.unlinkSync(psFile); } catch {}
  }
  return fs.readFileSync(outPath);
}

// docx -> pdf（Word COM 无头导出，用于核查页码与空白页）
export function docxToPdf(docxPath, pdfPath) {
  const ps = [
    '$ErrorActionPreference = "Stop"',
    '$w = New-Object -ComObject Word.Application',
    '$w.Visible = $false',
    '$w.DisplayAlerts = 0',
    '$d = $w.Documents.Open("' + docxPath.replace(/"/g, '""') + '", $false, $true)',
    'try { $d.Fields.Update() } catch {}',
    'try { foreach ($t in $d.TablesOfContents) { $t.Update() } } catch {}',
    '$d.ExportAsFixedFormat("' + pdfPath.replace(/"/g, '""') + '", 17)',
    '$d.Close(0)',
    '$w.Quit()',
    'Write-Output "OK"'
  ].join('\r\n');
  const psFile = path.join(os.tmpdir(), 'twb_topdf_' + Date.now() + '.ps1');
  // PowerShell 5.1 必须带 BOM 才会按 UTF-8 读脚本，否则中文路径变乱码
  fs.writeFileSync(psFile, '\ufeff' + ps, 'utf8');
  try {
    execFileSync(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile], { timeout: 240000 });
  } finally {
    try { fs.unlinkSync(psFile); } catch {}
  }
  if (!fs.existsSync(pdfPath)) throw new Error('Word 没能导出 PDF');
  return fs.readFileSync(pdfPath);
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
