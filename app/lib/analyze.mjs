import fs from 'node:fs';
import { detectOcr } from './ocr.mjs';
import path from 'node:path';
import { DATA_DIR, ROOT } from './config.mjs';
import { all, get, run, addEvent } from './db.mjs';
import { ensureText, ocrPages, writeTextCache } from './text.mjs';
import { callJson, apiReady } from './ai.mjs';
import { SYSTEM_ANALYSIS, analysisUserPrompt, SYSTEM_SCORE, scoreUserPrompt, SECTIONS } from './prompt.mjs';
import { uid, nowIso } from './util.mjs';
import { scanFatalCandidates } from './fatalScan.mjs';

export const ANALYSIS_DIR = path.join(DATA_DIR, '分析');
const TASKS_DIR = path.join(ANALYSIS_DIR, '.tasks');

const SEG_PAGES = 16;   // 每段最多页数
const OVERLAP = 1;      // 段间重叠页数
const MAX_PAGES = 200;  // 单次分析的页数上限
const DEDUP = 0.86;            // 跨页去重：要求高度相似
const DEDUP_SAME_PAGE = 0.78;  // 同页去重：措辞微差也算同一条

export function ensureAnalysisDirs() {
  fs.mkdirSync(ANALYSIS_DIR, { recursive: true });
  fs.mkdirSync(TASKS_DIR, { recursive: true });
}

function analysisFile(projectId) { return path.join(ANALYSIS_DIR, projectId + '.json'); }
function taskFile(taskId) { return path.join(TASKS_DIR, taskId + '.json'); }

export function loadAnalysis(projectId) {
  const f = analysisFile(projectId);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

export function saveAnalysis(projectId, data) {
  ensureAnalysisDirs();
  fs.writeFileSync(analysisFile(projectId), JSON.stringify(data, null, 1), 'utf8');
}

// ---------- 任务态 ----------
const tasks = new Map();       // taskId -> 任务对象
const runningByProject = new Map(); // projectId -> taskId

function persistTask(t) {
  ensureAnalysisDirs();
  try { fs.writeFileSync(taskFile(t.taskId), JSON.stringify(t), 'utf8'); } catch {}
}

export function getTask(taskId) {
  if (tasks.has(taskId)) return tasks.get(taskId);
  const f = taskFile(taskId);
  if (fs.existsSync(f)) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch {} }
  return null;
}

export function runningTaskOf(projectId) {
  const id = runningByProject.get(projectId);
  return id ? getTask(id) : null;
}

// v1.1.5：列出所有还在跑的分析任务（首页任务中心用）
export function listActiveTasks() {
  const out = [];
  tasks.forEach((t) => { if (t && t.state === 'running') out.push(t); });
  return out;
}

