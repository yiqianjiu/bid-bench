import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, ensureDirs, WEB_DIR, DATA_DIR, UPLOAD_DIR, PROJECT_DIR, ARCHIVE_DIR, ROOT, saveConfig } from './lib/config.mjs';
import { openDb, all, get, run, addEvent } from './lib/db.mjs';
import { uid, sha256, nowIso, safeName, shortName } from './lib/util.mjs';
import { extractArchive, listFilesRecursive, renderPdfPages, docToDocx, extractDocxText } from './lib/extract.mjs';
import { ensureText, readTextCache, ocrPages, buildFullText, ensureTextDirs, outlineOfBidFile as outlineOfPdfFile, splitTextByHeading } from './lib/text.mjs';
import { callJson, apiReady } from './lib/ai.mjs';
import { SYSTEM_META, metaUserPrompt, SECTIONS } from './lib/prompt.mjs';
import { startAnalysis, getTask, loadAnalysis, saveAnalysis, runningTaskOf, ensureAnalysisDirs, listActiveTasks } from './lib/analyze.mjs';
import { exportAnalysisDocx } from './lib/exportAnalysis.mjs';
import { ensureDraft, saveDraft, loadDraft, setMode, makeDoc, refreshTables, startOutlineTask, startChapterTask, getDraftTask, listDraftTasks, DOC_META, ensureDraftDirs, applyUploadedOutline, restoreAutoOutline, reviewRoles, setChapterRole } from './lib/draft.mjs';
import { generateProfile, getProfile, confirmProfile, loadProfiles, profileHeadline, blankProfile, PROFILE_KINDS, KIND_LABEL } from './lib/profile.mjs';
import { listKnowledge, getKnowledge, removeKnowledge, buildReferenceBlock, findSimilar, syncCardCount } from './lib/knowledge.mjs';
// v1.2.0：知识卡（把章节里的重要内容提炼成可复用的卡片）
import { startCardTask, getCardTask, listCardTasks, listCards, updateCard, addCard, deleteCard, readCards, saveCards, CARD_TYPES, TYPE_NAME } from './lib/cards.mjs';
import { parseDocxOutline } from './lib/docxOutline.mjs';
import { exportDraftDocx } from './lib/exportDraft.mjs';
import { loadCheck, saveCheck, listSources, startCheckTask, getCheckTask, ensureCheckDirs, listCheckTasks } from './lib/check.mjs';
import { exportCheckDocx } from './lib/exportCheck.mjs';
import { GROUPS, ensureSubmit, rebuildSubmit, saveSubmit, loadSubmit, ensureSubmitDirs } from './lib/submit.mjs';
import { exportSubmitDocx } from './lib/exportSubmit.mjs';
import { archiveProject, listArchives, rebuildKnowledgeFor, archiveRelDirOf } from './lib/archive.mjs';
import { ensureProcDirs, appendProcess, loadProcess, copyProcessTo, pruneData } from './lib/process.mjs';
import { ensureIndepDirs, ensureSession, loadSession, saveSession, listSessions, generateDraft, chatWithAI, applyUpdate, exportDraftWord, writeBack, defaultOutDir, redoChart, reworkChart, envCheck, clientSession, redoAllCharts, renderPreview, loadPreview, previewPageFile, chartDocx } from './lib/indep.mjs';
import { browserStatus } from './lib/chart.mjs';
import { detectOcr, installTesseract, resetOcrCache } from './lib/ocr.mjs';

const cfg = loadConfig();
ensureDirs();
ensureTextDirs();
const db = openDb(path.join(DATA_DIR, 'workbench.db'));
ensureAnalysisDirs();
ensureDraftDirs();
ensureCheckDirs();
ensureSubmitDirs();
ensureProcDirs();
ensureIndepDirs();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword', '.zip': 'application/zip'
};

const STAGE_MAP = { tender: '01招标文件', analysis: '02分析', draft: '03制作', check: '04核查', submit: '05递交' };

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req, limitMB = 200) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limitMB * 1024 * 1024) { reject(new Error('文件超过 ' + limitMB + 'MB 上限')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req, 4);
  const s = buf.toString('utf8').trim();
  if (!s) return {};
  return JSON.parse(s);
}

function projectDirOf(p) { return path.join(PROJECT_DIR, p.dir); }
function fileAbs(f) { return path.join(ROOT, f.relPath); }

function listProjects(includeArchived) {
  const rows = all(db, 'SELECT * FROM projects ORDER BY createdAt DESC');
  return rows
    .filter((r) => includeArchived || r.status !== 'archived')
    .map((r) => {
      const files = all(db, 'SELECT id FROM files WHERE projectId = ?', r.id);
      return { ...r, fileCount: files.length };
    });
}

function projectDetail(id) {
  const p = get(db, 'SELECT * FROM projects WHERE id = ?', id);
  if (!p) return null;
  const files = all(db, 'SELECT * FROM files WHERE projectId = ? ORDER BY uploadedAt ASC', id);
  const events = all(db, 'SELECT * FROM events WHERE projectId = ? ORDER BY createdAt DESC LIMIT 60', id);
  const analysis = readAnalysis(id);
  return { ...p, files, events, hasAnalysis: !!analysis };
}

function readAnalysis(id) {
  const f = path.join(DATA_DIR, '分析', id + '.json');
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

const routes = [];
function route(method, pattern, handler) {
  const keys = [];
  const rx = new RegExp('^' + pattern.replace(/:([A-Za-z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, rx, keys, handler });
}

// ---------- 基础 ----------
route('GET', '/api/health', async (req, res) => {
  json(res, 200, { ok: true, version: cfg.version, root: ROOT, hasKey: apiReady(), company: cfg.company || '' });
});

route('GET', '/api/settings', async (req, res) => {
  json(res, 200, {
    port: cfg.port, deepseekBaseUrl: cfg.deepseekBaseUrl, deepseekModel: cfg.deepseekModel,
    deepseekApiKeyMasked: cfg.deepseekApiKey ? cfg.deepseekApiKey.slice(0, 6) + '****' + cfg.deepseekApiKey.slice(-4) : '',
    hasKey: !!cfg.deepseekApiKey, company: cfg.company || '',
    autoExitOnClose: cfg.autoExitOnClose !== false, version: cfg.version || ''
  });
});

route('POST', '/api/settings', async (req, res) => {
  const body = await readJson(req);
  const patch = {};
  if (typeof body.deepseekApiKey === 'string' && body.deepseekApiKey.trim() && !body.deepseekApiKey.includes('****')) patch.deepseekApiKey = body.deepseekApiKey.trim();
  if (typeof body.company === 'string') patch.company = body.company.trim();
  if (typeof body.autoExitOnClose === 'boolean') patch.autoExitOnClose = body.autoExitOnClose;
  if (typeof body.deepseekModel === 'string' && body.deepseekModel.trim()) patch.deepseekModel = body.deepseekModel.trim();
  const saved = saveConfig(patch);
  Object.assign(cfg, saved);
  json(res, 200, { ok: true });
});

// ---------- 项目 ----------
route('GET', '/api/projects', async (req, res, ctx) => {
  json(res, 200, { projects: listProjects(ctx.query.archived === '1') });
});

route('POST', '/api/projects', async (req, res) => {
  const body = await readJson(req);
  const id = uid('p_');
  const year = new Date().getFullYear();
  const seq = String(all(db, 'SELECT id FROM projects').length + 1).padStart(3, '0');
  const autoCode = 'TWB-' + year + '-' + seq;
  const tenderCode = String(body.code || '').trim();
  const name = String(body.name || '').trim() || '未命名项目';
  const dir = safeName(tenderCode ? tenderCode + '_' + shortName(name) : autoCode + '_' + shortName(name), id);
  const now = nowIso();
  const isBackfill = body.isBackfill ? '1' : '';
  run(db, 'INSERT INTO projects (id, code, autoCode, name, owner, agency, budget, bidDeadline, openTime, openPlace, deposit, purchaseMethod, packageNo, company, notes, status, dir, createdAt, updatedAt, isBackfill) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    id, tenderCode, autoCode, name, body.owner || '', body.agency || '', body.budget || '', body.bidDeadline || '', body.openTime || '',
    body.openPlace || '', body.deposit || '', body.purchaseMethod || '', body.packageNo || '', body.company || '',
    body.notes || '', 'active', dir, now, now, isBackfill);
  fs.mkdirSync(path.join(PROJECT_DIR, dir), { recursive: true });
  for (const sub of Object.values(STAGE_MAP)) fs.mkdirSync(path.join(PROJECT_DIR, dir, sub), { recursive: true });
  addEvent(db, id, 'create', '新建项目 ' + name + (isBackfill ? '（补录项目）' : ''));
  appendProcess(id, { kind: 'create', title: '新建项目' + (isBackfill ? '（补录）' : ''), detail: name + (tenderCode ? ' / 编号 ' + tenderCode : '') });
  json(res, 200, { ok: true, id, autoCode, dir });
});

route('GET', '/api/projects/:id', async (req, res, ctx) => {
  const p = projectDetail(ctx.params.id);
  if (!p) return json(res, 404, { error: '项目不存在' });
  json(res, 200, p);
});

const EDITABLE = ['code', 'name', 'owner', 'agency', 'budget', 'bidDeadline', 'openTime', 'openPlace', 'deposit', 'purchaseMethod', 'packageNo', 'company', 'notes', 'isBackfill'];

route('POST', '/api/projects/:id', async (req, res, ctx) => {
  const body = await readJson(req);
  const p = get(db, 'SELECT * FROM projects WHERE id = ?', ctx.params.id);
  if (!p) return json(res, 404, { error: '项目不存在' });
  const sets = [];
  const vals = [];
  for (const k of EDITABLE) {
    if (body[k] !== undefined) { sets.push(k + ' = ?'); vals.push(String(body[k])); }
  }
  if (!sets.length) return json(res, 200, { ok: true });
  sets.push('updatedAt = ?');
  vals.push(nowIso(), ctx.params.id);
  run(db, 'UPDATE projects SET ' + sets.join(', ') + ' WHERE id = ?', ...vals);
  addEvent(db, ctx.params.id, 'edit', '修改项目信息');
  json(res, 200, { ok: true });
});

// 把一个项目彻底删干净（磁盘 + 知识库 + 数据库），删除项目与补录失败清理共用
function deleteProjectFully(p) {
  const removed = [];
  // 1) 归档文件夹（已归档的项目才有；位置记在 archiveNote 里，格式「备注||年份\编号_项目名」）
  const rel = archiveRelDirOf(p);
  if (rel) {
    const dst = path.resolve(ARCHIVE_DIR, rel);
    if (dst.startsWith(path.resolve(ARCHIVE_DIR)) && fs.existsSync(dst)) {
      fs.rmSync(dst, { recursive: true, force: true });
      removed.push(dst);
    }
  }
  // 2) 项目工作目录
  const dir = projectDirOf(p);
  if (dir.startsWith(PROJECT_DIR) && fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  // 3) 独立编制草稿、过程记录、分析与制作缓存
  const extras = [
    path.join(DATA_DIR, '独立编制', p.id),
    path.join(DATA_DIR, '过程', p.id + '.json'),
    path.join(DATA_DIR, '分析', p.id + '.json'),
    path.join(DATA_DIR, '制作', p.id + '.json')
  ];
  for (const f of extras) {
    if (!fs.existsSync(f)) continue;
    if (!f.startsWith(path.resolve(DATA_DIR))) continue;
    fs.rmSync(f, { recursive: true, force: true });
    removed.push(f);
  }
  // 4) 专家知识库里这个项目的经验记录
  try { removeKnowledge(p.id); } catch {}
  // 5) 数据库三张表
  run(db, 'DELETE FROM files WHERE projectId = ?', p.id);
  run(db, 'DELETE FROM events WHERE projectId = ?', p.id);
  run(db, 'DELETE FROM projects WHERE id = ?', p.id);
  return removed;
}

// v1.1.3：删除项目 —— 在办项目和已归档项目都能删，归档的连归档文件夹一起删干净
route('DELETE', '/api/projects/:id', async (req, res, ctx) => {
  const p = get(db, 'SELECT * FROM projects WHERE id = ?', ctx.params.id);
  if (!p) return json(res, 404, { error: '项目不存在' });
  try {
    const removed = deleteProjectFully(p);
    json(res, 200, { ok: true, removed });
  } catch (e) {
    json(res, 500, { error: '删除失败：' + String(e && e.message || e) });
  }
});

// ---------- 文件 ----------
const TEXT_EXT = ['.pdf', '.docx', '.doc'];

route('POST', '/api/projects/:id/files', async (req, res, ctx) => {
  const p = get(db, 'SELECT * FROM projects WHERE id = ?', ctx.params.id);
  if (!p) return json(res, 404, { error: '项目不存在' });
  if (p.status === 'archived') return json(res, 403, { error: '这个项目已经关闭归档了，只能查看。要修改请先点「重新打开」。', code: 'ARCHIVED_READONLY' });
  const stage = ctx.query.stage || 'tender';
  const role = ctx.query.role || 'tenderFile';
  const body = await readBody(req);
  const ctype = req.headers['content-type'] || '';
  const bMatch = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ctype);
  if (!bMatch) return json(res, 400, { error: '请用表单方式上传文件' });
  const boundary = bMatch[1] || bMatch[2];
  try {
    const parts = parseMultipart(body, boundary);
    const saved = [];
    const stageDir = STAGE_MAP[stage] || '01招标文件';
    const target = path.join(projectDirOf(p), stageDir);
    fs.mkdirSync(target, { recursive: true });
    for (const part of parts) {
      if (!part.filename) continue;
      const id = uid('f_');
      const origName = decodeFileName(part.filename);
      const buf = part.data;
      const ext = path.extname(origName).toLowerCase();
      const stored = id + '_' + safeName(origName, 'file' + ext);
      fs.writeFileSync(path.join(target, stored), buf);
      const rel = path.posix.join('项目', p.dir, stageDir, stored);
      insertFile(p.id, id, stage, role, origName, stored, rel, buf.length, sha256(buf));
      saved.push({ id, name: origName, size: buf.length, relPath: rel });
      addEvent(db, p.id, 'upload', '上传文件 ' + origName);
  appendProcess(p.id, { kind: 'upload', title: '上传文件：' + origName, detail: (stage === 'tender' ? '招标文件' : '其他资料') + '，' + fmtSizeSoft(buf.length) });

      // 压缩包：解压后把里面的文档一并登记
      if (ext === '.zip' || ext === '.rar' || ext === '.7z') {
        const outDir = path.join(target, '解压_' + id);
        try {
          extractArchive(path.join(target, stored), outDir);
          for (const item of listFilesRecursive(outDir)) {
            const iext = path.extname(item.name).toLowerCase();
            if (!TEXT_EXT.includes(iext)) continue;
            const iid = uid('f_');
            const irel = path.posix.join('项目', p.dir, stageDir, '解压_' + id, path.relative(outDir, item.path).split(path.sep).join('/'));
            insertFile(p.id, iid, stage, 'fromArchive', item.name, path.basename(item.path), irel, item.size, '');
            saved.push({ id: iid, name: item.name, size: item.size, relPath: irel, fromArchive: true });
          }
        } catch (e) {
          saved.push({ name: origName, error: '解压失败：' + String(e && e.message || e) });
        }
      }
    }
    json(res, 200, { ok: true, files: saved });
  } catch (e) {
    json(res, 500, { error: String(e && e.message || e) });
  }
});

// 浏览器/命令行上传的中文文件名都是 UTF-8 字节被按 latin1 读出，这里还原
function decodeFileName(raw) {
  if (!raw) return 'file';
  try {
    const decoded = Buffer.from(raw, 'latin1').toString('utf8');
    if (!decoded.includes('\uFFFD')) return decoded;
  } catch {}
  return raw;
}

function insertFile(projectId, id, stage, role, origName, stored, rel, size, hash) {
  run(db, 'INSERT INTO files (id, projectId, stage, role, originalName, storedName, relPath, size, sha256, pages, textChars, extracted, uploadedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    id, projectId, stage, role, origName, stored, rel, size, hash, 0, 0, 0, nowIso());
}

function parseMultipart(buf, boundary) {
  const parts = [];
  const delim = Buffer.from('--' + boundary);
  let idx = buf.indexOf(delim);
  while (idx !== -1) {
    const start = idx + delim.length;
    const next = buf.indexOf(delim, start);
    if (next === -1) break;
    let segStart = start;
    if (buf[segStart] === 13 && buf[segStart + 1] === 10) segStart += 2;
    const seg = buf.subarray(segStart, next - 2 > segStart ? next - 2 : next);
    const headEnd = seg.indexOf('\r\n\r\n');
    if (headEnd !== -1) {
      const head = seg.subarray(0, headEnd).toString('latin1');
      const data = seg.subarray(headEnd + 4);
      const m = /filename="([^"]*)"/.exec(head);
      const nm = /name="([^"]*)"/.exec(head);
      parts.push({ filename: m ? m[1] : '', field: nm ? nm[1] : '', data });
    }
    idx = next;
  }
  return parts;
}

