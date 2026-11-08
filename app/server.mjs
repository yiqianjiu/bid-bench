import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, ensureDirs, WEB_DIR, DATA_DIR, UPLOAD_DIR, PROJECT_DIR, ARCHIVE_DIR, ROOT, saveConfig } from './lib/config.mjs';
import { openDb, all, get, run, addEvent } from './lib/db.mjs';
import { uid, sha256, nowIso, safeName, shortName } from './lib/util.mjs';
import { extractArchive, listFilesRecursive, renderPdfPages, docToDocx, extractDocxText } from './lib/extract.mjs';
import { ensureText, readTextCache, ocrPages, buildFullText, ensureTextDirs } from './lib/text.mjs';
import { callJson, apiReady } from './lib/ai.mjs';
import { SYSTEM_META, metaUserPrompt, SECTIONS } from './lib/prompt.mjs';
import { startAnalysis, getTask, loadAnalysis, saveAnalysis, runningTaskOf, ensureAnalysisDirs } from './lib/analyze.mjs';
import { exportAnalysisDocx } from './lib/exportAnalysis.mjs';
import { ensureDraft, saveDraft, setMode, refreshTables, startOutlineTask, startChapterTask, getDraftTask, DOC_META, ensureDraftDirs, applyUploadedOutline, restoreAutoOutline } from './lib/draft.mjs';
import { parseDocxOutline } from './lib/docxOutline.mjs';
import { exportDraftDocx } from './lib/exportDraft.mjs';
import { loadCheck, saveCheck, listSources, startCheckTask, getCheckTask, ensureCheckDirs } from './lib/check.mjs';
import { exportCheckDocx } from './lib/exportCheck.mjs';
import { GROUPS, ensureSubmit, rebuildSubmit, saveSubmit, loadSubmit, ensureSubmitDirs } from './lib/submit.mjs';
import { exportSubmitDocx } from './lib/exportSubmit.mjs';
import { archiveProject, listArchives } from './lib/archive.mjs';

const cfg = loadConfig();
ensureDirs();
ensureTextDirs();
const db = openDb(path.join(DATA_DIR, 'workbench.db'));
ensureAnalysisDirs();
ensureDraftDirs();
ensureCheckDirs();
ensureSubmitDirs();

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
    hasKey: !!cfg.deepseekApiKey, company: cfg.company || ''
  });
});

route('POST', '/api/settings', async (req, res) => {
  const body = await readJson(req);
  const patch = {};
  if (typeof body.deepseekApiKey === 'string' && body.deepseekApiKey.trim() && !body.deepseekApiKey.includes('****')) patch.deepseekApiKey = body.deepseekApiKey.trim();
  if (typeof body.company === 'string') patch.company = body.company.trim();
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
  run(db, 'INSERT INTO projects (id, code, autoCode, name, owner, agency, budget, bidDeadline, openTime, openPlace, deposit, purchaseMethod, packageNo, company, notes, status, dir, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    id, tenderCode, autoCode, name, body.owner || '', body.agency || '', body.budget || '', body.bidDeadline || '', body.openTime || '',
    body.openPlace || '', body.deposit || '', body.purchaseMethod || '', body.packageNo || '', body.company || '',
    body.notes || '', 'active', dir, now, now);
  fs.mkdirSync(path.join(PROJECT_DIR, dir), { recursive: true });
  for (const sub of Object.values(STAGE_MAP)) fs.mkdirSync(path.join(PROJECT_DIR, dir, sub), { recursive: true });
  addEvent(db, id, 'create', '新建项目 ' + name);
  json(res, 200, { ok: true, id, autoCode, dir });
});

route('GET', '/api/projects/:id', async (req, res, ctx) => {
  const p = projectDetail(ctx.params.id);
  if (!p) return json(res, 404, { error: '项目不存在' });
  json(res, 200, p);
});

const EDITABLE = ['code', 'name', 'owner', 'agency', 'budget', 'bidDeadline', 'openTime', 'openPlace', 'deposit', 'purchaseMethod', 'packageNo', 'company', 'notes'];

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

route('DELETE', '/api/projects/:id', async (req, res, ctx) => {
  const p = get(db, 'SELECT * FROM projects WHERE id = ?', ctx.params.id);
  if (!p) return json(res, 404, { error: '项目不存在' });
  run(db, 'DELETE FROM files WHERE projectId = ?', p.id);
  run(db, 'DELETE FROM events WHERE projectId = ?', p.id);
  run(db, 'DELETE FROM projects WHERE id = ?', p.id);
  const dir = projectDirOf(p);
  if (dir.startsWith(PROJECT_DIR) && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  json(res, 200, { ok: true });
});

// ---------- 文件 ----------
const TEXT_EXT = ['.pdf', '.docx', '.doc'];

route('POST', '/api/projects/:id/files', async (req, res, ctx) => {
  const p = get(db, 'SELECT * FROM projects WHERE id = ?', ctx.params.id);
  if (!p) return json(res, 404, { error: '项目不存在' });
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
      return json(res, 400, { error: '这份文件像是扫描件，AI 读图失败：' + String(e && e.message || e) });
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
  json(res, 200, { ok: true, draft: d, hasAnalysis: !!an, analysisAt: an ? an.analysisAt : null, apiReady: apiReady() });
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
  json(res, 200, { ok: true, chapters: doc.chapters.length - 2 });
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
    apiReady: apiReady()
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
route('POST', '/api/projects/:id/close', async (req, res, ctx) => {
  const p = get(db, 'SELECT * FROM projects WHERE id = ?', ctx.params.id);
  if (!p) return json(res, 404, { error: '项目不存在' });
  if (p.status === 'archived') return json(res, 400, { error: '这个项目已经关闭归档了' });
  const body = await readJson(req);
  try {
    const r = archiveProject(p, db, { note: body.note || '' });
    run(db, 'UPDATE projects SET status = ?, closedAt = ?, archiveNote = ?, updatedAt = ? WHERE id = ?',
      'archived', nowIso(), (body.note || '') + '||' + r.relDir, nowIso(), p.id);
    addEvent(db, p.id, 'archive', '项目关闭并归档到 ' + r.relDir);
    json(res, 200, { ok: true, dir: r.dir, relDir: r.relDir, files: r.files });
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
  json(res, 200, { ok: true, archives: listArchives(), root: ARCHIVE_DIR });
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

// ---------- 静态文件 ----------
function serveStatic(req, res, urlPath) {
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.join(WEB_DIR, urlPath.replace(/^\/+/, ''));
  if (!file.startsWith(WEB_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
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
    try {
      return await r.handler(req, res, { params, query });
    } catch (e) {
      console.error(e);
      if (!res.headersSent) return json(res, 500, { error: String(e && e.message || e) });
      try { res.end(); } catch {}
      return;
    }
  }
  json(res, 404, { error: '接口不存在: ' + pathname });
});

const port = Number(process.env.TWB_PORT || cfg.port || 7830);
server.listen(port, '127.0.0.1', () => {
  console.log('TWB_READY http://127.0.0.1:' + port);
});