// ---------- 工具 ----------
function normalize(s) {
  return String(s || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[\u3001\u3002\uff0c\uff1b\uff1a\uff01\uff1f\uff08\uff09\u3010\u3011\u2018\u2019\u201c\u201d,.;:!?()\[\]"']/g, '');
}

function bigrams(s) {
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  if (s.length === 1) set.add(s);
  return set;
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

// 同一页上的两条，措辞差一两个字基本就是同一句（常见于分段重叠时被抽了两次），阈值放宽；
// 不同页则要求高度相似才算重复，避免把「报价函/报价一览表/分项报价表」这类不同表格误合并。
function isDuplicate(a, b, samePage) {
  const t = samePage ? DEDUP_SAME_PAGE : DEDUP;
  return similarity(a, b) >= t;
}

function itemKey(it, sectionKey) {
  // 评分表：同一个评分项（名称+分值）只会有一行，描述写得再不一样也算同一条，
  // 否则「分段抽取 + 评分表补跑」两趟会各贴一遍。
  if (sectionKey === 'score' && it.cells && it.cells.length >= 3) {
    return normalize(String(it.cells[1] || '') + '|' + String(it.cells[2] || ''));
  }
  if (it.cells && it.cells.length) return normalize(it.cells.join('|'));
  return normalize(it.text);
}

function makeItem(raw, sectionKey, source) {
  const cells = Array.isArray(raw.cells) ? raw.cells.map((c) => String(c == null ? '' : c).trim()) : null;
  const text = String(raw.text || '').trim();
  return {
    id: uid('a_'),
    text: cells ? (cells[cells.length - 1] || '') : text,
    cells: cells,
    page: Number.isFinite(Number(raw.page)) && Number(raw.page) > 0 ? Number(raw.page) : null,
    quote: String(raw.quote || '').trim().slice(0, 400),
    isStar: !!raw.isStar,
    isFatal: !!raw.isFatal,
    category: String(raw.category || '').trim(),
    confirmed: false,
    edited: false,
    pageCheck: '',
    source: source || 'ai'
  };
}

function emptySections() {
  return SECTIONS.map((s) => ({ key: s.key, title: s.title, group: s.group, type: s.type, columns: s.columns || null, danger: !!s.danger, items: [] }));
}

// ---------- 主流程 ----------
export function startAnalysis(db, projectId, opts) {
  if (!apiReady()) throw new Error('需要先填写 DeepSeek API Key（左下角「设置」）');
  const running = runningByProject.get(projectId);
  if (running) return getTask(running);

  const p = get(db, 'SELECT * FROM projects WHERE id = ?', projectId);
  if (!p) throw new Error('项目不存在');

  const task = {
    taskId: uid('t_'),
    projectId,
    state: 'running',
    step: 0,
    total: 0,
    segIndex: 0,
    segTotal: 0,
    message: '正在准备…',
    sections: {},
    failedSegments: [],
    truncated: false,
    error: '',
    errorCode: '',
    startedAt: nowIso(),
    finishedAt: ''
  };
  tasks.set(task.taskId, task);
  runningByProject.set(projectId, task.taskId);
  persistTask(task);

  runAnalysis(db, p, task, opts || {}).catch((e) => {
    task.state = 'failed';
    task.errorCode = (e && e.code) || '';
    task.error = String((e && e.message) || e);
    task.message = '分析失败：' + task.error;
    task.finishedAt = nowIso();
    persistTask(task);
    runningByProject.delete(projectId);
  });

  return task;
}

function segmentPages(pageCount) {
  const segs = [];
  let start = 1;
  while (start <= pageCount) {
    const end = Math.min(start + SEG_PAGES - 1, pageCount);
    segs.push([start, end]);
    if (end >= pageCount) break;
    start = end - OVERLAP + 1;
    if (start < 1) start = 1;
  }
  return segs;
}

async function runAnalysis(db, p, task, opts) {
  ensureAnalysisDirs();
  const local = detectOcr();

  // 1) 选招标文件
  let f = null;
  if (opts.fileId) f = get(db, 'SELECT * FROM files WHERE id = ? AND projectId = ?', opts.fileId, p.id);
  if (!f) f = get(db, "SELECT * FROM files WHERE projectId = ? AND stage = 'tender' AND (role = 'tenderFile' OR role = 'fromArchive') ORDER BY (role = 'tenderFile') DESC, uploadedAt ASC LIMIT 1", p.id);
  if (!f) throw new Error('还没有上传招标文件，请先到「招标文件」页签上传');
  const filePath = path.join(ROOT, f.relPath);
  if (!fs.existsSync(filePath)) throw new Error('招标文件已不在磁盘：' + f.originalName);

  task.message = '正在读取文件文字…';
  persistTask(task);

  let cache = await ensureText(f, filePath);
  run(db, 'UPDATE files SET pages = ?, textChars = ?, extracted = 1 WHERE id = ?', cache.pageCount, cache.chars, f.id);

  // 页数兜底：老缓存可能已损坏（pageCount=0 但 pages 有内容）
  if (!cache.pageCount && cache.pages && cache.pages.length) cache.pageCount = cache.pages.length;

  // 扫描件先识别前 12 页，判断能否自动分析
  if (cache.scanned || cache.chars < 200) {
    task.message = local.available ? '这份文件像是扫描件，正在用本机 OCR 识别…' : '这份文件像是扫描件，正在用 AI 读图…';
    persistTask(task);
    const probe = Math.max(1, Math.min(cache.pageCount || 12, 12));
    const pages = [];
    for (let i = 1; i <= probe; i++) pages.push(i);
    const r = await ocrPages(f, filePath, pages);
    cache = r.cache;
    if (cache.chars < 200) {
      const e = new Error(local.available
        ? '这份文件是图片扫描件，本机 OCR 也没能识别出文字。可以换一份更清晰的扫描件，或到「招标文件」页签挑页手动识别。'
        : '这份文件是图片扫描件，这台电脑暂时没有可用的文字识别工具。到「设置」页点「安装识别工具」，装好后会自动重新识别。');
      e.code = local.available ? 'OCR_EMPTY' : 'NO_OCR_TOOL';
      throw e;
    }
  }

  const pageCount = cache.pageCount || (cache.pages || []).length;
  if (!pageCount) {
    throw new Error('这份招标文件没能识别出页数，无法分析。请到「招标文件」页签重新上传一次；如果反复失败，把它另存为可复制文字的 PDF 再上传。');
  }
  const limit = Math.min(pageCount, opts.maxPages || MAX_PAGES);
  task.truncated = pageCount > limit;

  // 关键词预扫描：先把「废标信号词」原句捞出来，逐段递给 AI 判语义，最后再补齐漏掉的
  task.message = '正在扫描废标项关键词…';
  persistTask(task);
  const fatalCand = scanFatalCandidates(cache.pages, { maxPages: limit });

  const segs = segmentPages(limit);
  if (!segs.length) throw new Error('这份招标文件没有可读内容（共 ' + pageCount + ' 页），无法分析。');
  task.segTotal = segs.length;
  task.total = segs.length + 1; // +1 是评分表补跑
  persistTask(task);

  // 2) 逐段抽取
  const merged = emptySections();
  const byKey = new Map(merged.map((s) => [s.key, s]));

  for (let i = 0; i < segs.length; i++) {
    const [a, b] = segs[i];
    task.segIndex = i + 1;
    task.step = i;
    task.message = '正在读第 ' + a + '-' + b + ' 页（' + (i + 1) + '/' + segs.length + '）';
    persistTask(task);

    const text = cache.pages
      .filter((pg) => pg.page >= a && pg.page <= b && pg.text && pg.text.trim())
      .map((pg) => '【第 ' + pg.page + ' 页】\n' + pg.text.trim())
      .join('\n\n');

    if (text.trim().length < 20) { task.failedSegments.push({ from: a, to: b, error: '这几页没有文字' }); continue; }

    let out = null;
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const segCand = {
          strong: fatalCand.strong.filter((s) => s.page >= a && s.page <= b),
          weak: fatalCand.weak.filter((s) => s.page >= a && s.page <= b).slice(0, 40)
        };
        out = await callJson(SYSTEM_ANALYSIS, analysisUserPrompt(text, segCand), { maxTokens: 12000, timeoutMs: 300000 });
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (attempt < 3) {
          task.message = '第 ' + a + '-' + b + ' 页没读成功，正在重试（第 ' + attempt + ' 次）';
          persistTask(task);
          await new Promise((res) => setTimeout(res, 1500 * attempt));
        }
      }
    }
    if (!out) {
      task.failedSegments.push({ from: a, to: b, error: String((lastErr && lastErr.message) || lastErr) });
      continue;
    }

    const arr = Array.isArray(out && out.sections) ? out.sections : [];
    for (const sec of arr) {
      const target = byKey.get(String(sec.key || '').trim());
      if (!target || !Array.isArray(sec.items)) continue;
      for (const raw of sec.items) {
        if (!raw) continue;
        const it = makeItem(raw, target.key, 'ai');
        const k = itemKey(it, target.key);
        if (!k) continue;
        const dup = target.items.find((x) => isDuplicate(itemKey(x, target.key), k, x.page != null && it.page != null && x.page === it.page));
        if (dup) {
          if (it.isStar) dup.isStar = true;
          if (it.isFatal) dup.isFatal = true;
          if (dup.page == null && it.page != null) { dup.page = it.page; dup.quote = it.quote; }
          continue;
        }
        target.items.push(it);
      }
    }
    persistTask(task);
  }

  // 2.5) 关键词补漏：规则扫出来、AI 又没收进废标板块的原句，直接补进去
  let ruleAdded = 0;
  const fatalSec = byKey.get('fatal');
  if (fatalSec) {
    for (const s of fatalCand.strong) {
      const key = normalize(s.text);
      if (!key) continue;
      const hit = fatalSec.items.some((it) => {
        const t = itemKey(it, 'fatal');
        return t === key || similarity(t, key) >= 0.55;
      });
      if (hit) continue;
      fatalSec.items.push(makeItem({
        text: s.text,
        page: s.page,
        quote: s.text.slice(0, 400),
        isFatal: true,
        isStar: !!s.star,
        category: '关键词扫描'
      }, 'fatal', 'rule-scan'));
      ruleAdded++;
    }
    fatalSec.items.sort((x, y) => (x.page || 99999) - (y.page || 99999));
  }

  // 3) 评分表补跑
  task.step = segs.length;
  task.message = '正在单独核对评分表…';
  persistTask(task);
  try {
    // 只挑和"评分"有关的页（命中关键词的页 ±1 页），避免整本塞进去把输出额度耗光
    const hits = new Set();
    for (const pg of cache.pages) {
      if (pg.page > limit || !pg.text) continue;
      if (/评分|分值|得分|打分|评审因素|评分标准|综合评分法|最低评标价法/.test(pg.text)) {
        for (let k = pg.page - 1; k <= pg.page + 1; k++) if (k >= 1 && k <= limit) hits.add(k);
      }
    }
    let scoreText = cache.pages
      .filter((pg) => hits.has(pg.page) && pg.text && pg.text.trim())
      .map((pg) => '【第 ' + pg.page + ' 页】\n' + pg.text.trim())
      .join('\n\n');
    if (!scoreText) {
      scoreText = cache.pages
        .filter((pg) => pg.page <= limit && pg.text && pg.text.trim())
        .map((pg) => '【第 ' + pg.page + ' 页】\n' + pg.text.trim())
        .join('\n\n');
    }
    if (scoreText.length > 60000) scoreText = scoreText.slice(0, 60000);
    const sc = await callJson(SYSTEM_SCORE, scoreUserPrompt(scoreText), { maxTokens: 10000, timeoutMs: 300000 });
    const target = byKey.get('score');
    if (target && Array.isArray(sc && sc.items)) {
      for (const raw of sc.items) {
        const it = makeItem(raw, 'score', 'ai-score');
        const k = itemKey(it, 'score');
        if (!k) continue;
        const dup = target.items.find((x) => isDuplicate(itemKey(x, 'score'), k, x.page != null && it.page != null && x.page === it.page));
        if (dup) continue;
        target.items.push(it);
      }
    }
  } catch (e) {
    task.failedSegments.push({ from: 0, to: 0, error: '评分表补跑失败：' + String((e && e.message) || e) });
  }

  // 4) 页码校验 + 排序
  for (const sec of merged) {
    for (const it of sec.items) {
      if (it.page != null && (it.page < 1 || it.page > pageCount)) {
        it.pageCheck = '待核（原页码 ' + it.page + ' 超出文件页数）';
        it.page = null;
      }
      if (it.page == null && !it.pageCheck) it.pageCheck = '待核（AI 未给出页码）';
    }
    sec.items.sort((x, y) => (x.page || 99999) - (y.page || 99999));
  }

  // 5) 落盘
  const stat = {};
  for (const sec of merged) stat[sec.key] = sec.items.length;
  const starCount = merged.reduce((n, s) => n + s.items.filter((i) => i.isStar).length, 0);
  const fatalCount = merged.filter((s) => s.key === 'fatal').reduce((n, s) => n + s.items.length, 0);

  const data = {
    projectId: p.id,
    fileId: f.id,
    fileName: f.originalName,
    pageCount,
    analyzedPages: limit,
    truncated: task.truncated,
    sections: merged,
    stat,
    starCount,
    fatalCount,
    fatalScan: { strong: fatalCand.counts.strong, weak: fatalCand.counts.weak, scanned: fatalCand.counts.scanned, added: ruleAdded },
    failedSegments: task.failedSegments,
    analysisAt: nowIso()
  };

  if (opts.force !== false) {
    const old = analysisFile(p.id);
    if (fs.existsSync(old)) {
      try { fs.renameSync(old, old.replace(/\.json$/, '.bak-' + Date.now() + '.json')); } catch {}
    }
  }
  saveAnalysis(p.id, data);

  run(db, 'UPDATE projects SET analysisAt = ?, analysisStat = ?, updatedAt = ? WHERE id = ?',
    data.analysisAt, JSON.stringify({ stat, starCount, fatalCount }), nowIso(), p.id);
  addEvent(db, p.id, 'analysis', '完成招标分析：星号 ' + starCount + ' 条，废标 ' + fatalCount + ' 条（其中关键词扫描补入 ' + ruleAdded + ' 条），共 ' + Object.values(stat).reduce((a, b) => a + b, 0) + ' 条');

  task.state = task.failedSegments.length ? 'partial' : 'done';
  task.step = task.total;
  task.sections = stat;
  task.message = task.state === 'done' ? '分析完成' : '分析完成，但有 ' + task.failedSegments.length + ' 处需要重跑';
  task.finishedAt = nowIso();
  persistTask(task);
  runningByProject.delete(p.id);
}