route('GET', '/api/files/:id/raw', async (req, res, ctx) => {
  const f = get(db, 'SELECT * FROM files WHERE id = ?', ctx.params.id);
  if (!f) return json(res, 404, { error: '文件不存在' });
  const file = fileAbs(f);
  if (!fs.existsSync(file)) return json(res, 404, { error: '文件已不在磁盘' });
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Disposition': 'inline; filename="' + encodeURIComponent(f.originalName) + '"' });
  fs.createReadStream(file).pipe(res);
});

route('POST', '/api/files/:id/delete', async (req, res, ctx) => {
  const f = get(db, 'SELECT * FROM files WHERE id = ?', ctx.params.id);
  if (!f) return json(res, 404, { error: '文件不存在' });
  const file = fileAbs(f);
  if (file.startsWith(PROJECT_DIR) && fs.existsSync(file)) { try { fs.rmSync(file, { force: true }); } catch {} }
  run(db, 'DELETE FROM files WHERE id = ?', f.id);
  json(res, 200, { ok: true });
});

// 读取已抽取的文本（按页）
route('GET', '/api/files/:id/text', async (req, res, ctx) => {
  const f = get(db, 'SELECT * FROM files WHERE id = ?', ctx.params.id);
  if (!f) return json(res, 404, { error: '文件不存在' });
  const file = fileAbs(f);
  if (!fs.existsSync(file)) return json(res, 404, { error: '文件已不在磁盘' });
  const cache = await ensureText(f, file);
  run(db, 'UPDATE files SET pages = ?, textChars = ?, extracted = 1 WHERE id = ?', cache.pageCount, cache.chars, f.id);
  json(res, 200, {
    fileId: f.id, kind: cache.kind, pageCount: cache.pageCount, chars: cache.chars,
    scanned: cache.scanned, emptyPages: cache.emptyPages, visionPages: cache.visionPages,
    pages: cache.pages
  });
});

// 页图片（用于核对原文）
route('GET', '/api/files/:id/page/:n', async (req, res, ctx) => {
  const f = get(db, 'SELECT * FROM files WHERE id = ?', ctx.params.id);
  if (!f) return json(res, 404, { error: '文件不存在' });
  const file = fileAbs(f);
  if (!fs.existsSync(file)) return json(res, 404, { error: '文件已不在磁盘' });
  const n = Number(ctx.params.n);
  try {
    const imgs = await renderPdfPages(fs.readFileSync(file), [n], 1.7);
    const img = imgs.get(n);
    if (!img) return json(res, 404, { error: '没有这一页' });
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    res.end(img);
  } catch (e) {
    json(res, 500, { error: '无法渲染这一页：' + String(e && e.message || e) });
  }
});

// 对指定页做视觉识别
route('POST', '/api/files/:id/ocr', async (req, res, ctx) => {
  const f = get(db, 'SELECT * FROM files WHERE id = ?', ctx.params.id);
  if (!f) return json(res, 404, { error: '文件不存在' });
  const file = fileAbs(f);
  if (!fs.existsSync(file)) return json(res, 404, { error: '文件已不在磁盘' });
  if (!apiReady()) return json(res, 400, { error: '需要先填写 DeepSeek API Key' });
  const body = await readJson(req);
  const pages = Array.isArray(body.pages) ? body.pages.map(Number).filter((n) => n > 0).slice(0, 30) : [];
  if (!pages.length) return json(res, 400, { error: '请指定要识别的页码' });
  const r = await ocrPages(f, file, pages);
  json(res, 200, { ok: true, results: r.results, pages: r.cache.pages });
});

// ---------- 文字识别（OCR）能力 ----------
// 需要 AI 读文件时先自动判断：本机有识别工具就用本机的，没有就建议用户装，装完自动可用。
route('GET', '/api/ocr/status', async (req, res) => {
  const d = detectOcr();
  json(res, 200, {
    ok: true,
    available: d.available,
    best: d.best,
    winrt: d.winrt,
    tesseract: d.tesseract,
    winget: d.winget.ok,
    hint: d.available
      ? (d.best === 'winrt' ? '这台电脑自带的文字识别可以用（Windows OCR）。' : '这台电脑装了 Tesseract 文字识别。')
      : (d.winget.ok
        ? '这台电脑还没有文字识别工具，点「安装识别工具」可以自动装一个（大约几十 MB，只需一次）。'
        : '这台电脑还没有文字识别工具，也没法自动安装，需要手动装一个。')
  });
});

route('POST', '/api/ocr/install', async (req, res) => {
  try {
    const r = installTesseract();
    resetOcrCache();
    json(res, 200, Object.assign({ ok: true }, r));
  } catch (e) {
    json(res, 400, { ok: false, error: String(e && e.message || e), code: (e && e.code) || '' });
  }
});

// ---------- AI：识别项目基本信息 ----------
route('POST', '/api/projects/:id/extract-meta', async (req, res, ctx) => {
  const p = get(db, 'SELECT * FROM projects WHERE id = ?', ctx.params.id);
  if (!p) return json(res, 404, { error: '项目不存在' });
  if (!apiReady()) return json(res, 400, { error: '需要先填写 DeepSeek API Key（右上角「设置」）' });
  const body = await readJson(req);
  let f = null;
  if (body.fileId) f = get(db, 'SELECT * FROM files WHERE id = ? AND projectId = ?', body.fileId, p.id);
  if (!f) {
    f = get(db, "SELECT * FROM files WHERE projectId = ? AND stage = 'tender' AND (role = 'tenderFile' OR role = 'fromArchive') ORDER BY (role = 'tenderFile') DESC, uploadedAt ASC LIMIT 1", p.id);
  }
  if (!f) return json(res, 400, { error: '还没有上传招标文件' });
  const file = fileAbs(f);
  if (!fs.existsSync(file)) return json(res, 400, { error: '招标文件已不在磁盘：' + f.originalName });

  const cache = await ensureText(f, file);
  run(db, 'UPDATE files SET pages = ?, textChars = ?, extracted = 1 WHERE id = ?', cache.pageCount, cache.chars, f.id);

  // 扫描件：先让 AI 看图读前几页
  let visionUsed = [];
  let work = cache;
  if (work.scanned || work.chars < 200) {
    const maxPage = Math.min(work.pageCount || 12, 12);
    const pagesToRead = [];
    for (let i = 1; i <= maxPage; i++) pagesToRead.push(i);
    try {
      const r = await ocrPages(f, file, pagesToRead);
      work = r.cache;
      visionUsed = pagesToRead;
    } catch (e) {
      return json(res, 400, { error: '这份文件像是扫描件，识别文字失败：' + String(e && e.message || e) });
    }
  }

  let full = buildFullText(work.pages);
  const LIMIT = 120000;
  if (full.length > LIMIT) full = full.slice(0, LIMIT) + '\n\n（以下内容过长已截断）';

  let meta;
  try {
    meta = await callJson(SYSTEM_META, metaUserPrompt(full), { maxTokens: 4000 });
  } catch (e) {
    return json(res, 400, { error: String(e && e.message || e) });
  }
  addEvent(db, p.id, 'ai', '识别招标文件基本信息（' + f.originalName + '）');
  appendProcess(p.id, { kind: 'ai', title: 'AI 识别招标文件基本信息', detail: f.originalName });
  json(res, 200, {
    ok: true, meta, fileId: f.id, fileName: f.originalName, visionPages: visionUsed,
    stats: { pages: work.pageCount, chars: work.chars }
  });
});

// ---------- AI：招标分析（关键信息清单） ----------
route('POST', '/api/projects/:id/analyze', async (req, res, ctx) => {
  const p = get(db, 'SELECT * FROM projects WHERE id = ?', ctx.params.id);
  if (!p) return json(res, 404, { error: '项目不存在' });
  if (!apiReady()) return json(res, 400, { error: '需要先填写 DeepSeek API Key（左下角「设置」）' });
  const body = await readJson(req);
  const exist = runningTaskOf(p.id);
  if (exist && exist.state === 'running') return json(res, 200, { ok: true, taskId: exist.taskId, resumed: true });
  if (!body.force) {
    const old = loadAnalysis(p.id);
    if (old && old.sections && old.sections.length) {
      return json(res, 200, { ok: true, existing: true, analysisAt: old.analysisAt });
    }
  }
  try {
    const t = startAnalysis(db, p.id, { force: !!body.force, fileId: body.fileId, maxPages: body.maxPages });
    json(res, 200, { ok: true, taskId: t.taskId, task: t });
  } catch (e) {
    json(res, 400, { error: String(e && e.message || e) });
  }
});

route('GET', '/api/tasks/:taskId', async (req, res, ctx) => {
  // v1.1.5：/api/tasks/active 必须在这里先拦一下，否则会被当成任务 ID
  if (ctx.params.taskId === 'active') return json(res, 200, { ok: true, tasks: activeTasksOf(), serverTime: nowIso() });
  const t = getTask(ctx.params.taskId);
  if (!t) return json(res, 404, { error: '任务不存在' });
  json(res, 200, t);
});

route('GET', '/api/projects/:id/analysis', async (req, res, ctx) => {
  const p = get(db, 'SELECT * FROM projects WHERE id = ?', ctx.params.id);
  if (!p) return json(res, 404, { error: '项目不存在' });
  const data = loadAnalysis(p.id);
  const running = runningTaskOf(p.id);
  json(res, 200, {
    sections: data ? data.sections : null,
    stat: data ? data.stat : null,
    starCount: data ? data.starCount : 0,
    fatalCount: data ? data.fatalCount : 0,
    analysisAt: data ? data.analysisAt : null,
    truncated: data ? data.truncated : false,
    pageCount: data ? data.pageCount : 0,
    analyzedPages: data ? data.analyzedPages : 0,
    fileName: data ? data.fileName : '',
    failedSegments: data ? data.failedSegments : [],
    fatalScan: data ? data.fatalScan || null : null,
    registry: SECTIONS,
    running: running && running.state === 'running' ? { taskId: running.taskId, message: running.message, step: running.step, total: running.total } : null
  });
});

// 单条增 / 改 / 删 / 勾选确认
route('PUT', '/api/projects/:id/analysis/item', async (req, res, ctx) => {
  const p = get(db, 'SELECT * FROM projects WHERE id = ?', ctx.params.id);
  if (!p) return json(res, 404, { error: '项目不存在' });
  const data = loadAnalysis(p.id);
  if (!data) return json(res, 400, { error: '还没有分析结果，请先点「开始分析」' });
  const body = await readJson(req);
  const sec = data.sections.find((s) => s.key === body.section);
  if (!sec) return json(res, 400, { error: '板块不存在：' + body.section });

  const op = body.op || 'upsert';
  if (op === 'delete') {
    const i = sec.items.findIndex((x) => x.id === (body.item && body.item.id));
    if (i >= 0) sec.items.splice(i, 1);
  } else if (op === 'confirm') {
    const id = body.item && body.item.id;
    const v = !!(body.item && body.item.confirmed);
    if (id) { const it = sec.items.find((x) => x.id === id); if (it) it.confirmed = v; }
    else sec.items.forEach((x) => { x.confirmed = v; });
  } else {
    const item = body.item || {};
    if (item.id) {
      const it = sec.items.find((x) => x.id === item.id);
      if (!it) return json(res, 400, { error: '这一条已不存在，请刷新页面' });
      if (item.text !== undefined) it.text = String(item.text);
      if (item.cells !== undefined && Array.isArray(item.cells)) it.cells = item.cells.map((c) => String(c == null ? '' : c));
      if (item.page !== undefined) { it.page = item.page === null || item.page === '' ? null : Number(item.page); it.pageCheck = ''; }
      if (item.isStar !== undefined) it.isStar = !!item.isStar;
      if (item.isFatal !== undefined) it.isFatal = !!item.isFatal;
      if (item.quote !== undefined) it.quote = String(item.quote).slice(0, 400);
      it.edited = true;
    } else {
      const cells = Array.isArray(item.cells) ? item.cells.map((c) => String(c == null ? '' : c)) : null;
      sec.items.push({
        id: uid('a_'),
        text: cells ? (cells[cells.length - 1] || '') : String(item.text || ''),
        cells,
        page: item.page ? Number(item.page) : null,
        quote: String(item.quote || '').slice(0, 400),
        isStar: !!item.isStar,
        isFatal: !!item.isFatal,
        category: '',
        confirmed: false,
        edited: true,
        pageCheck: '',
        source: 'manual'
      });
    }
  }

  sec.items.sort((x, y) => (x.page || 99999) - (y.page || 99999));
  const stat = {};
  for (const s of data.sections) stat[s.key] = s.items.length;
  data.stat = stat;
  data.starCount = data.sections.reduce((n, s) => n + s.items.filter((i) => i.isStar).length, 0);
  data.fatalCount = data.sections.filter((s) => s.key === 'fatal').reduce((n, s) => n + s.items.length, 0);
  saveAnalysis(p.id, data);
  run(db, 'UPDATE projects SET analysisStat = ?, updatedAt = ? WHERE id = ?',
    JSON.stringify({ stat, starCount: data.starCount, fatalCount: data.fatalCount }), nowIso(), p.id);

  json(res, 200, { ok: true, section: sec, stat, starCount: data.starCount, fatalCount: data.fatalCount });
});

