// v1.1.0 本地专家知识库
// 只在「项目关闭归档」时写入，作为技术/商务 AI 专家的本地经验积累；
// 新项目生成画像时按相似度取少量历史经验作参考（辅助，不替代招标文件）。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';
import { buildCardReferenceBlock, listCards, removeCards, readCards, saveCards, ensureCardDirs, CARD_TYPES, TYPE_NAME } from './cards.mjs';
import { nowIso } from './util.mjs';

export const KB_DIR = path.join(DATA_DIR, '知识库');
const IDX_FILE = path.join(KB_DIR, 'index.json');
const DIR_PROFILE = { tech: path.join(KB_DIR, '专家画像', '技术'), biz: path.join(KB_DIR, '专家画像', '商务') };
const DIR_CHAPTER = { tech: path.join(KB_DIR, '章节', '技术'), biz: path.join(KB_DIR, '章节', '商务') };
const DIR_HISTORY = path.join(KB_DIR, '生成历史');

export function ensureKb() {
  [KB_DIR, DIR_PROFILE.tech, DIR_PROFILE.biz, DIR_CHAPTER.tech, DIR_CHAPTER.biz, DIR_HISTORY, path.join(KB_DIR, '独立编制')]
    .forEach((d) => fs.mkdirSync(d, { recursive: true }));
  try { ensureCardDirs(); } catch {}
}

function readJson(f, dft) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dft; }
}
function writeJson(f, v) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(v, null, 2), 'utf8');
}

export function loadIndex() {
  ensureKb();
  const idx = readJson(IDX_FILE, null);
  if (!idx || !Array.isArray(idx.projects)) return { version: 1, updatedAt: nowIso(), projects: [] };
  return idx;
}
export function saveIndex(idx) {
  idx.updatedAt = nowIso();
  writeJson(IDX_FILE, idx);
  return idx;
}

/* ---------- 关键词与相似度 ---------- */
const STOP = /[的了和与及或在为是对将把从到按等及其该项本份个条]/g;
function tokens(s) {
  const t = String(s || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').replace(STOP, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}
function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  a.forEach((x) => { if (b.has(x)) n++; });
  return n / Math.min(a.size, b.size);
}

// 从项目 + 画像里抽一组关键词，用于判断「新项目像不像历史项目」
export function keywordsOf(project, profiles) {
  const L = [];
  L.push(project.name || '');
  if (project.purchaseMethod) L.push(project.purchaseMethod);
  ['tech', 'biz'].forEach((k) => {
    const p = profiles && profiles[k] && profiles[k].data;
    if (!p) return;
    if (p.direction) L.push(p.direction);
    if (k === 'tech' && p.stack) p.stack.slice(0, 8).forEach((x) => L.push(x.stage || ''));
  });
  const set = tokens(L.join(' '));
  return [...set].slice(0, 400);
}

/* ---------- 写入：归档时调用 ---------- */
// chapters: [{ title, role, body, words }]
export function saveProjectKnowledge(project, payload) {
  ensureKb();
  const pid = project.id;
  const idx = loadIndex();
  const rec = {
    projectId: pid,
    name: project.name || '',
    code: project.code || '',
    owner: project.owner || '',
    purchaseMethod: project.purchaseMethod || '',
    year: String(project.createdAt || nowIso()).slice(0, 4),
    archivedAt: nowIso(),
    direction: {},
    keywords: payload.keywords || [],
    counts: { tech: 0, biz: 0 },
    chartCounts: { table: 0, image: 0 },
    hasProfile: { tech: false, biz: false }
  };

  ['tech', 'biz'].forEach((kind) => {
    const prof = payload.profiles && payload.profiles[kind];
    if (prof && prof.data && (prof.data.summary || prof.data.direction)) {
      writeJson(path.join(DIR_PROFILE[kind], pid + '.json'), {
        projectId: pid, projectName: project.name || '', code: project.code || '',
        purchaseMethod: project.purchaseMethod || '', archivedAt: rec.archivedAt,
        confirmed: !!prof.confirmed, data: prof.data, revisions: prof.revisions || []
      });
      rec.hasProfile[kind] = true;
      rec.direction[kind] = (prof.data.direction || '').slice(0, 80);
    }
    const chs = (payload.chapters && payload.chapters[kind]) || [];
    if (chs.length) {
      writeJson(path.join(DIR_CHAPTER[kind], pid + '.json'), {
        projectId: pid, projectName: project.name || '', kind, archivedAt: rec.archivedAt,
        chapters: chs
      });
      rec.counts[kind] = chs.length;
      const cc = countCharts(chs);
      rec.chartCounts.table += cc.table;
      rec.chartCounts.image += cc.image;
    }
  });

  // v1.1.2：独立编制会话存档（对话 + 成稿 + 图表说明），跟着项目一起进知识库
  if (payload.sessions && payload.sessions.length) {
    writeJson(path.join(KB_DIR, '独立编制', pid + '.json'), {
      projectId: pid, projectName: project.name || '', code: project.code || '',
      archivedAt: rec.archivedAt, sessions: payload.sessions
    });
    rec.counts.indep = payload.sessions.length;
  }

  if (payload.history && payload.history.length) {
    writeJson(path.join(DIR_HISTORY, pid + '.json'), {
      projectId: pid, projectName: project.name || '', archivedAt: rec.archivedAt, records: payload.history
    });
    rec.counts.history = payload.history.length;
  }

  // v1.1.1：什么都没写进去（没有标注重要章节、也没有画像）就不要在索引里留一条空记录，
  // 否则列表里会出现「文件缺失」的假告警。
  const wroteAnything = rec.hasProfile.tech || rec.hasProfile.biz || rec.counts.tech || rec.counts.biz ||
    rec.counts.indep || (payload.history && payload.history.length);
  idx.projects = (idx.projects || []).filter((x) => x.projectId !== pid);
  if (!wroteAnything) { saveIndex(idx); return null; }
  idx.projects.push(rec);
  saveIndex(idx);
  return rec;
}

/* ---------- 读取：新项目生成画像时取参考 ---------- */
export function findSimilar(project, kind, limit) {
  const idx = loadIndex();
  const cur = keywordsOf(project, null);
  const curSet = new Set(cur);
  const scored = [];
  (idx.projects || []).forEach((r) => {
    const same = r.purchaseMethod && project.purchaseMethod && r.purchaseMethod === project.purchaseMethod;
    const ov = overlap(curSet, new Set(r.keywords || []));
    let sc = ov * 0.75 + (same ? 0.35 : 0);
    if (!r.hasProfile || !r.hasProfile[kind]) sc -= 0.1;
    if (sc > 0.12) scored.push({ rec: r, sc });
  });
  scored.sort((a, b) => b.sc - a.sc);
  return scored.slice(0, limit || 3).map((x) => x.rec);
}

function readProfile(kind, pid) { return readJson(path.join(DIR_PROFILE[kind], pid + '.json'), null); }
function readChapters(kind, pid) { return readJson(path.join(DIR_CHAPTER[kind], pid + '.json'), null); }

// 生成给提示词用的一段「历史经验参考」
export function buildReferenceBlock(project, kind, limit, keywords) {
  // v1.2.0：知识卡优先——直接给「可复用的做法」，画像只作为背景补充
  let cardText = '';
  let cardUsed = [];
  try {
    // v1.2.0 修正：knowledge.mjs 里没有 loadProfiles，改用本地 readProfile 组装，否则这里会抛错把知识卡整段吞掉
    const profs = { tech: readProfile('tech', project.id), biz: readProfile('biz', project.id) };
    const kw = keywords || keywordsOf(project, profs);
    const r = buildCardReferenceBlock(project, kind, new Set(kw), { perType: 2 });
    cardText = r.text;
    cardUsed = r.used;
  } catch (e) { cardText = ''; }
  const list = findSimilar(project, kind, limit || 3);
  if (!list.length) return { text: '', used: [] };
  const used = [];
  const L = [];
  L.push('【历史经验参考（来自本工作台已完成的其他投标项目，仅供参考）】');
  L.push('注意：下面这些是你以前做过的项目留下的经验，只能借鉴「这类项目一般怎么做、要覆盖哪些环节、评委关心什么」；');
  L.push('绝对不得把它们的项目名称、招标人、金额、指标数值、具体业绩搬进本章。本章一切以本题招标文件原文为准。');
  list.forEach((rec, i) => {
    const prof = readProfile(kind, rec.projectId);
    const chs = readChapters(kind, rec.projectId);
    const lines = [];
    lines.push('— 参考项目 ' + (i + 1) + '：' + (rec.name || '') + (rec.purchaseMethod ? '（' + rec.purchaseMethod + '）' : '') + (rec.year ? '，' + rec.year + ' 年' : ''));
    if (prof && prof.data) {
      const d = prof.data;
      if (d.direction) lines.push('  该项目的' + (kind === 'tech' ? '技术' : '商务') + '方向：' + d.direction);
      if (kind === 'tech' && d.stack && d.stack.length) lines.push('  当时覆盖的技术环节：' + d.stack.map((x) => x.stage).filter(Boolean).join('、'));
      if (kind === 'tech' && d.focus && d.focus.length) lines.push('  当时的评分关注点：' + d.focus.slice(0, 4).join('；'));
      if (kind === 'biz' && d.bizLogic) lines.push('  当时的商务逻辑：' + String(d.bizLogic).slice(0, 160));
      if (kind === 'biz' && d.mgmtLogic) lines.push('  当时的管理逻辑：' + String(d.mgmtLogic).slice(0, 160));
      if (kind === 'biz' && d.boundary && d.boundary.length) lines.push('  当时注意的承诺边界：' + d.boundary.slice(0, 3).join('；'));
    }
    if (chs && chs.chapters && chs.chapters.length) {
      const heads = chs.chapters.slice(0, 6).map((c) => c.title).filter(Boolean);
      if (heads.length) lines.push('  当时这类内容的章节：' + heads.join('、'));
    }
    if (lines.length > 1) { L.push(lines.join('\n')); used.push({ projectId: rec.projectId, name: rec.name }); }
  });
  if (!used.length) return { text: cardText, used: cardUsed, cards: cardUsed };
  const profileText = L.join('\n');
  const text = cardText ? (cardText + '\n\n' + profileText) : profileText;
  return { text, used: used.concat(cardUsed), cards: cardUsed };
}

/* ---------- v1.2.0：知识卡数量回写索引 ---------- */
export function syncCardCount(pid, counts) {
  try {
    const idx = loadIndex();
    const rec = (idx.projects || []).find((x) => x.projectId === pid);
    if (!rec) return null;
    rec.cardCounts = { tech: Number(counts && counts.tech) || 0, biz: Number(counts && counts.biz) || 0 };
    rec.cardsAt = nowIso();
    saveIndex(idx);
    return rec.cardCounts;
  } catch { return null; }
}

/* ---------- 管理界面 ---------- */
export function listKnowledge() {
  const idx = loadIndex();
  const projects = (idx.projects || []).map((r) => {
    // v1.1.1：一致性检查 —— index.json 里有记录，但对应的 JSON 文件被删了，要能在界面上看出来
    const files = {
      techProfile: fs.existsSync(path.join(DIR_PROFILE.tech, r.projectId + '.json')),
      bizProfile: fs.existsSync(path.join(DIR_PROFILE.biz, r.projectId + '.json')),
      techChapters: fs.existsSync(path.join(DIR_CHAPTER.tech, r.projectId + '.json')),
      bizChapters: fs.existsSync(path.join(DIR_CHAPTER.biz, r.projectId + '.json')),
      history: fs.existsSync(path.join(DIR_HISTORY, r.projectId + '.json')),
      indep: fs.existsSync(path.join(KB_DIR, '独立编制', r.projectId + '.json'))
    };
    const missing = [];
    // v1.1.2 修正：画像 / 章节 / 生成记录本来就是「有才写」，只有索引里记了才该检查文件是否存在，
    // 否则只沉淀了部分内容的项目会被误判成「文件缺失」（v1.1.1 遗留缺陷）
    const c = r.counts || {};
    const hp = r.hasProfile || {};
    if (hp.tech && !files.techProfile) missing.push('技术画像');
    if (hp.biz && !files.bizProfile) missing.push('商务画像');
    if (c.tech && !files.techChapters) missing.push('技术章节');
    if (c.biz && !files.bizChapters) missing.push('商务章节');
    if (c.history && !files.history) missing.push('生成记录');
    if (c.indep && !files.indep) missing.push('独立编制');
    return {
      ...r,
      files,
      missing,
      healthy: missing.length === 0,
      profileFiles: { tech: files.techProfile, biz: files.bizProfile }
    };
  });
  const total = projects.length;
  const techCh = projects.reduce((n, r) => n + ((r.counts && r.counts.tech) || 0), 0);
  const bizCh = projects.reduce((n, r) => n + ((r.counts && r.counts.biz) || 0), 0);
  const techProf = projects.filter((r) => r.hasProfile && r.hasProfile.tech).length;
  const bizProf = projects.filter((r) => r.hasProfile && r.hasProfile.biz).length;
  const broken = projects.filter((r) => !r.healthy).length;
  return {
    root: KB_DIR,
    updatedAt: idx.updatedAt,
    stat: { projects: total, techChapters: techCh, bizChapters: bizCh, techProfiles: techProf, bizProfiles: bizProf, broken },
    projects: projects.sort((a, b) => String(b.archivedAt).localeCompare(String(a.archivedAt)))
  };
}

/* ---------- v1.1.4：图表引用（只存原路径，不复制文件，避免占本地存储） ---------- */
// 表格类：索引表 / 偏离表 / 价格表 的行列是结构化数据，直接存进知识库 JSON。
// 图片类：只记原路径 pngRel（相对数据目录）+ 标题/说明，知识库不复制 PNG。
const TABLE_TYPES = { index: 1, deviation: 1, priceTable: 1, priceTable2: 1 };

export function chartsOfChapter(c) {
  const out = [];
  if (!c) return out;
  const title = String(c.title || '');
  if (TABLE_TYPES[c.type] && Array.isArray(c.rows) && c.rows.length) {
    out.push({
      kind: 'table', chartType: c.type, title,
      columns: Array.isArray(c.columns) ? c.columns : null,
      rows: c.rows.slice(0, 300).map((r) => (r && typeof r === 'object' ? Object.assign({}, r) : r)),
      rowCount: c.rows.length
    });
  }
  const charts = Array.isArray(c.charts) ? c.charts : [];
  charts.forEach((x) => {
    if (!x) return;
    if (x.table) {
      out.push({ kind: 'table', chartType: x.chartType || 'table', title: x.title || '',
        columns: (x.table.columns || null), rows: (x.table.rows || []).slice(0, 300), rowCount: (x.table.rows || []).length });
      return;
    }
    if (x.chartType === 'table' && x.spec && Array.isArray(x.spec.rows)) {
      out.push({ kind: 'table', chartType: 'table', title: x.title || '',
        columns: x.spec.columns || null, rows: x.spec.rows.slice(0, 300), rowCount: x.spec.rows.length });
      return;
    }
    if (x.pngRel || x.png) {
      out.push({
        kind: 'image', chartType: x.chartType || '', title: x.title || '', caption: x.caption || '',
        reason: x.reason || '', pngRel: x.pngRel || '',
        width: x.width || 0, height: x.height || 0
      });
    }
  });
  return out;
}

export function countCharts(chapters) {
  let table = 0, image = 0;
  (chapters || []).forEach((c) => { (c.charts || []).forEach((x) => { if (x.kind === 'table') table++; else if (x.kind === 'image') image++; }); });
  return { table, image, total: table + image };
}

export function getKnowledge(pid) {
  const idx = loadIndex();
  const rec = (idx.projects || []).find((x) => x.projectId === pid) || null;
  if (!rec) return null;
  return {
    record: rec,
    profiles: { tech: readProfile('tech', pid), biz: readProfile('biz', pid) },
    chapters: { tech: readChapters('tech', pid), biz: readChapters('biz', pid) },
    history: readJson(path.join(DIR_HISTORY, pid + '.json'), null),
    indep: readJson(path.join(KB_DIR, '独立编制', pid + '.json'), null),
    cards: listCards(pid)
  };
}

export function removeKnowledge(pid) {
  const idx = loadIndex();
  const before = (idx.projects || []).length;
  idx.projects = (idx.projects || []).filter((x) => x.projectId !== pid);
  saveIndex(idx);
  ['tech', 'biz'].forEach((k) => {
    [path.join(DIR_PROFILE[k], pid + '.json'), path.join(DIR_CHAPTER[k], pid + '.json')].forEach((f) => {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
    });
  });
  try { const h = path.join(DIR_HISTORY, pid + '.json'); if (fs.existsSync(h)) fs.unlinkSync(h); } catch {}
  try { const d = path.join(KB_DIR, '独立编制', pid + '.json'); if (fs.existsSync(d)) fs.unlinkSync(d); } catch {}
  try { removeCards(pid); } catch {}
  return { removed: before - idx.projects.length };
}