// 导出 Word
route('POST', '/api/projects/:id/analysis/export', async (req, res, ctx) => {
  const p = get(db, 'SELECT * FROM projects WHERE id = ?', ctx.params.id);
  if (!p) return json(res, 404, { error: '项目不存在' });
  const data = loadAnalysis(p.id);
  if (!data) return json(res, 400, { error: '还没有分析结果' });
  try {
    const dir = path.join(PROJECT_DIR, p.dir, '02分析');
    fs.mkdirSync(dir, { recursive: true });
    const d = new Date();
    const stamp = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const outPath = path.join(dir, '关键信息清单_' + stamp + '.docx');
    await exportAnalysisDocx(p, data, outPath);
    const rel = '项目/' + p.dir + '/02分析/关键信息清单_' + stamp + '.docx';
    addEvent(db, p.id, 'export', '导出关键信息清单 Word');
    json(res, 200, { ok: true, relPath: rel, fileName: '关键信息清单_' + stamp + '.docx', absPath: outPath });
  } catch (e) {
    json(res, 500, { error: '导出失败：' + String(e && e.message || e) });
  }
});

// 下载项目内生成的文件（按相对路径）
route('GET', '/api/download', async (req, res, ctx) => {
  const rel = ctx.query.path || '';
  if (!rel || rel.includes('..')) return json(res, 400, { error: '路径不合法' });
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return json(res, 404, { error: '文件不存在' });
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
    'Content-Disposition': 'attachment; filename="' + encodeURIComponent(path.basename(abs)) + '"'
  });
  fs.createReadStream(abs).pipe(res);
});

// ---------- 模块3：投标文件制作 ----------
route('GET', '/api/projects/:id/draft', async (req, res, ctx) => {
  const p = get(db, 'SELECT * FROM projects WHERE id = ?', ctx.params.id);
  if (!p) return json(res, 404, { error: '项目不存在' });
  const d = ensureDraft(p.id);
  const an = loadAnalysis(p.id);
  // v1.1.5：把还在跑的写稿任务一起返回，页面切回来能接着显示进度
  let running = null;
  try { const t = listDraftTasks().find((x) => x.projectId === p.id); if (t) running = { taskId: t.id, message: t.message || '' }; } catch {}
  json(res, 200, { ok: true, draft: d, hasAnalysis: !!an, analysisAt: an ? an.analysisAt : null, apiReady: apiReady(), running });
});

route('POST', '/api/projects/:id/draft/mode', async (req, res, ctx) => {
  const p = get(db, 'SELECT * FROM projects WHERE id = ?', ctx.params.id);
  if (!p) return json(res, 404, { error: '项目不存在' });
  const body = await readJson(req);
  const d = setMode(p.id, body.mode);
  addEvent(db, p.id, 'draft', '投标文件模式改为：' + (d.mode === 'merged' ? '合并一份' : '分三份独立编制'));
  json(res, 200, { ok: true, draft: d });
});

route('POST', '/api/projects/:id/draft/:doc/outline', async (req, res, ctx) => {
  const p = get(db, 'SELECT * FROM projects WHERE id = ?', ctx.params.id);
  if (!p) return json(res, 404, { error: '项目不存在' });
  if (!DOC_META[ctx.params.doc]) return json(res, 400, { error: '文件类型不正确' });
  if (!apiReady()) return json(res, 400, { error: '还没有设置 DeepSeek API Key，请先到设置里填写' });
  const body = await readJson(req).catch(() => ({}));
  const d = ensureDraft(p.id);
  const an = loadAnalysis(p.id);
  let doc = d.docs[ctx.params.doc];
  if (!doc) {
    d.docs[ctx.params.doc] = { key: ctx.params.doc, title: DOC_META[ctx.params.doc].title, chapters: [], built: false };
    saveDraft(p.id, d);
    doc = d.docs[ctx.params.doc];
  }
  if (doc.built && doc.chapters && doc.chapters.some((c) => c.body) && !body.force) {
    return json(res, 400, { error: '这份文件已经有内容了，重新生成框架会覆盖，需要你确认' });
  }
  const t = startOutlineTask(p, d, ctx.params.doc, an);
  json(res, 200, { ok: true, taskId: t.id });
});

route('GET', '/api/draft-tasks/:taskId', async (req, res, ctx) => {
  const t = getDraftTask(ctx.params.taskId);
  if (!t) return json(res, 404, { error: '任务不存在' });
  json(res, 200, { ok: true, task: t });
});

route('POST', '/api/projects/:id/draft/:doc/chapter/:cid', async (req, res, ctx) => {
  const p = get(db, 'SELECT * FROM projects WHERE id = ?', ctx.params.id);
  if (!p) return json(res, 404, { error: '项目不存在' });
  if (!apiReady()) return json(res, 400, { error: '还没有设置 DeepSeek API Key，请先到设置里填写' });
  const body = await readJson(req).catch(() => ({}));
  const d = ensureDraft(p.id);
  const doc = d.docs[ctx.params.doc];
  if (!doc) return json(res, 404, { error: '这份文件还没有生成框架' });
  const c = (doc.chapters || []).find((x) => x.id === ctx.params.cid);
  if (!c) return json(res, 404, { error: '章节不存在' });
  const an = loadAnalysis(p.id);
  const t = startChapterTask(p, d, ctx.params.doc, ctx.params.cid, an, body.mode || 'first');
  json(res, 200, { ok: true, taskId: t.id });
});

route('PUT', '/api/projects/:id/draft/:doc/chapter/:cid', async (req, res, ctx) => {
  const p = get(db, 'SELECT * FROM projects WHERE id = ?', ctx.params.id);
  if (!p) return json(res, 404, { error: '项目不存在' });
  const body = await readJson(req);
  const d = ensureDraft(p.id);
  const doc = d.docs[ctx.params.doc];
  if (!doc) return json(res, 404, { error: '这份文件还没有生成框架' });
  const c = (doc.chapters || []).find((x) => x.id === ctx.params.cid);
  if (!c) return json(res, 404, { error: '章节不存在' });
  if (typeof body.title === 'string') c.title = body.title.trim() || c.title;
  if (typeof body.body === 'string') { c.body = body.body; c.source = 'manual'; }
  if (body.rows) c.rows = body.rows;
  c.updatedAt = nowIso();
  saveDraft(p.id, d);
  json(res, 200, { ok: true, chapter: c });
});

route('POST', '/api/projects/:id/draft/:doc/chapter', async (req, res, ctx) => {
  const p = get(db, 'SELECT * FROM projects WHERE id = ?', ctx.params.id);
  if (!p) return json(res, 404, { error: '项目不存在' });
  const body = await readJson(req);
  const d = ensureDraft(p.id);
  const doc = d.docs[ctx.params.doc];
  if (!doc) return json(res, 404, { error: '这份文件还没有生成框架' });
  const c = { id: uid('c_'), title: (body.title || '新章节').trim(), type: 'normal', hint: body.hint || '', words: 500, body: body.body || '', source: 'manual', updatedAt: nowIso() };
  doc.chapters.push(c);
  saveDraft(p.id, d);
  json(res, 200, { ok: true, chapter: c });
});

route('POST', '/api/projects/:id/draft/:doc/chapter/:cid/delete', async (req, res, ctx) => {
  const p = get(db, 'SELECT * FROM projects WHERE id = ?', ctx.params.id);
  if (!p) return json(res, 404, { error: '项目不存在' });
  const d = ensureDraft(p.id);
  const doc = d.docs[ctx.params.doc];
  if (!doc) return json(res, 404, { error: '这份文件还没有生成框架' });
  const before = doc.chapters.length;
  doc.chapters = doc.chapters.filter((x) => x.id !== ctx.params.cid);
  saveDraft(p.id, d);
  json(res, 200, { ok: true, removed: before - doc.chapters.length });
});

route('POST', '/api/projects/:id/draft/:doc/refresh-tables', async (req, res, ctx) => {
  const p = get(db, 'SELECT * FROM projects WHERE id = ?', ctx.params.id);
  if (!p) return json(res, 404, { error: '项目不存在' });
  const d = ensureDraft(p.id);
  const an = loadAnalysis(p.id);
  if (!an) return json(res, 400, { error: '还没有招标分析结果，请先完成招标文件分析' });
  const n = refreshTables(d, an);
  saveDraft(p.id, d);
  json(res, 200, { ok: true, updated: n, draft: d });
});

route('POST', '/api/projects/:id/draft/:doc/export', async (req, res, ctx) => {
  const p = get(db, 'SELECT * FROM projects WHERE id = ?', ctx.params.id);
  if (!p) return json(res, 404, { error: '项目不存在' });
  const d = ensureDraft(p.id);
  const doc = d.docs[ctx.params.doc];
  if (!doc || !doc.chapters || !doc.chapters.length) return json(res, 400, { error: '还没有生成框架' });
  try {
    const dir = path.join(PROJECT_DIR, p.dir, '03制作');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const name = doc.title + '_' + stamp + '.docx';
    const outPath = path.join(dir, name);
    await exportDraftDocx(p, doc, outPath);
    const rel = '项目/' + p.dir + '/03制作/' + name;
    addEvent(db, p.id, 'export', '导出' + doc.title + ' Word');
    json(res, 200, { ok: true, relPath: rel, fileName: name, absPath: outPath });
  } catch (e) {
    json(res, 500, { error: '导出失败：' + String(e && e.message || e) });
  }
});

// 导入我自己写的章节 Word：按一级标题拆成章节，合并进框架
route('POST', '/api/projects/:id/draft/:doc/import', async (req, res, ctx) => {
  const p = get(db, 'SELECT * FROM projects WHERE id = ?', ctx.params.id);
  if (!p) return json(res, 404, { error: '项目不存在' });
  const d = ensureDraft(p.id);
  const doc = d.docs[ctx.params.doc];
  if (!doc) return json(res, 404, { error: '这份文件还没有生成框架，请先点「生成框架」' });
  const body = await readBody(req);
  const ctype = req.headers['content-type'] || '';
  const bMatch = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ctype);
  if (!bMatch) return json(res, 400, { error: '请用表单方式上传文件' });
  let parts;
  try { parts = parseMultipart(body, bMatch[1] || bMatch[2]); } catch (e) { return json(res, 400, { error: '文件读取失败' }); }
  const part = parts.find((x) => x.filename);
  if (!part) return json(res, 400, { error: '没有收到文件' });
  const name = decodeFileName(part.filename);
  const ext = path.extname(name).toLowerCase();
  if (!['.docx', '.doc'].includes(ext)) return json(res, 400, { error: '只支持 Word 文件（.docx / .doc）' });
  let buf = part.data;
  if (ext === '.doc') {
    const tmpIn = path.join(os.tmpdir(), 'twb_imp_' + Date.now() + '.doc');
    const tmpOut = path.join(os.tmpdir(), 'twb_imp_' + Date.now() + '.docx');
    fs.writeFileSync(tmpIn, buf);
    try { buf = docToDocx(tmpIn, tmpOut); } finally { try { fs.unlinkSync(tmpIn); } catch {} try { fs.unlinkSync(tmpOut); } catch {} }
  }
  let outline = null;
  // maxLevel 2：按你的要求，只列一级、二级标题章节（三级及更深的标题并入上一级正文，不丢内容）
  try { outline = parseDocxOutline(buf, { maxLevel: 2 }); } catch (e) { return json(res, 400, { error: '读不出这个 Word 的结构：' + String(e && e.message || e) }); }
  let chunks = (outline && outline.chapters) || [];
  // 兜底：这个 Word 没有任何标题层级时，才用文字规律猜
  if (!chunks.length) {
    let text = '';
    try { text = await extractDocxText(buf); } catch (e) { return json(res, 400, { error: '读不出这个 Word 的内容：' + String(e && e.message || e) }); }
    chunks = splitByHeading(text).map((c) => ({ title: c.title, level: 1, number: '', body: c.body }));
  }
  if (!chunks.length) return json(res, 400, { error: '这个文件里没读到章节内容' });
  // 保存原始文件，便于追溯
  const dir = path.join(PROJECT_DIR, p.dir, '03制作');
  fs.mkdirSync(dir, { recursive: true });
  const keep = '导入_' + doc.key + '_' + Date.now() + '_' + safeName(name, 'import.docx');
  fs.writeFileSync(path.join(dir, keep), buf);

  // 整份替换：以你上传的标书章节与顺序为准，不再保留自动生成的框架
  const prevCount = (doc.chapters || []).length;
  applyUploadedOutline(doc, chunks, name);
  saveDraft(p.id, d);
  addEvent(db, p.id, 'draft', '导入 ' + name + ' 到' + doc.title + '（按上传结构替换为 ' + doc.chapters.length + ' 章）');
  json(res, 200, {
    ok: true, mode: 'replace', chapters: doc.chapters.length - 2, prevChapters: Math.max(0, prevCount - 2),
    titles: chunks.slice(0, 40).map((c) => ({ title: c.title, level: c.level, number: c.number || '' })),
    skippedToc: (outline && outline.skippedToc) || 0,
    skippedDeep: (outline && outline.skippedDeep) || 0,
    fileName: name
  });
});

// ---------- v1.1.4：项目补录一键归档 ----------
// 用户只做一件事：传招标文件 + 传投标文件（几份都行），点「分析并归档」。
// 剩下全自动：建项目 → 读招标文件基本信息 → 分析关键信息 → 拆投标文件章节 → 判章节性质 → 关闭归档 + 进知识库。
const backfillTasks = new Map();

function bfTaskOf(id) {
  const t = backfillTasks.get(id);
  if (!t) return null;
  return { id: t.id, projectId: t.projectId, state: t.state, step: t.step, steps: t.steps, message: t.message, error: t.error, result: t.result, cleaned: t.cleaned || null, startedAt: t.startedAt, finishedAt: t.finishedAt };
}

function bfSet(t, step, message) {
  t.step = step;
  t.message = message;
  t.updatedAt = nowIso();
}

route('POST', '/api/backfill', async (req, res) => {
  const body = await readJson(req);
  const pid0 = String(body.projectId || '');
  const proj0 = pid0 ? get(db, 'SELECT * FROM projects WHERE id = ?', pid0) : null;
  if (!proj0) return json(res, 400, { error: '补录项目不存在，请重新打开补录窗口' });
  const tenderId = String(body.tenderFileId || '');
  const bidIds = Array.isArray(body.bidFileIds) ? body.bidFileIds : [];
  if (!tenderId) return json(res, 400, { error: '请先传一份招标文件' });
  if (!bidIds.length) return json(res, 400, { error: '请至少传一份投标文件' });

  const tf = get(db, 'SELECT * FROM files WHERE id = ?', tenderId);
  if (!tf) return json(res, 400, { error: '招标文件没找到，请重新上传' });
  const bids = all(db, 'SELECT * FROM files WHERE id IN (' + bidIds.map(() => '?').join(',') + ')', ...bidIds);
  if (!bids.length) return json(res, 400, { error: '投标文件没找到，请重新上传' });

  const id = uid('t_');
  const t = {
    id, projectId: pid0, state: 'running', step: 0,
    steps: ['读招标文件', '识别基本信息', '分析关键信息', '整理投标文件', '判断章节性质', '关闭归档'],
    message: '正在准备…', error: '', result: null,
    startedAt: nowIso(), finishedAt: ''
  };
  backfillTasks.set(id, t);

  // 后台跑，前端轮询 /api/backfill/:id
  (async () => {
    try {
      // 1) 用已经建好的补录项目（文件已经传到它自己的目录里）
      bfSet(t, 0, '正在准备项目…');
      const pid = pid0;
      const dir = proj0.dir;
      const tender = tf;
      const bidMoved = bids;
      // 投标文件统一标成 draft 阶段的上传稿
      bidMoved.forEach((f) => run(db, 'UPDATE files SET stage = ?, role = ? WHERE id = ?', 'draft', 'uploaded', f.id));

      // 3) 读招标文件 → 识别基本信息
      bfSet(t, 1, '正在读招标文件…');
      const tenderAbs = path.join(ROOT, tender.relPath);
      let meta = null;
      let metaErr = '';
      if (apiReady()) {
        try {
          let cache = await ensureText(tender, tenderAbs);
          if (cache.scanned || cache.chars < 200) {
            const probe = Math.max(1, Math.min(cache.pageCount || 12, 12));
            const pages = [];
            for (let i = 1; i <= probe; i++) pages.push(i);
            const r = await ocrPages(tender, tenderAbs, pages);
            cache = r.cache;
          }
          let full = buildFullText(cache.pages);
          if (full.length > 120000) full = full.slice(0, 120000) + '\n\n（以下内容过长已截断）';
          if (full.trim().length >= 100) {
            meta = await callJson(SYSTEM_META, metaUserPrompt(full), { maxTokens: 4000 });
            const fields = ['code', 'name', 'owner', 'agency', 'budget', 'bidDeadline', 'openTime', 'openPlace', 'deposit', 'purchaseMethod', 'packageNo', 'company', 'notes'];
            const sets = [];
            const vals = [];
            fields.forEach((k) => {
              const v = String((meta && meta[k]) || '').trim();
              if (v) { sets.push(k + ' = ?'); vals.push(v); }
            });
            if (sets.length) {
              sets.push('updatedAt = ?');
              vals.push(nowIso(), pid);
              run(db, 'UPDATE projects SET ' + sets.join(', ') + ' WHERE id = ?', ...vals);
            }
          } else {
            metaErr = '招标文件里没读到足够文字';
          }
        } catch (e) {
          metaErr = String(e && e.message || e);
        }
      } else {
        metaErr = '没有填 DeepSeek API Key，跳过 AI 识别';
      }

      // 4) 分析招标文件（生成关键信息清单）
      bfSet(t, 2, '正在分析招标文件…');
      let analysisErr = '';
      let analysisWarn = '';
      if (apiReady()) {
        try {
          const task = startAnalysis(db, pid, {});
          const deadline = Date.now() + 20 * 60 * 1000;
          while (Date.now() < deadline) {
            const cur = getTask(task.taskId);
            if (!cur) break;
            // v1.1.5：partial（部分段落没跑通）也算分析结束，不能再等下去
            if (cur.state === 'done' || cur.state === 'partial') {
              if (cur.state === 'partial') {
                const n = (cur.failedSegments || []).length;
                analysisWarn = '分析完成，但有 ' + n + ' 段没跑通（不影响后面整理）';
              }
              break;
            }
            if (cur.state === 'failed') { analysisErr = cur.error || '分析失败'; break; }
            bfSet(t, 2, '正在分析招标文件…' + (cur.message ? '（' + cur.message + '）' : ''));
            await new Promise((r) => setTimeout(r, 2500));
          }
        } catch (e) {
          analysisErr = String(e && e.message || e);
        }
      } else {
        analysisErr = '没有填 DeepSeek API Key，跳过分析';
      }

      // 5) 整理投标文件：几份就收几份，自动判断各是哪一份
      bfSet(t, 3, '正在整理投标文件…');
      const d = ensureDraft(pid);
      d.mode = bidMoved.length > 1 ? 'split' : 'merged';
      d.docs = {};
      if (d.mode === 'merged') d.docs.merged = makeDoc('merged');
      else ['price', 'biz', 'qual'].forEach((k) => { d.docs[k] = makeDoc(k); });
      const used = {};
      const pending = [];
      bidMoved.forEach((f) => {
        const k = d.mode === 'merged' ? 'merged' : guessDocKeyByFile(f.originalName);
        if (k && !used[k]) used[k] = f; else pending.push(f);
      });
      pending.forEach((f) => {
        if (!used.biz) used.biz = f;
        else used.biz = Array.isArray(used.biz) ? used.biz.concat([f]) : [used.biz, f];
      });
      const importReport = [];
      for (const key of Object.keys(used)) {
        const arr = Array.isArray(used[key]) ? used[key] : [used[key]];
        const doc = d.docs[key] || (d.docs[key] = makeDoc(key));
        let first = true;
        for (const f of arr) {
          const abs = path.join(ROOT, f.relPath);
          if (!fs.existsSync(abs)) { importReport.push({ key, file: f.originalName, error: '文件不在磁盘' }); continue; }
          let chunks = [];
          try { chunks = await outlineOfBidFile(abs, f.originalName, f); } catch (e) { importReport.push({ key, file: f.originalName, error: String(e && e.message || e) }); continue; }
          if (!chunks.length) { importReport.push({ key, file: f.originalName, error: '没读到章节' }); continue; }
          if (first) { applyUploadedOutline(doc, chunks, f.originalName); first = false; }
          else {
            chunks.forEach((c) => {
              const tt = String(c.title || '').trim();
              if (!tt) return;
              doc.chapters.push({ id: uid('c_'), title: tt, type: 'normal', hint: '', words: 0, body: String(c.body || '').trim(), source: 'upload', level: Number(c.level) || 1, number: String(c.number == null ? '' : c.number), noIdx: true, role: '', roleBy: '', updatedAt: nowIso() });
            });
          }
          importReport.push({ key, file: f.originalName, chapters: chunks.length });
        }
      }
      Object.keys(d.docs).forEach((k) => { if (!used[k]) delete d.docs[k]; });
      saveDraft(pid, d);

      // 6) 判章节性质（重要技术 / 重要商务），归档时才挑得对
      bfSet(t, 4, '正在判断哪些章节是重要内容…');
      let roleErr = '';
      if (apiReady()) {
        for (const key of Object.keys(d.docs || {})) {
          const doc = d.docs[key];
          if (!doc || !(doc.chapters || []).length) continue;
          try { await reviewRoles(doc, { fallback: true }); } catch (e) { roleErr = String(e && e.message || e); }
        }
        saveDraft(pid, d);
      } else {
        roleErr = '没有填 DeepSeek API Key，跳过章节判断';
      }

      // 7) 关闭归档 + 进知识库
      bfSet(t, 5, '正在归档…');
      const proj = get(db, 'SELECT * FROM projects WHERE id = ?', pid);
      const ar = archiveProject(proj, db, { note: '项目补录自动归档', sessions: listSessions(pid) });
      run(db, 'UPDATE projects SET status = ?, closedAt = ?, archiveNote = ?, closedBy = ?, updatedAt = ? WHERE id = ?',
        'archived', nowIso(), '项目补录自动归档||' + ar.relDir, 'backfill', nowIso(), pid);
      addEvent(db, pid, 'archive', '补录归档到 ' + ar.relDir);
      appendProcess(pid, { kind: 'archive', title: '补录一键归档', detail: '归档目录：' + ar.relDir + '\n文件数：' + ar.files });

      // v1.2.0：补录归档后自动提炼知识卡
      let bfCardTaskId = '';
      try {
        const kc = ar.knowledgeChapters;
        if (kc && ((kc.tech || []).length || (kc.biz || []).length) && apiReady()) {
          bfCardTaskId = startCardTask(proj, kc, {}).id;
        }
      } catch (e) { console.log('[TWB] 补录知识卡提炼没启动：' + (e && e.message || e)); }

      const kn = ar.knowledge && !ar.knowledge.error ? ar.knowledge : null;
      t.state = 'done';
      t.finishedAt = nowIso();
      t.message = '已归档';
      t.result = {
        projectId: pid,
        dir: ar.dir, relDir: ar.relDir, files: ar.files,
        meta, metaErr, analysisErr, roleErr,
        imports: importReport,
        knowledge: kn ? { tech: (kn.counts && kn.counts.tech) || 0, biz: (kn.counts && kn.counts.biz) || 0, hasProfile: kn.hasProfile || {} } : null,
        knowledgeErr: ar.knowledge && ar.knowledge.error ? ar.knowledge.error : '',
        cardTaskId: bfCardTaskId
      };
    } catch (e) {
      t.state = 'failed';
      t.error = String(e && e.message || e);
      t.message = '补录失败：' + t.error;
      t.finishedAt = nowIso();
      // v1.1.5：补录失败就把这个补录项目删掉，别在项目列表里留一个半成品
      try {
        const failedProj = get(db, 'SELECT * FROM projects WHERE id = ?', pid0);
        if (failedProj) {
          t.cleaned = deleteProjectFully(failedProj);
          t.message = '补录失败，已把这个补录项目删掉。原因：' + t.error;
        }
      } catch (e2) {
        t.message = '补录失败：' + t.error + '（自动清理没成功：' + String(e2 && e2.message || e2) + '）';
      }
    }
  })();

  json(res, 200, { ok: true, taskId: id, task: bfTaskOf(id) });
});

route('GET', '/api/backfill/:id', async (req, res, ctx) => {
  const t = bfTaskOf(ctx.params.id);
  if (!t) return json(res, 404, { error: '任务不存在' });
  json(res, 200, t);
});

// ---------- v1.1.4：项目补录（投完的老项目，传两份文件就自动归档） ----------
// 补录时上传几份投标文件就收几份，由后台按文件名与章节内容自动判断它们分别是哪一份。
const BID_DOC_RULES = [
  { key: 'price', re: /价格|报价|开标一览|分项报价|投标函|报价一览/ },
  { key: 'qual', re: /资格|资质|证明文件|营业执照|审查/ },
  { key: 'biz', re: /商务|技术|施工组织|服务方案|技术方案|响应文件/ }
];

function guessDocKeyByFile(fileName) {
  const n = String(fileName || '');
  for (const r of BID_DOC_RULES) if (r.re.test(n)) return r.key;
  return '';
}

async function outlineOfBidFile(absPath, name, fileRow) {
  const ext = path.extname(name).toLowerCase();
  // v1.1.5：PDF 也能读（扫描件自动走本机 OCR / AI 看图）
  if (ext === '.pdf') {
    const row = fileRow || { id: path.basename(absPath).replace(/[^\w]/g, '_'), originalName: name, relPath: '' };
    return await pdfOutlineOfBidFile(row, absPath);
  }
  if (ext !== '.docx' && ext !== '.doc') {
    const err = new Error('目前只能读 PDF 或 Word 格式的投标文件（.pdf / .docx / .doc），这份是 ' + (ext || '未知格式'));
    err.code = 'BAD_FORMAT';
    throw err;
  }
  let buf = fs.readFileSync(absPath);
  if (ext === '.doc') {
    const tmpIn = path.join(os.tmpdir(), 'twb_bf_' + Date.now() + '.doc');
    const tmpOut = path.join(os.tmpdir(), 'twb_bf_' + Date.now() + '.docx');
    fs.writeFileSync(tmpIn, buf);
    try { buf = docToDocx(tmpIn, tmpOut); } finally { try { fs.unlinkSync(tmpIn); } catch {} try { fs.unlinkSync(tmpOut); } catch {} }
  }
  let chunks = [];
  try { const o = parseDocxOutline(buf, { maxLevel: 2 }); chunks = (o && o.chapters) || []; } catch (e) { chunks = []; }
  if (!chunks.length) {
    let text = '';
    try { text = await extractDocxText(buf); } catch (e) { text = ''; }
    chunks = splitByHeading(text).map((c) => ({ title: c.title, level: 1, number: '', body: c.body }));
  }
  return chunks;
}

// v1.1.5：PDF 投标文件按标题切章（切不出来就按页切）
async function pdfOutlineOfBidFile(fileRow, absPath) {
  try {
    return await outlineOfPdfFile(fileRow, absPath);
  } catch (e) {
    const err = new Error('这份 PDF 没能读出文字：' + String(e && e.message || e));
    err.code = (e && e.code) || 'PDF_EXTRACT_FAILED';
    throw err;
  }
}

// 把上传的投标文件切成章节，放进制作稿（几份文件就建几份，自动判断各是哪一份）
route('POST', '/api/projects/:id/backfill/import', async (req, res, ctx) => {
  const p = get(db, 'SELECT * FROM projects WHERE id = ?', ctx.params.id);
  if (!p) return json(res, 404, { error: '项目不存在' });
  const body = await readJson(req);
  const ids = Array.isArray(body.fileIds) ? body.fileIds : [];
  let files = ids.length
    ? all(db, 'SELECT * FROM files WHERE projectId = ? AND id IN (' + ids.map(() => '?').join(',') + ')', p.id, ...ids)
    : all(db, "SELECT * FROM files WHERE projectId = ? AND stage = 'draft' ORDER BY uploadedAt ASC", p.id);
  files = files.filter((f) => /\.(pdf|docx|doc)$/i.test(f.originalName || ''));
  if (!files.length) return json(res, 400, { error: '没有找到可读的投标文件（PDF / Word 都行）' });

  const d = ensureDraft(p.id);
  d.mode = files.length > 1 ? 'split' : 'merged';
  d.docs = {};
  if (d.mode === 'merged') {
    d.docs.merged = makeDoc('merged');
  } else {
    ['price', 'biz', 'qual'].forEach((k) => { d.docs[k] = makeDoc(k); });
  }

  const used = {};
  const report = [];
  const pending = [];
  for (const f of files) {
    let key = guessDocKeyByFile(f.originalName);
    if (d.mode === 'merged') key = 'merged';
    if (!key) { pending.push(f); continue; }
    if (used[key]) { pending.push(f); continue; }
    used[key] = f;
  }
  // 认不出是哪一份的，一律并进「商务技术文件」（正文主体），不往价格文件里塞
  for (const f of pending) {
    if (!used.biz) used.biz = f;
    else used.biz = Array.isArray(used.biz) ? used.biz.concat([f]) : [used.biz, f];
  }

  for (const key of Object.keys(used)) {
    const arr = Array.isArray(used[key]) ? used[key] : [used[key]];
    const doc = d.docs[key] || (d.docs[key] = makeDoc(key));
    let first = true;
    for (const f of arr) {
      const abs = fileAbs(f);
      if (!fs.existsSync(abs)) { report.push({ key, file: f.originalName, error: '文件已不在磁盘' }); continue; }
      let chunks = [];
      try { chunks = await outlineOfBidFile(abs, f.originalName, f); } catch (e) { report.push({ key, file: f.originalName, error: String(e && e.message || e) }); continue; }
      if (!chunks.length) { report.push({ key, file: f.originalName, error: '这个 Word 里没读到章节' }); continue; }
      if (first) {
        applyUploadedOutline(doc, chunks, f.originalName);
        first = false;
      } else {
        // 同一份文件的第二部分：直接接在后面
        chunks.forEach((c) => {
          const t = String(c.title || '').trim();
          if (!t) return;
          doc.chapters.push({
            id: uid('c_'), title: t, type: 'normal', hint: '', words: 0,
            body: String(c.body || '').trim(), source: 'upload', level: Number(c.level) || 1,
            number: String(c.number == null ? '' : c.number), noIdx: true, role: '', roleBy: '', updatedAt: nowIso()
          });
        });
      }
      report.push({ key, file: f.originalName, chapters: chunks.length });
    }
  }
  // 没分到文件的那几份（只有默认模板）不要留在制作稿里，否则界面上会出现「空文件」
  Object.keys(d.docs).forEach((k) => { if (!used[k]) delete d.docs[k]; });
  saveDraft(p.id, d);
  addEvent(db, p.id, 'draft', '补录：导入投标文件 ' + files.length + ' 份');
  json(res, 200, { ok: true, mode: d.mode, docs: Object.keys(d.docs).map((k) => ({ key: k, title: d.docs[k].title, chapters: (d.docs[k].chapters || []).length - 2 })), report });
});

// 自动判一遍哪些章节是「重要技术 / 重要商务」，好让归档时挑对内容进知识库
route('POST', '/api/projects/:id/backfill/review', async (req, res, ctx) => {
  const p = get(db, 'SELECT * FROM projects WHERE id = ?', ctx.params.id);
  if (!p) return json(res, 404, { error: '项目不存在' });
  const d = ensureDraft(p.id);
  const out = [];
  for (const key of Object.keys(d.docs || {})) {
    const doc = d.docs[key];
    if (!doc || !(doc.chapters || []).length) continue;
    let r = null;
    try { r = await reviewRoles(doc, { fallback: true }); } catch (e) { r = { changed: 0, map: {}, error: String(e && e.message || e) }; }
    const chs = (doc.chapters || []).filter((c) => c && c.type === 'normal');
    out.push({
      key, title: doc.title, chapters: chs.length,
      tech: chs.filter((c) => c.role === 'tech').length,
      biz: chs.filter((c) => c.role === 'biz').length,
      error: r && r.error ? r.error : ''
    });
  }
  saveDraft(p.id, d);
  json(res, 200, { ok: true, docs: out });
});

// 恢复自动生成的框架（上传整份替换后不满意可一键退回）
route('POST', '/api/projects/:id/draft/:doc/restore-outline', async (req, res, ctx) => {
  const p = get(db, 'SELECT * FROM projects WHERE id = ?', ctx.params.id);
  if (!p) return json(res, 404, { error: '项目不存在' });
  const d = ensureDraft(p.id);
  const doc = d.docs[ctx.params.doc];
  if (!doc) return json(res, 404, { error: '这份文件还没有生成框架' });
  const ok = restoreAutoOutline(doc);
  if (!ok) return json(res, 400, { error: '没有可恢复的自动框架（你还没上传过 Word）' });
  saveDraft(p.id, d);
  addEvent(db, p.id, 'draft', doc.title + ' 恢复为自动生成的框架');
  appendProcess(p.id, { kind: 'draft', title: doc.title + ' 恢复自动框架', detail: '' });
  json(res, 200, { ok: true, chapters: doc.chapters.length - 2 });
});


// ---------- v1.1.0：章节性质标识（重要技术 / 重要商务） ----------
// AI 复核整份文件的章节性质（规则粗判已在前端展示，这里用 AI 校正一次）
route('POST', '/api/projects/:id/draft/:doc/review-roles', async (req, res, ctx) => {
  const p = get(db, 'SELECT * FROM projects WHERE id = ?', ctx.params.id);
  if (!p) return json(res, 404, { error: '项目不存在' });
  if (!apiReady()) return json(res, 400, { error: '还没有设置 DeepSeek API Key，请先到设置里填写' });
  const d = ensureDraft(p.id);
  const doc = d.docs[ctx.params.doc];
  if (!doc) return json(res, 404, { error: '这份文件还没有生成框架' });
  const r = await reviewRoles(doc, { fallback: true });
  saveDraft(p.id, d);
  const counts = { tech: 0, biz: 0, none: 0 };
  (doc.chapters || []).forEach((c) => { if (c.role === 'tech') counts.tech++; else if (c.role === 'biz') counts.biz++; else counts.none++; });
  addEvent(db, p.id, 'draft', doc.title + ' AI 复核章节性质：重要技术 ' + counts.tech + ' 章、重要商务 ' + counts.biz + ' 章');
  json(res, 200, { ok: true, changed: r.changed || 0, counts, error: r.error || '' });
});

// 手动切换某一章的性质：tech → biz → 空 → tech
route('PUT', '/api/projects/:id/draft/:doc/chapter/:cid/role', async (req, res, ctx) => {
  const p = get(db, 'SELECT * FROM projects WHERE id = ?', ctx.params.id);
  if (!p) return json(res, 404, { error: '项目不存在' });
  const body = await readJson(req);
  const d = ensureDraft(p.id);
  const doc = d.docs[ctx.params.doc];
  if (!doc) return json(res, 404, { error: '这份文件还没有生成框架' });
  const c = setChapterRole(doc, ctx.params.cid, body.role || '');
  if (!c) return json(res, 404, { error: '章节不存在' });
  saveDraft(p.id, d);
  json(res, 200, { ok: true, role: c.role, roleBy: c.roleBy });
});

// ---------- v1.1.0：专家画像 ----------
function profileView(pid) {
  const all = loadProfiles(pid);
  const out = {};
  PROFILE_KINDS.forEach((k) => {
    const rec = all[k];
    out[k] = rec ? { kind: k, label: KIND_LABEL[k], confirmed: !!rec.confirmed, confirmedAt: rec.confirmedAt || '', generatedAt: rec.generatedAt || '', data: rec.data || blankProfile(k), headline: profileHeadline(k, rec.data || {}) } : null;
  });
  return out;
}

route('GET', '/api/projects/:id/profiles', async (req, res, ctx) => {
  const p = get(db, 'SELECT * FROM projects WHERE id = ?', ctx.params.id);
  if (!p) return json(res, 404, { error: '项目不存在' });
  json(res, 200, { ok: true, profiles: profileView(p.id) });
});

// 生成画像（不确认，先给用户看）
route('POST', '/api/projects/:id/profiles/:kind/generate', async (req, res, ctx) => {
  const p = get(db, 'SELECT * FROM projects WHERE id = ?', ctx.params.id);
  if (!p) return json(res, 404, { error: '项目不存在' });
  if (!apiReady()) return json(res, 400, { error: '还没有设置 DeepSeek API Key，请先到设置里填写' });
  const kind = ctx.params.kind === 'biz' ? 'biz' : 'tech';
  const an = loadAnalysis(p.id);
  if (!an) return json(res, 400, { error: '还没有招标分析结果，请先完成招标文件分析（AI 需要先读懂招标文件才能建立画像）' });
  try {
    const refs = findSimilar(p, kind, 3);
    const prof = await generateProfile(p, an, kind, refs);
    const { setProfileDraft } = await import('./lib/profile.mjs');
    setProfileDraft(p.id, kind, prof, { refsUsed: (refs || []).map((r) => ({ projectId: r.projectId, name: r.name })) });
    json(res, 200, { ok: true, kind, label: KIND_LABEL[kind], profile: prof, headline: profileHeadline(kind, prof), refsUsed: (refs || []).length });
  } catch (e) {
    json(res, 500, { error: '画像生成失败：' + String(e && e.message || e) });
  }
});

// 确认画像（可带用户修改后的内容）
route('PUT', '/api/projects/:id/profiles/:kind', async (req, res, ctx) => {
  const p = get(db, 'SELECT * FROM projects WHERE id = ?', ctx.params.id);
  if (!p) return json(res, 404, { error: '项目不存在' });
  const body = await readJson(req);
  const kind = ctx.params.kind === 'biz' ? 'biz' : 'tech';
  const prev = getProfile(p.id, kind);
  const data = body.data && typeof body.data === 'object' ? body.data : (prev && prev.data) || blankProfile(kind);
  if (body.confirm === false) {
    const { setProfileDraft } = await import('./lib/profile.mjs');
    setProfileDraft(p.id, kind, data);
    return json(res, 200, { ok: true, confirmed: false });
  }
  const changed = prev && prev.data ? JSON.stringify(prev.data) !== JSON.stringify(data) : false;
  confirmProfile(p.id, kind, data, { revisionNote: changed ? (body.note || '操作人员确认前修改了画像内容') : '' });
  addEvent(db, p.id, 'draft', '确认' + KIND_LABEL[kind] + '专家画像' + (changed ? '（已人工修改）' : ''));
  json(res, 200, { ok: true, confirmed: true, changed, profile: profileView(p.id)[kind] });
});

// ---------- v1.1.0：专家知识库 ----------
route('GET', '/api/knowledge', async (req, res, ctx) => {
  try { json(res, 200, { ok: true, ...listKnowledge() }); }
  catch (e) { json(res, 500, { error: String(e && e.message || e) }); }
});

route('GET', '/api/knowledge/:pid', async (req, res, ctx) => {
  const k = getKnowledge(ctx.params.pid);
  if (!k) return json(res, 404, { error: '知识库里没有这个项目' });
  json(res, 200, { ok: true, ...k });
});

// v1.1.4：知识库里的图片直接读原路径（只存引用，不复制文件）
route('GET', '/api/knowledge-image/:pid/:name', async (req, res, ctx) => {
  const pid = String(ctx.params.pid || '').replace(/[^\w-]/g, '');
  const name = path.basename(String(ctx.params.name || ''));
  const k = getKnowledge(pid);
  if (!k) { res.writeHead(404); return res.end('not found'); }
  let rel = '';
  const all = [].concat(((k.chapters && k.chapters.tech) || {}).chapters || [], ((k.chapters && k.chapters.biz) || {}).chapters || []);
  all.forEach((c) => { (c.charts || []).forEach((x) => { if (x.kind === 'image' && x.pngRel && path.basename(x.pngRel) === name) rel = x.pngRel; }); });
  const sess = (k.indep && k.indep.sessions) || [];
  sess.forEach((x) => { (x.charts || []).forEach((c) => { if (c.pngRel && path.basename(c.pngRel) === name) rel = c.pngRel; }); });
  if (!rel) { res.writeHead(404); return res.end('not found'); }
  const abs = path.resolve(DATA_DIR, rel);
  if (!abs.startsWith(DATA_DIR) || !fs.existsSync(abs)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
  fs.createReadStream(abs).pipe(res);
});
route('DELETE', '/api/knowledge/:pid', async (req, res, ctx) => {
  const ok = removeKnowledge(ctx.params.pid);
  json(res, 200, { ok: !!ok });
});

// v1.1.1：从项目当前内容（或归档里的制作稿）补录/重建知识库记录
route('POST', '/api/knowledge/:pid/rebuild', async (req, res, ctx) => {
  const p = get(db, 'SELECT * FROM projects WHERE id = ?', ctx.params.pid);
  if (!p) return json(res, 404, { error: '项目不存在' });
  try {
    const r = rebuildKnowledgeFor(p);
    addEvent(db, p.id, 'archive', '重建知识库记录（技术 ' + r.chapters.tech + ' 章 / 商务 ' + r.chapters.biz + ' 章）');
    // v1.2.0：重建知识库时把知识卡也重新提炼一遍（老项目升级用）
    let cardTaskId = '';
    try {
      if (r.chapters) {
        const chs = { tech: [], biz: [] };
        // rebuildKnowledgeFor 只回数量，这里直接从知识库已存的章节文件里取正文
        const k = getKnowledge(p.id);
        ['tech', 'biz'].forEach((kind) => {
          const src = (k && k.chapters && k.chapters[kind]) || null;
          (src && src.chapters ? src.chapters : []).forEach((c) => {
            chs[kind].push({ title: c.title, role: kind, body: c.body || '', charts: c.charts || [] });
          });
        });
        if (chs.tech.length || chs.biz.length) cardTaskId = startCardTask(p, chs, {}).id;
      }
    } catch (e) { console.log('[TWB] 知识卡重提炼没启动：' + (e && e.message || e)); }
    json(res, 200, { ok: true, ...r, cardTaskId });
  } catch (e) {
    json(res, 500, { error: '重建失败：' + String(e && e.message || e) });
  }
});

// ---------- 模块4：投标文件核查 ----------
route('GET', '/api/projects/:id/check', async (req, res, ctx) => {
  const p = get(db, 'SELECT * FROM projects WHERE id = ?', ctx.params.id);
  if (!p) return json(res, 404, { error: '项目不存在' });
  const an = loadAnalysis(p.id);
  json(res, 200, {
    ok: true,
    check: loadCheck(p.id),
    sources: listSources(p),
    hasAnalysis: !!an,
    analysisAt: an ? an.analysisAt : null,
    apiReady: apiReady(),
    running: (function () { try { const t = listCheckTasks().find((x) => x.projectId === p.id); return t ? { taskId: t.id, message: t.message || '' } : null; } catch { return null; } })()
  });
});

route('POST', '/api/projects/:id/check', async (req, res, ctx) => {
  const p = get(db, 'SELECT * FROM projects WHERE id = ?', ctx.params.id);
  if (!p) return json(res, 404, { error: '项目不存在' });
  const body = await readJson(req);
  const pool = listSources(p);
  const ids = Array.isArray(body.ids) && body.ids.length ? body.ids : null;
  // 不指定时只核查「最终版」（你上传的原件优先），不把自动生成的草稿也一起查
  const sources = ids ? pool.filter((s) => ids.includes(s.id)) : pool.filter((s) => s.final);
  if (!sources.length) return json(res, 400, { error: '没有可核查的文件。请先把做好的 Word/PDF 放到「投标文件」页，或在这里上传。' });
  const t = startCheckTask(p, sources, loadAnalysis(p.id));
  addEvent(db, p.id, 'check', '开始核查 ' + sources.length + ' 份文件');
  appendProcess(p.id, { kind: 'check', title: '开始核查', detail: sources.length + ' 份文件：' + sources.map((s) => s.name).join('、') });
  json(res, 200, t);
});

route('GET', '/api/check-tasks/:taskId', async (req, res, ctx) => {
  const t = getCheckTask(ctx.params.taskId);
  if (!t) return json(res, 404, { error: '任务不存在' });
  json(res, 200, { ok: true, task: t });
});

route('POST', '/api/projects/:id/check/export', async (req, res, ctx) => {
  const p = get(db, 'SELECT * FROM projects WHERE id = ?', ctx.params.id);
  if (!p) return json(res, 404, { error: '项目不存在' });
  const c = loadCheck(p.id);
  if (!c) return json(res, 400, { error: '还没有核查结果' });
  try {
    const dir = path.join(PROJECT_DIR, p.dir, '04核查');
    fs.mkdirSync(dir, { recursive: true });
    const d = new Date();
    const stamp = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const outPath = path.join(dir, '核查报告_' + stamp + '.docx');
    await exportCheckDocx(p, c, outPath);
    const rel = '项目/' + p.dir + '/04核查/核查报告_' + stamp + '.docx';
    addEvent(db, p.id, 'export', '导出核查报告 Word');
    json(res, 200, { ok: true, relPath: rel, fileName: '核查报告_' + stamp + '.docx', absPath: outPath });
  } catch (e) {
    json(res, 500, { error: '导出失败：' + String(e && e.message || e) });
  }
});

// ---------- 模块5：递交归档 ----------
route('GET', '/api/projects/:id/submit', async (req, res, ctx) => {
  const p = get(db, 'SELECT * FROM projects WHERE id = ?', ctx.params.id);
  if (!p) return json(res, 404, { error: '项目不存在' });
  const s = ensureSubmit(p, loadAnalysis(p.id));
  json(res, 200, { ok: true, submit: s, groups: GROUPS });
});

route('POST', '/api/projects/:id/submit/rebuild', async (req, res, ctx) => {
  const p = get(db, 'SELECT * FROM projects WHERE id = ?', ctx.params.id);
  if (!p) return json(res, 404, { error: '项目不存在' });
  const s = rebuildSubmit(p, loadAnalysis(p.id));
  addEvent(db, p.id, 'submit', '重新生成递交清单');
  appendProcess(p.id, { kind: 'submit', title: '重新生成递交清单', detail: '' });
  json(res, 200, { ok: true, submit: s });
});

route('PUT', '/api/projects/:id/submit/item', async (req, res, ctx) => {
  const p = get(db, 'SELECT * FROM projects WHERE id = ?', ctx.params.id);
  if (!p) return json(res, 404, { error: '项目不存在' });
  const body = await readJson(req);
  const s = ensureSubmit(p, loadAnalysis(p.id));
  const op = body.op || 'toggle';
  if (op === 'toggle') {
    const it = s.items.find((x) => x.id === body.id);
    if (!it) return json(res, 404, { error: '清单项不存在' });
    it.done = body.done == null ? !it.done : !!body.done;
  } else if (op === 'upsert') {
    const it = body.item || {};
    if (it.id) {
      const old = s.items.find((x) => x.id === it.id);
      if (!old) return json(res, 404, { error: '清单项不存在' });
      Object.assign(old, { title: it.title || old.title, detail: it.detail == null ? old.detail : it.detail, group: it.group || old.group });
    } else {
      s.items.push({ id: uid('s_'), title: it.title || '新事项', detail: it.detail || '', group: it.group || 'prep', done: false, auto: false });
    }
  } else if (op === 'delete') {
    s.items = s.items.filter((x) => x.id !== body.id);
  } else if (op === 'reset') {
    s.items.forEach((x) => { x.done = false; });
  } else {
    return json(res, 400, { error: '不支持的操作：' + op });
  }
  s.updatedAt = nowIso();
  saveSubmit(p.id, s);
  json(res, 200, { ok: true, submit: s });
});

route('POST', '/api/projects/:id/submit/export', async (req, res, ctx) => {
  const p = get(db, 'SELECT * FROM projects WHERE id = ?', ctx.params.id);
  if (!p) return json(res, 404, { error: '项目不存在' });
  const s = ensureSubmit(p, loadAnalysis(p.id));
  try {
    const dir = path.join(PROJECT_DIR, p.dir, '05递交');
    fs.mkdirSync(dir, { recursive: true });
    const d = new Date();
    const stamp = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const outPath = path.join(dir, '递交行动清单_' + stamp + '.docx');
    await exportSubmitDocx(p, s, outPath);
    const rel = '项目/' + p.dir + '/05递交/递交行动清单_' + stamp + '.docx';
    addEvent(db, p.id, 'export', '导出递交行动清单 Word');
    json(res, 200, { ok: true, relPath: rel, fileName: '递交行动清单_' + stamp + '.docx', absPath: outPath });
  } catch (e) {
    json(res, 500, { error: '导出失败：' + String(e && e.message || e) });
  }
});

// ---------- 模块6：项目关闭与归档 ----------
// v1.1.2 关闭归档门禁：真实项目在投标截止时间之前不能关闭；
// 补录项目（isBackfill）不受限制；真实项目确实要放弃投标时，用 mode='abandon' 显式走放弃通道。
route('GET', '/api/projects/:id/close-status', async (req, res, ctx) => {
  const p = get(db, 'SELECT * FROM projects WHERE id = ?', ctx.params.id);
  if (!p) return json(res, 404, { error: '项目不存在' });
  json(res, 200, { ok: true, ...closeStatusOf(p) });
});

function closeStatusOf(p) {
  const isBackfill = String(p.isBackfill || '') === '1';
  const t = p.bidDeadline ? Date.parse(String(p.bidDeadline).replace(' ', 'T')) : NaN;
  const hasDeadline = !Number.isNaN(t);
  const passed = hasDeadline ? Date.now() >= t : true;
  // 没填截止时间的老项目按「已过」处理，否则永远关不掉
  const canClose = isBackfill || passed;
  let reason = '';
  if (!canClose) reason = '投标截止时间还没到（' + p.bidDeadline + '），不能关闭归档。';
  else if (!hasDeadline) reason = '本项目没有填投标截止时间，按已结束处理。';
  return {
    canClose, isBackfill, hasDeadline, passed,
    deadline: p.bidDeadline || '',
    msLeft: hasDeadline ? t - Date.now() : 0,
    reason, abandonAllowed: !isBackfill && !passed
  };
}

route('POST', '/api/projects/:id/close', async (req, res, ctx) => {
  const p = get(db, 'SELECT * FROM projects WHERE id = ?', ctx.params.id);
  if (!p) return json(res, 404, { error: '项目不存在' });
  if (p.status === 'archived') return json(res, 400, { error: '这个项目已经关闭归档了' });
  const body = await readJson(req);
  const st = closeStatusOf(p);
  const mode = String(body.mode || '');
  if (!st.canClose && mode !== 'abandon') {
    return json(res, 403, {
      error: st.reason + '如果这个项目确实不投了，可以点「放弃投标，关闭归档」。',
      code: 'DEADLINE_BLOCK', ...st
    });
  }
  if (mode === 'abandon') {
    const why = String(body.abandonReason || '').trim();
    if (!why) return json(res, 400, { error: '放弃投标要写一句原因（方便以后复盘）。', code: 'NEED_REASON' });
  }
  if (String(body.confirmText || '') !== '关闭归档') {
    return json(res, 400, { error: '请手动输入「关闭归档」四个字确认。', code: 'NEED_CONFIRM' });
  }
  try {
    const r = archiveProject(p, db, { note: body.note || '', sessions: listSessions(p.id) });
    const closedBy = mode === 'abandon' ? 'abandon' : 'normal';
    run(db, 'UPDATE projects SET status = ?, closedAt = ?, archiveNote = ?, closedBy = ?, abandonReason = ?, updatedAt = ? WHERE id = ?',
      'archived', nowIso(), (body.note || '') + '||' + r.relDir, closedBy, mode === 'abandon' ? String(body.abandonReason || '') : '', nowIso(), p.id);
    addEvent(db, p.id, 'archive', (mode === 'abandon' ? '放弃投标，关闭归档到 ' : '项目关闭并归档到 ') + r.relDir);
    appendProcess(p.id, {
      kind: 'archive',
      title: mode === 'abandon' ? '放弃投标，关闭归档' : '关闭归档',
      detail: (body.note || '') + (mode === 'abandon' ? '\n放弃原因：' + body.abandonReason : '') + '\n归档目录：' + r.relDir + '\n文件数：' + r.files
    });
    // v1.2.0：归档后自动把重要技术/商务内容提炼成知识卡（后台跑，不阻塞关闭）
    let cardTaskId = '';
    try {
      const kc = r.knowledgeChapters;
      if (kc && ((kc.tech || []).length || (kc.biz || []).length) && apiReady()) {
        cardTaskId = startCardTask(p, kc, {}).id;
        appendProcess(p.id, { kind: 'knowledge', title: '开始提炼知识卡', detail: '技术 ' + (kc.tech || []).length + ' 章 / 商务 ' + (kc.biz || []).length + ' 章' });
      }
    } catch (e) { console.log('[TWB] 知识卡提炼没启动：' + (e && e.message || e)); }
    json(res, 200, {
      ok: true, dir: r.dir, relDir: r.relDir, files: r.files,
      cardTaskId,
      knowledge: r.knowledge || null,
      knowledgeSummary: r.knowledge && !r.knowledge.error
        ? { tech: (r.knowledge.counts && r.knowledge.counts.tech) || 0, biz: (r.knowledge.counts && r.knowledge.counts.biz) || 0, hasProfile: r.knowledge.hasProfile || {} }
        : null
    });
  } catch (e) {
    json(res, 500, { error: '归档失败：' + String(e && e.message || e) });
  }
});

route('POST', '/api/projects/:id/reopen', async (req, res, ctx) => {
  const p = get(db, 'SELECT * FROM projects WHERE id = ?', ctx.params.id);
  if (!p) return json(res, 404, { error: '项目不存在' });
  run(db, 'UPDATE projects SET status = ?, closedAt = NULL, updatedAt = ? WHERE id = ?', 'active', nowIso(), p.id);
  addEvent(db, p.id, 'archive', '项目重新打开');
  json(res, 200, { ok: true });
});

route('GET', '/api/archives', async (req, res) => {
  // v1.1.1：早期归档的 项目摘要.json 里没有 projectId，用编号/名称回查一次，好让「重新打开」按钮能用
  const list = listArchives().map((a) => {
    if (a.projectId) return a;
    let p = null;
    if (a.code) p = get(db, 'SELECT id FROM projects WHERE code = ?', a.code);
    if (!p && a.name) p = get(db, 'SELECT id FROM projects WHERE name = ?', a.name);
    return p ? { ...a, projectId: p.id } : a;
  });
  json(res, 200, { ok: true, archives: list, root: ARCHIVE_DIR });
});

// 在资源管理器里打开某个文件夹
route('POST', '/api/reveal', async (req, res) => {
  const body = await readJson(req);
  const p = body.path || '';
  if (!p) return json(res, 400, { error: '没给路径' });
  const target = path.isAbsolute(p) ? p : path.join(ROOT, p);
  if (!target.startsWith(ROOT) && !target.startsWith(ARCHIVE_DIR)) return json(res, 400, { error: '只能打开工作台里的文件夹' });
  if (!fs.existsSync(target)) return json(res, 404, { error: '文件夹不存在' });
  const { spawn } = await import('node:child_process');
  spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' }).unref();
  json(res, 200, { ok: true });
});

function normTitle(s) { return String(s || '').replace(/[\s　:：、.．()（）\-—_]/g, '').toLowerCase(); }

// 按「一、XXX」「第一章 XXX」「1 XXX」这类标题切分
function splitByHeading(text) {
  const lines = String(text || '').split('\n');
  const HEAD = /^\s*(?:第[一二三四五六七八九十]+[章节部分]|[一二三四五六七八九十]+[、.．])\s*(.{2,40})$/;
  const out = [];
  let cur = null;
  lines.forEach((raw) => {
    const line = raw.trim();
    if (!line) { if (cur) cur.buf.push(''); return; }
    const m = HEAD.exec(line);
    if (m && line.length <= 48) {
      if (cur && cur.buf.join('').trim()) out.push({ title: cur.title, body: cur.buf.join('\n').trim() });
      cur = { title: m[1].replace(/[：:]\s*$/, '').trim(), buf: [] };
      return;
    }
    if (cur) cur.buf.push(line);
  });
  if (cur && cur.buf.join('').trim()) out.push({ title: cur.title, body: cur.buf.join('\n').trim() });
  return out.filter((x) => x.body.length > 20);
}

// ---------- v1.1.2 独立编制（重要技术 / 重要商务章节） ----------
function fmtSizeSoft(n) {
  const b = Number(n) || 0;
  if (b > 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
  if (b > 1024) return Math.round(b / 1024) + ' KB';
  return b + ' B';
}
function needProject(id) {
  const p = get(db, 'SELECT * FROM projects WHERE id = ?', id);
  if (!p) { const e = new Error('项目不存在'); e.status = 404; throw e; }
  return p;
}
function guardArchived(p) {
  if (p.status === 'archived') { const e = new Error('这个项目已经关闭归档了，只能查看。要修改请先点「重新打开」。'); e.status = 403; e.code = 'ARCHIVED_READONLY'; throw e; }
}
function indepChapter(p, docKey, cid) {
  const d = loadDraft(p.id);
  if (!d || !d.docs || !d.docs[docKey]) { const e = new Error('还没生成投标文件框架'); e.status = 400; throw e; }
  const c = (d.docs[docKey].chapters || []).find((x) => x.id === cid);
  if (!c) { const e = new Error('章节不存在'); e.status = 404; throw e; }
  return { draft: d, chapter: c };
}

route('GET', '/api/projects/:id/draft/:doc/chapter/:cid/indep', async (req, res, ctx) => {
  const p = needProject(ctx.params.id);
  const { chapter } = indepChapter(p, ctx.params.doc, ctx.params.cid);
  const s2 = ensureSession(p, ctx.params.doc, chapter);
  const analysis = readAnalysis(p.id);
  json(res, 200, {
    ok: true, session: clientSession(s2), chapter: { id: chapter.id, title: chapter.title, role: chapter.role || '', body: chapter.body || '' },
    outDir: s2.outDir || defaultOutDir(p), browser: browserStatus(),
    hasAnalysis: !!analysis, apiReady: apiReady()
  });
});

route('POST', '/api/projects/:id/draft/:doc/chapter/:cid/indep/save', async (req, res, ctx) => {
  const p = needProject(ctx.params.id);
  guardArchived(p);
  const { chapter } = indepChapter(p, ctx.params.doc, ctx.params.cid);
  const body = await readJson(req);
  const s2 = ensureSession(p, ctx.params.doc, chapter);
  if (typeof body.text === 'string') s2.text = body.text;
  if (Array.isArray(body.charts)) {
    // 只接受已有图的元信息，png 路径以服务端为准，避免前端乱写路径
    const byId = new Map((s2.charts || []).map((c) => [c.id, c]));
    s2.charts = body.charts.map((c) => {
      const old = byId.get(c.id);
      if (!old) return null;
      return { ...old, title: c.title || old.title, caption: c.caption || old.caption, afterText: c.afterText || old.afterText };
    }).filter(Boolean);
  }
  if (Array.isArray(body.hints)) s2.hints = body.hints.slice(0, 40).map((h) => ({ afterText: String(h.afterText || ''), text: String(h.text || '').slice(0, 800) }));
  s2.updatedAt = new Date().toISOString();
  saveSession(s2);
  json(res, 200, { ok: true, chars: (s2.text || '').length });
});

/* v1.1.3：PDF 真实版面预览（稿件 → Word → PDF → 每页 PNG + 每行纵向坐标） */
route('POST', '/api/projects/:id/draft/:doc/chapter/:cid/indep/preview', async (req, res, ctx) => {
  const p = needProject(ctx.params.id);
  const { chapter } = indepChapter(p, ctx.params.doc, ctx.params.cid);
  const body = await readJson(req).catch(() => ({}));
  const s2 = ensureSession(p, ctx.params.doc, chapter);
  if (typeof body.text === 'string') s2.text = body.text;
  if (Array.isArray(body.charts)) {
    const byId = new Map((s2.charts || []).map((c) => [c.id, c]));
    s2.charts = body.charts.map((c) => {
      const old = byId.get(c.id);
      return old ? { ...old, title: c.title || old.title, caption: c.caption || old.caption, afterText: c.afterText || old.afterText } : null;
    }).filter(Boolean);
  }
  saveSession(s2);
  try {
    const meta = await renderPreview(p, s2, !!body.force);
    const base = '/api/indep-preview/' + encodeURIComponent(p.id) + '/' + encodeURIComponent(chapter.id) + '/';
    json(res, 200, {
      ok: true, sig: meta.sig, at: meta.at, total: meta.total,
      pages: meta.pages.map((x) => ({ page: x.page, w: x.w, h: x.h, url: base + encodeURIComponent(x.img), lines: x.lines }))
    });
  } catch (e) {
    json(res, 500, { error: '版面预览生成失败：' + String(e && e.message || e) });
  }
});

/* v1.1.3：下载单张配图 / 单张表格。图片给 png，表格只给 docx */
route('GET', '/api/projects/:id/draft/:doc/chapter/:cid/indep/chart/:chartId/download', async (req, res, ctx) => {
  const p = needProject(ctx.params.id);
  const { chapter } = indepChapter(p, ctx.params.doc, ctx.params.cid);
  const s2 = ensureSession(p, ctx.params.doc, chapter);
  const c = (s2.charts || []).find((x) => x.id === ctx.params.chartId);
  if (!c) return json(res, 404, { error: '这张图不存在了' });
  if (c.chartType === 'table') {
    try {
      const out = await chartDocx(s2, c.id);
      res.writeHead(200, {
        'Content-Type': MIME['.docx'] || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': 'attachment; filename="' + encodeURIComponent(out.name) + '"'
      });
      return res.end(out.buf);
    } catch (e) { return json(res, 500, { error: String(e && e.message || e) }); }
  }
  if (!c.png || !fs.existsSync(c.png)) return json(res, 404, { error: '这张图还没画出来' });
  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Content-Disposition': 'attachment; filename="' + encodeURIComponent(path.basename(c.png)) + '"'
  });
  fs.createReadStream(c.png).pipe(res);
});

route('GET', '/api/indep-preview/:pid/:cid/:name', async (req, res, ctx) => {
  const f = previewPageFile(ctx.params.pid, ctx.params.cid, ctx.params.name);
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
  fs.createReadStream(f).pipe(res);
});

/* v1.1.3：独立编制里「重新上传 Word」——用你改过的 Word 覆盖稿件正文 */
route('POST', '/api/projects/:id/draft/:doc/chapter/:cid/indep/import', async (req, res, ctx) => {
  const p = needProject(ctx.params.id);
  guardArchived(p);
  const { chapter } = indepChapter(p, ctx.params.doc, ctx.params.cid);
  const raw = await readBody(req);
  const ctype = req.headers['content-type'] || '';
  const bMatch = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ctype);
  if (!bMatch) return json(res, 400, { error: '请用表单方式上传文件' });
  let parts;
  try { parts = parseMultipart(raw, bMatch[1] || bMatch[2]); } catch (e) { return json(res, 400, { error: '文件读取失败' }); }
  const part = parts.find((x) => x.filename);
  if (!part) return json(res, 400, { error: '没有收到文件' });
  const name = decodeFileName(part.filename);
  const ext = path.extname(name).toLowerCase();
  if (!['.docx', '.doc'].includes(ext)) return json(res, 400, { error: '只支持 Word 文件（.docx / .doc）' });
  let buf = part.data;
  if (ext === '.doc') {
    const tmpIn = path.join(os.tmpdir(), 'twb_ii_' + Date.now() + '.doc');
    const tmpOut = path.join(os.tmpdir(), 'twb_ii_' + Date.now() + '.docx');
    fs.writeFileSync(tmpIn, buf);
    try { buf = docToDocx(tmpIn, tmpOut); } finally { try { fs.unlinkSync(tmpIn); } catch {} try { fs.unlinkSync(tmpOut); } catch {} }
  }
  let text = '';
  try { text = await extractDocxText(buf); } catch (e) { return json(res, 400, { error: '读不出这个 Word 的内容：' + String(e && e.message || e) }); }
  text = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!text) return json(res, 400, { error: '这个 Word 里没有文字' });
  const s2 = ensureSession(p, ctx.params.doc, chapter);
  s2.text = text;
  s2.updatedAt = new Date().toISOString();
  s2.messages = (s2.messages || []).concat([{ role: 'ai', content: '已用你上传的《' + name + '》覆盖当前稿件（' + text.length + ' 字）。图表和补充材料提示保留，需要重画可以点「重新生成图表」。', at: new Date().toISOString() }]);
  saveSession(s2);
  appendProcess(p.id, { kind: 'indep', title: '独立编制重新上传 Word：' + chapter.title, detail: name + '，' + text.length + ' 字' });
  json(res, 200, { ok: true, chars: text.length, fileName: name, session: clientSession(s2) });
});

route('POST', '/api/projects/:id/draft/:doc/chapter/:cid/indep/generate', async (req, res, ctx) => {
  const p = needProject(ctx.params.id);
  guardArchived(p);
  const { chapter } = indepChapter(p, ctx.params.doc, ctx.params.cid);
  const body = await readJson(req);
  const s2 = ensureSession(p, ctx.params.doc, chapter);
  if (body.extra) s2.lastExtra = String(body.extra).slice(0, 4000);
  try {
    const out = await generateDraft(p, s2, readAnalysis(p.id), s2.lastExtra || '');
    appendProcess(p.id, { kind: 'indep', title: '独立编制生成：' + chapter.title, detail: '字数 ' + String(out.text || '').length + '，图 ' + (out.charts || []).length + ' 张' });
    json(res, 200, { ok: true, session: clientSession(out) });
  } catch (e) {
    json(res, 500, { error: String(e && e.message || e) });
  }
});

route('POST', '/api/projects/:id/draft/:doc/chapter/:cid/indep/chat', async (req, res, ctx) => {
  const p = needProject(ctx.params.id);
  guardArchived(p);
  const { chapter } = indepChapter(p, ctx.params.doc, ctx.params.cid);
  const body = await readJson(req);
  const msg = String(body.message || '').trim();
  if (!msg) return json(res, 400, { error: '说点什么再发。' });
  const s2 = ensureSession(p, ctx.params.doc, chapter);
  try {
    const r = await chatWithAI(p, s2, readAnalysis(p.id), msg);
    json(res, 200, { ok: true, reply: r.reply, session: clientSession(r.session) });
  } catch (e) {
    json(res, 500, { error: String(e && e.message || e) });
  }
});

route('POST', '/api/projects/:id/draft/:doc/chapter/:cid/indep/update', async (req, res, ctx) => {
  const p = needProject(ctx.params.id);
  guardArchived(p);
  const { chapter } = indepChapter(p, ctx.params.doc, ctx.params.cid);
  const s2 = ensureSession(p, ctx.params.doc, chapter);
  try {
    const out = await applyUpdate(p, s2, readAnalysis(p.id));
    appendProcess(p.id, { kind: 'indep', title: '独立编制执行更新：' + chapter.title, detail: '字数 ' + String(out.text || '').length });
    json(res, 200, { ok: true, session: clientSession(out) });
  } catch (e) {
    json(res, 500, { error: String(e && e.message || e) });
  }
});

route('POST', '/api/projects/:id/draft/:doc/chapter/:cid/indep/chart/:chartId', async (req, res, ctx) => {
  const p = needProject(ctx.params.id);
  guardArchived(p);
  const { chapter } = indepChapter(p, ctx.params.doc, ctx.params.cid);
  const body = await readJson(req);
  try {
    const s2 = ensureSession(p, ctx.params.doc, chapter);
    const out = body.instruction
      ? await reworkChart(p, s2, ctx.params.chartId, String(body.instruction))
      : await redoChart(p.id, ctx.params.cid, ctx.params.chartId, body);
    json(res, 200, { ok: true, session: clientSession(out) });
  } catch (e) {
    json(res, 500, { error: String(e && e.message || e) });
  }
});

route('POST', '/api/projects/:id/draft/:doc/chapter/:cid/indep/redocharts', async (req, res, ctx) => {
  const p = needProject(ctx.params.id);
  guardArchived(p);
  const { chapter } = indepChapter(p, ctx.params.doc, ctx.params.cid);
  try {
    ensureSession(p, ctx.params.doc, chapter);
    const out = await redoAllCharts(p.id, ctx.params.cid);
    appendProcess(p.id, { kind: 'indep', title: '独立编制重画图表：' + chapter.title, detail: '共 ' + out.results.length + ' 张，失败 ' + out.results.filter((x) => !x.ok).length + ' 张' });
    json(res, 200, { ok: true, session: clientSession(out.session), results: out.results });
  } catch (e) {
    json(res, 500, { error: String((e && e.message) || e) });
  }
});

route('GET', '/api/indep-image/:pid/:cid/:name', async (req, res, ctx) => {
  const f = path.join(DATA_DIR, '独立编制', ctx.params.pid, safeName(ctx.params.cid), path.basename(ctx.params.name));
  if (!f.startsWith(path.join(DATA_DIR, '独立编制')) || !fs.existsSync(f)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
  fs.createReadStream(f).pipe(res);
});

route('POST', '/api/projects/:id/draft/:doc/chapter/:cid/indep/export', async (req, res, ctx) => {
  const p = needProject(ctx.params.id);
  const { chapter } = indepChapter(p, ctx.params.doc, ctx.params.cid);
  const body = await readJson(req);
  const s2 = ensureSession(p, ctx.params.doc, chapter);
  const outDir = body.dir ? path.resolve(String(body.dir)) : defaultOutDir(p);
  try {
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const r = await exportDraftWord(p, s2, outDir);
    addEvent(db, p.id, 'export', '独立编制导出 ' + path.basename(r.file));
    appendProcess(p.id, { kind: 'export', title: '独立编制导出 Word', detail: r.file });
    json(res, 200, { ok: true, ...r });
  } catch (e) {
    json(res, 500, { error: '导出失败：' + String(e && e.message || e) });
  }
});

route('POST', '/api/projects/:id/draft/:doc/chapter/:cid/indep/writeback', async (req, res, ctx) => {
  const p = needProject(ctx.params.id);
  guardArchived(p);
  const { draft, chapter } = indepChapter(p, ctx.params.doc, ctx.params.cid);
  const s2 = ensureSession(p, ctx.params.doc, chapter);
  if (!s2.text || s2.text.length < 40) return json(res, 400, { error: '还没有生成内容，写不回去。' });
  try {
    writeBack(s2, draft, ctx.params.doc);
    saveDraft(p.id, draft);
    addEvent(db, p.id, 'draft', '独立编制写回正文：' + chapter.title);
    appendProcess(p.id, { kind: 'indep', title: '独立编制写回正文：' + chapter.title, detail: '字数 ' + s2.text.length });
    json(res, 200, { ok: true, chars: s2.text.length });
  } catch (e) {
    json(res, 500, { error: String(e && e.message || e) });
  }
});

route('POST', '/api/projects/:id/draft/:doc/chapter/:cid/indep/outdir', async (req, res, ctx) => {
  const p = needProject(ctx.params.id);
  const { chapter } = indepChapter(p, ctx.params.doc, ctx.params.cid);
  const body = await readJson(req);
  const s2 = ensureSession(p, ctx.params.doc, chapter);
  s2.outDir = body.dir ? path.resolve(String(body.dir)) : '';
  saveSession(s2);
  json(res, 200, { ok: true, outDir: s2.outDir || defaultOutDir(p) });
});

// ---------- v1.1.2 过程记录 / 环境自检 / 数据清理 ----------
route('GET', '/api/projects/:id/process', async (req, res, ctx) => {
  const p = needProject(ctx.params.id);
  json(res, 200, { ok: true, ...loadProcess(p.id) });
});

route('POST', '/api/projects/:id/process', async (req, res, ctx) => {
  const p = needProject(ctx.params.id);
  guardArchived(p);
  const body = await readJson(req);
  if (!body.title) return json(res, 400, { error: '标题不能为空' });
  appendProcess(p.id, { kind: body.kind || 'note', title: body.title, detail: body.detail || '' });
  json(res, 200, { ok: true });
});

route('GET', '/api/env-check', async (req, res) => {
  try { json(res, 200, { ok: true, items: await envCheck() }); }
  catch (e) { json(res, 500, { error: String(e && e.message || e) }); }
});

route('POST', '/api/maintenance/prune', async (req, res) => {
  const body = await readJson(req);
  try {
    const r = pruneData({ keepBak: Number(body.keepBak) || 3, keepConv: Number(body.keepConv) || 2 });
    json(res, 200, { ok: true, ...r });
  } catch (e) { json(res, 500, { error: String(e && e.message || e) }); }
});

// ---------- v1.2.0：知识卡接口 ----------
route('GET', '/api/card-types', async (req, res) => {
  json(res, 200, { ok: true, types: CARD_TYPES });
});

route('GET', '/api/knowledge/:pid/cards', async (req, res, ctx) => {
  const pid = ctx.params.pid;
  const p = get(db, 'SELECT * FROM projects WHERE id = ?', pid);
  const all = listCards(pid);
  const out = {};
  ['tech', 'biz'].forEach((k) => {
    const f = all[k];
    out[k] = {
      projectId: pid,
      projectName: (f && f.projectName) || (p && p.name) || '',
      extractedAt: (f && f.extractedAt) || '',
      extractError: (f && f.extractError) || '',
      cards: (f && Array.isArray(f.cards)) ? f.cards : []
    };
  });
  json(res, 200, { ok: true, types: CARD_TYPES, cards: out, projectName: (p && p.name) || '' });
});

// 重新提炼（老项目升级 / 不满意重跑）
route('POST', '/api/knowledge/:pid/cards/extract', async (req, res, ctx) => {
  const p = get(db, 'SELECT * FROM projects WHERE id = ?', ctx.params.pid);
  if (!p) return json(res, 404, { error: '项目不存在' });
  const k = getKnowledge(p.id);
  if (!k) return json(res, 404, { error: '这个项目还没有沉淀知识库内容' });
  const chs = { tech: [], biz: [] };
  ['tech', 'biz'].forEach((kind) => {
    const src = (k.chapters && k.chapters[kind]) || null;
    (src && src.chapters ? src.chapters : []).forEach((c) => {
      chs[kind].push({ title: c.title, role: kind, body: c.body || '', charts: c.charts || [] });
    });
  });
  if (!chs.tech.length && !chs.biz.length) return json(res, 400, { error: '这个项目没有可提炼的章节内容' });
  if (!apiReady()) return json(res, 400, { error: '还没有填 DeepSeek API Key，没法提炼知识卡' });
  const t = startCardTask(p, chs, {});
  json(res, 200, { ok: true, taskId: t.id, task: getCardTask(t.id) });
});

route('GET', '/api/card-tasks/:id', async (req, res, ctx) => {
  const t = getCardTask(ctx.params.id);
  if (!t) return json(res, 404, { error: '任务不存在' });
  json(res, 200, t);
});

route('POST', '/api/knowledge/:pid/cards/add', async (req, res, ctx) => {
  const body = await readJson(req);
  const kind = body.kind === 'biz' ? 'biz' : 'tech';
  const c = addCard(ctx.params.pid, kind, body);
  json(res, 200, { ok: true, card: c });
});

route('PUT', '/api/knowledge/:pid/cards/:kind/:cardId', async (req, res, ctx) => {
  const body = await readJson(req);
  const kind = ctx.params.kind === 'biz' ? 'biz' : 'tech';
  const c = updateCard(ctx.params.pid, kind, ctx.params.cardId, body);
  if (!c) return json(res, 404, { error: '知识卡不存在' });
  json(res, 200, { ok: true, card: c });
});

route('DELETE', '/api/knowledge/:pid/cards/:kind/:cardId', async (req, res, ctx) => {
  const kind = ctx.params.kind === 'biz' ? 'biz' : 'tech';
  const ok = deleteCard(ctx.params.pid, kind, ctx.params.cardId);
  json(res, 200, { ok });
});

// ---------- v1.1.5：全局任务中心 ----------
// 页面切换、回首页、关掉标签再打开，都能从这里把还在跑的任务接回来。
function projNameOf(pid) {
  try { const p = get(db, 'SELECT name FROM projects WHERE id = ?', pid); return p ? p.name : ''; } catch { return ''; }
}

function activeTasksOf() {
  const out = [];
  try {
    listActiveTasks().forEach((t) => out.push({
      kind: 'analysis', kindLabel: '招标文件分析', id: t.taskId, projectId: t.projectId, projectName: projNameOf(t.projectId),
      state: t.state, message: t.message || '', step: t.step || 0, total: t.total || 0, startedAt: t.startedAt || ''
    }));
  } catch {}
  try {
    listCheckTasks().forEach((t) => out.push({
      kind: 'check', kindLabel: '投标文件核查', id: t.id, projectId: t.projectId, projectName: projNameOf(t.projectId),
      state: t.state, message: t.message || '', step: t.progress || 0, total: t.total || 0, startedAt: t.startedAt || ''
    }));
  } catch {}
  try {
    listDraftTasks().forEach((t) => out.push({
      kind: 'draft', kindLabel: '投标文件编制', id: t.id, projectId: t.projectId, projectName: projNameOf(t.projectId),
      state: t.state, message: t.message || '', step: 0, total: 0, startedAt: t.startedAt || ''
    }));
  } catch {}
  try {
    listCardTasks().forEach((t) => out.push({
      kind: 'cards', kindLabel: '知识卡提炼', id: t.id, projectId: t.projectId, projectName: t.projectName || projNameOf(t.projectId),
      state: t.state, message: t.message || '', step: t.progress || 0, total: t.total || 0, startedAt: t.startedAt || ''
    }));
  } catch {}
  backfillTasks.forEach((t) => {
    if (!t || t.state !== 'running') return;
    out.push({
      kind: 'backfill', kindLabel: '项目补录', id: t.id, projectId: t.projectId, projectName: projNameOf(t.projectId),
      state: t.state, message: t.message || '', step: t.step || 0, total: (t.steps || []).length || 6, startedAt: t.startedAt || ''
    });
  });
  return out.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
}

route('GET', '/api/tasks/active', async (req, res) => {
  json(res, 200, { ok: true, tasks: activeTasksOf(), serverTime: nowIso() });
});

// ---------- v1.1.5：关掉网页就自动关掉后台服务 ----------
// 每个页面开一个 clientId，每 15 秒报一次心跳；45 秒没心跳算这个页面关了。
// 全部页面都关掉后等 60 秒（防刷新误判），期间有新页面打开就取消；还有任务在跑就等它跑完（最长 30 分钟）。
const CLIENTS = new Map();       // clientId -> { at, ua }
const CLIENT_TTL = 45 * 1000;
const EXIT_GRACE = 60 * 1000;
const EXIT_MAX_WAIT = 30 * 60 * 1000;
let allGoneSince = 0;
let exitTimer = null;
let serverStartedAt = Date.now();

function aliveClients() {
  const now = Date.now();
  let n = 0;
  CLIENTS.forEach((c, k) => { if (now - c.at > CLIENT_TTL) CLIENTS.delete(k); else n++; });
  return n;
}

function runningTaskCount() {
  let n = 0;
  try { n += listActiveTasks().length; } catch {}
  try { n += listCheckTasks().length; } catch {}
  try { n += listDraftTasks().length; } catch {}
  try { n += listCardTasks().length; } catch {}
  backfillTasks.forEach((t) => { if (t && t.state === 'running') n++; });
  return n;
}

// 还没人连上过就不算「网页都关了」——刚启动、页面还没打开时不能自己退出
let everConnected = false;

function scheduleAutoExitCheck() {
  if (exitTimer) return;
  exitTimer = setInterval(() => {
    if (!loadConfig().autoExitOnClose) { allGoneSince = 0; return; }
    if (!everConnected) { allGoneSince = 0; return; }
    const n = aliveClients();
    if (n > 0) { allGoneSince = 0; return; }
    if (!allGoneSince) { allGoneSince = Date.now(); return; }
    const gone = Date.now() - allGoneSince;
    if (gone < EXIT_GRACE) return;
    const busy = runningTaskCount();
    if (busy > 0) {
      if (gone > EXIT_MAX_WAIT) { console.log('[TWB] 等任务超时，直接退出'); process.exit(0); }
      return;
    }
    console.log('[TWB] 网页已全部关闭，任务也都跑完了，自动退出');
    process.exit(0);
  }, 5000);
  if (exitTimer.unref) exitTimer.unref();
}

route('POST', '/api/heartbeat', async (req, res) => {
  const body = await readJson(req);
  const cid = String(body.clientId || '').slice(0, 80);
  if (cid) {
    CLIENTS.set(cid, { at: Date.now(), ua: String(req.headers['user-agent'] || '').slice(0, 120) });
    everConnected = true;
    allGoneSince = 0;
  }
  json(res, 200, { ok: true, clients: aliveClients(), autoExit: !!loadConfig().autoExitOnClose, running: runningTaskCount() });
});

route('POST', '/api/client-leave', async (req, res) => {
  const body = await readJson(req);
  const cid = String(body.clientId || '').slice(0, 80);
  if (cid) CLIENTS.delete(cid);
  json(res, 200, { ok: true, clients: aliveClients() });
});

route('GET', '/api/clients', async (req, res) => {
  json(res, 200, { ok: true, clients: aliveClients(), running: runningTaskCount(), autoExit: !!loadConfig().autoExitOnClose, startedAt: new Date(serverStartedAt).toISOString() });
});

// ---------- 静态文件 ----------
function serveStatic(req, res, urlPath) {
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.join(WEB_DIR, urlPath.replace(/^\/+/, ''));
  if (!file.startsWith(WEB_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

// 归档只读：除这些动作外，归档项目上的一切写操作都拒绝
const RO_ALLOW = [
  /^\/api\/projects\/[^/]+\/reopen$/,
  /\/export$/,            // 导出报告/Word/清单照常可用
  /\/indep\/export$/      // 独立编制导出 Word 照常可用
];
function readOnlyBlock(method, pathname, pid) {
  const p = get(db, 'SELECT status FROM projects WHERE id = ?', pid);
  if (!p || p.status !== 'archived') return null;
  if (RO_ALLOW.some((rx) => rx.test(pathname))) return null;
  // v1.1.3：归档项目也允许「删除项目」（只放 DELETE，改项目信息仍然拦住）
  if (method === 'DELETE' && /^\/api\/projects\/[^/]+$/.test(pathname)) return null;
  return { error: '这个项目已经关闭归档了，只能查看。要修改请先点「重新打开」。', code: 'ARCHIVED_READONLY' };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const pathname = decodeURIComponent(url.pathname);
  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);
  const query = Object.fromEntries(url.searchParams);
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.rx.exec(pathname);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    // v1.1.2：归档后的项目一律只读（查看/导出/打开文件夹/重新打开除外）
    if (req.method !== 'GET' && params.id && params.id.startsWith('p_')) {
      const ro = readOnlyBlock(req.method, pathname, params.id);
      if (ro) return json(res, 403, ro);
    }
    try {
      return await r.handler(req, res, { params, query });
    } catch (e) {
      console.error(e);
      const code = Number(e && e.status) || 500;
      if (!res.headersSent) return json(res, code, { error: String(e && e.message || e), code: (e && e.code) || '' });
      try { res.end(); } catch {}
      return;
    }
  }
  json(res, 404, { error: '接口不存在: ' + pathname });
});

const port = Number(process.env.TWB_PORT || cfg.port || 7830);
server.listen(port, '127.0.0.1', () => {
  console.log('TWB_READY http://127.0.0.1:' + port);
  serverStartedAt = Date.now();
  // v1.1.5：关掉网页就自动关掉后台服务
  try { scheduleAutoExitCheck(); } catch (e) { console.log('[TWB] 自动退出没启动：' + (e && e.message || e)); }
});