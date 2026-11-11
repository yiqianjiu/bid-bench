// v1.2.0 知识卡：把归档项目里的「重要技术 / 重要商务内容」提炼成一张张可复用的知识卡。
// 为什么不再整章搬运：章节是排版单位，颗粒度跟着标书目录走，里面一半是废话；
// 知识库要的是「下次写标书能直接用」的东西——做法、指标、机制、得分点、亮点、表格模板。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';
import { callJson, apiReady } from './ai.mjs';
import { uid, nowIso } from './util.mjs';

// 知识库根目录（和 knowledge.mjs 的 KB_DIR 同一个位置，这里独立算一遍避免循环依赖）
export const KB_DIR = path.join(DATA_DIR, '知识库');
export const CARD_DIR = path.join(KB_DIR, '知识卡');
const dirOf = (kind) => path.join(CARD_DIR, kind === 'biz' ? '商务' : '技术');

// 7 种卡片类型（用户已确认够用）
export const CARD_TYPES = [
  { key: 'approach', name: '技术路线', desc: '整体怎么做：体系、架构、技术选型主线' },
  { key: 'measure', name: '具体做法', desc: '某件事的具体步骤、工艺、流程、组织安排' },
  { key: 'metric', name: '硬指标', desc: '可量化的承诺：精度、响应时间、频次、合格率、人员配置' },
  { key: 'mgmt', name: '管理机制', desc: '质量/进度/保密/风险/售后的管理闭环' },
  { key: 'score', name: '得分点', desc: '评委给分的地方：评分项对应的写法与素材' },
  { key: 'highlight', name: '亮点', desc: '能拉开差距的特色做法、创新点、增值服务' },
  { key: 'table', name: '表格模板', desc: '索引表/偏离表/清单类表格的列结构与填法' }
];
const TYPE_KEYS = CARD_TYPES.map((t) => t.key);
export const TYPE_NAME = {};
CARD_TYPES.forEach((t) => { TYPE_NAME[t.key] = t.name; });

export function ensureCardDirs() {
  [CARD_DIR, dirOf('tech'), dirOf('biz')].forEach((d) => fs.mkdirSync(d, { recursive: true }));
}

function readJson(f, dft) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dft; } }
function writeJson(f, v) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2), 'utf8'); }
const cardFile = (kind, pid) => path.join(dirOf(kind), pid + '.json');

/* ---------- 读写 ---------- */
export function readCards(kind, pid) {
  return readJson(cardFile(kind, pid), null);
}

export function saveCards(kind, pid, obj) {
  writeJson(cardFile(kind, pid), obj);
  return obj;
}

export function removeCards(pid) {
  ['tech', 'biz'].forEach((k) => { try { const f = cardFile(k, pid); if (fs.existsSync(f)) fs.unlinkSync(f); } catch {} });
}

// 卡片列表（知识库详情页用）
export function listCards(pid) {
  const out = { tech: null, biz: null };
  ['tech', 'biz'].forEach((k) => {
    const f = readCards(k, pid);
    if (f) out[k] = f;
  });
  return out;
}

/* ---------- 提炼 ---------- */
const SYS_CARD = [
  '你是中国招投标领域的资深标书主笔，任务是把一份已经中标的投标文件里的内容，提炼成可以给下一个项目复用的「知识卡」。',
  '要求：',
  '1. 只依据我给你的章节原文提炼，不得编造数字、资质、业绩、客户名称。',
  '2. 一张卡只讲一件事，60～400 字，要写成「可以直接抄进下一份标书的做法」，不要写「本章介绍了…」这种概述。',
  '3. 必须去掉本项目的专有信息：项目名称、招标人名称、具体金额、具体人名、本项目独有的编号，用「本项目/甲方」之类的通称替代。',
  '4. 只保留有复用价值的内容；纯排版、目录、承诺函、格式模板这类没有营养的章节直接跳过。',
  '5. type 只能是：' + CARD_TYPES.map((t) => t.key + '（' + t.name + '）').join('、') + '。',
  '6. quality 是你对这张卡复用价值的打分：5=下次必用，4=很有用，3=一般，1～2=没什么用（这种不要输出）。',
  '7. 只输出 JSON，格式 {"cards":[{"type":"approach","title":"不超过20字的标题","body":"卡片正文","tags":["关键词1","关键词2"],"quality":4,"page":12}]}。'
].join('\n');

function chapterText(list, budget) {
  const L = [];
  let used = 0;
  list.forEach((c, i) => {
    const body = String(c.body || '').trim();
    if (!body) return;
    const head = '[章节 ' + (i + 1) + '] ' + String(c.title || '').trim();
    const room = budget - used - head.length;
    if (room < 300) return;
    const piece = body.length > room ? body.slice(0, room) : body;
    L.push(head + '\n' + piece);
    used += head.length + piece.length;
  });
  return L.join('\n\n');
}

function normalizeCards(raw, kind, project, chapterTitles) {
  const arr = Array.isArray(raw && raw.cards) ? raw.cards : Array.isArray(raw) ? raw : [];
  const out = [];
  arr.forEach((x) => {
    if (!x) return;
    const type = TYPE_KEYS.includes(x.type) ? x.type : 'measure';
    const title = String(x.title || '').trim().slice(0, 40);
    const body = String(x.body || '').trim();
    const quality = Math.max(1, Math.min(5, Number(x.quality) || 3));
    if (!title || body.length < 20) return;
    if (quality < 3) return;
    out.push({
      id: uid('k_'),
      type,
      role: kind,
      title,
      body: body.slice(0, 1200),
      tags: (Array.isArray(x.tags) ? x.tags : []).map((t) => String(t || '').trim()).filter(Boolean).slice(0, 6),
      source: {
        projectId: project.id,
        projectName: project.name || '',
        chapterTitle: String(x.chapterTitle || '').slice(0, 60),
        page: Number(x.page) || 0
      },
      quality,
      usedCount: 0,
      lastUsedAt: '',
      edited: false,
      createdAt: nowIso(),
      updatedAt: nowIso()
    });
  });
  return out;
}

// 任务表（提炼可能跑几分钟，前端轮询）
const tasks = new Map();
export function getCardTask(id) { return tasks.get(id) || null; }
export function listCardTasks() {
  const out = [];
  tasks.forEach((t) => { if (t && t.state === 'running') out.push(t); });
  return out;
}

// 从归档内容里提炼知识卡。chapters: [{title, role, body, charts}]
export function startCardTask(project, chaptersByRole, opt = {}) {
  const t = {
    id: uid('ct_'), projectId: project.id, projectName: project.name || '',
    state: 'running', message: '正在提炼知识卡…', progress: 0, total: 0,
    counts: { tech: 0, biz: 0 }, error: '', startedAt: nowIso(), finishedAt: ''
  };
  tasks.set(t.id, t);
  (async () => {
    try {
      if (!apiReady()) throw new Error('还没有填 DeepSeek API Key，没法提炼知识卡');
      const roles = opt.roles || ['tech', 'biz'];
      t.total = roles.reduce((n, k) => n + Math.max(1, Math.ceil(((chaptersByRole[k] || []).length) / 6)), 0);
      for (const kind of roles) {
        const chs = (chaptersByRole[kind] || []).filter((c) => String(c.body || '').trim().length > 60 || (c.charts || []).length);
        if (!chs.length) continue;
        const batches = [];
        let cur = [];
        let used = 0;
        chs.forEach((c) => {
          const len = String(c.body || '').length + 200;
          if (cur.length >= 6 || (used + len > 45000 && cur.length)) { batches.push(cur); cur = []; used = 0; }
          cur.push(c); used += len;
        });
        if (cur.length) batches.push(cur);

        const all = [];
        for (const batch of batches) {
          t.message = '正在提炼' + (kind === 'tech' ? '技术' : '商务') + '内容（' + (t.progress + 1) + '/' + t.total + '）…';
          const user = [
            '下面是本项目已经完成的投标文件里的章节原文（' + (kind === 'tech' ? '技术' : '商务') + '部分）。',
            '请提炼知识卡。',
            '',
            chapterText(batch, 45000),
            '',
            '请输出 JSON：{"cards":[...]}'
          ].join('\n');
          try {
            const r = await callJson(SYS_CARD, user, { maxTokens: 8000, timeoutMs: 240000, temperature: 0.3, reasoningEffort: 'none', purpose: 'card' });
            all.push(...normalizeCards(r, kind, project));
          } catch (e) {
            t.error = String(e && e.message || e);
          }
          t.progress++;
        }
        // 去重：标题 + 正文前 40 字
        const seen = {};
        const uniq = [];
        all.forEach((c) => {
          const k = c.title + '|' + c.body.slice(0, 40);
          if (seen[k]) { if (c.quality > seen[k].quality) seen[k].body = c.body; return; }
          seen[k] = c; uniq.push(c);
        });
        const prev = readCards(kind, project.id);
        const merged = uniq;
        // 保留用户手工加的、以及用户改过的卡（edited=true）
        if (prev && Array.isArray(prev.cards)) {
          prev.cards.forEach((old) => {
            if (old.edited) merged.push(old);
          });
        }
        saveCards(kind, project.id, {
          projectId: project.id,
          projectName: project.name || '',
          archivedAt: (prev && prev.archivedAt) || nowIso(),
          extractedAt: nowIso(),
          extractError: t.error || '',
          cards: merged
        });
        t.counts[kind] = merged.length;
      }
      t.state = 'done';
      t.message = '知识卡提炼完成：技术 ' + t.counts.tech + ' 张 / 商务 ' + t.counts.biz + ' 张';
      t.finishedAt = nowIso();
      try {
        const { syncCardCount } = await import('./knowledge.mjs');
        syncCardCount(project.id, t.counts);
      } catch {}
    } catch (e) {
      t.state = 'error';
      t.error = String(e && e.message || e);
      t.message = '知识卡提炼失败：' + t.error;
      t.finishedAt = nowIso();
    }
  })();
  return t;
}

/* ---------- 编辑 ---------- */
export function updateCard(pid, kind, cardId, patch) {
  const f = readCards(kind, pid);
  if (!f || !Array.isArray(f.cards)) return null;
  const i = f.cards.findIndex((c) => c.id === cardId);
  if (i < 0) return null;
  const c = f.cards[i];
  if (typeof patch.title === 'string' && patch.title.trim()) c.title = patch.title.trim().slice(0, 40);
  if (typeof patch.body === 'string') c.body = patch.body.trim().slice(0, 1200);
  if (Array.isArray(patch.tags)) c.tags = patch.tags.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 6);
  if (TYPE_KEYS.includes(patch.type)) c.type = patch.type;
  if (patch.quality != null) c.quality = Math.max(1, Math.min(5, Number(patch.quality) || 3));
  c.edited = true;
  c.updatedAt = nowIso();
  f.cards[i] = c;
  saveCards(kind, pid, f);
  return c;
}

export function addCard(pid, kind, data) {
  const f = readCards(kind, pid) || { projectId: pid, projectName: '', archivedAt: nowIso(), extractedAt: '', cards: [] };
  if (!Array.isArray(f.cards)) f.cards = [];
  const c = {
    id: uid('k_'),
    type: TYPE_KEYS.includes(data.type) ? data.type : 'measure',
    role: kind,
    title: String(data.title || '手工新增').trim().slice(0, 40),
    body: String(data.body || '').trim().slice(0, 1200),
    tags: (Array.isArray(data.tags) ? data.tags : []).map((x) => String(x || '').trim()).filter(Boolean).slice(0, 6),
    source: { projectId: pid, projectName: '', chapterTitle: '手工新增', page: 0 },
    quality: Math.max(1, Math.min(5, Number(data.quality) || 4)),
    usedCount: 0, lastUsedAt: '', edited: true,
    createdAt: nowIso(), updatedAt: nowIso()
  };
  f.cards.push(c);
  saveCards(kind, pid, f);
  return c;
}

export function deleteCard(pid, kind, cardId) {
  const f = readCards(kind, pid);
  if (!f || !Array.isArray(f.cards)) return false;
  const before = f.cards.length;
  f.cards = f.cards.filter((c) => c.id !== cardId);
  saveCards(kind, pid, f);
  return f.cards.length < before;
}

/* ---------- 检索 ---------- */
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

// 给提示词用的「知识卡参考」：按类型分组，每类取最相关的 2～3 张
export function buildCardReferenceBlock(project, kind, keywords, opt = {}) {
  const file = readCards(kind, project.id);
  const rec = file && Array.isArray(file.cards) ? file.cards : [];
  if (!rec.length) return { text: '', used: [] };
  const kw = new Set(keywords || []);
  const scored = rec.map((c) => {
    const own = tokens([c.title, (c.tags || []).join(' '), c.body.slice(0, 200)].join(' '));
    const ov = kw.size ? overlap(kw, own) : 0;
    const useBoost = Math.log(1 + (c.usedCount || 0)) * 0.12;
    const qBoost = ((c.quality || 3) - 3) * 0.08;
    return { c, sc: ov * 0.9 + useBoost + qBoost };
  }).filter((x) => x.sc > -0.2);
  scored.sort((a, b) => b.sc - a.sc);
  const perType = opt.perType || 2;
  const byType = {};
  scored.forEach((x) => {
    const t = x.c.type || 'measure';
    byType[t] = byType[t] || [];
    if (byType[t].length < perType) byType[t].push(x.c);
  });
  const picked = [];
  CARD_TYPES.forEach((t) => { (byType[t.key] || []).forEach((c) => picked.push(c)); });
  if (!picked.length) return { text: '', used: [] };
  const L = [];
  L.push('【历史知识卡（本工作台以前做过的项目提炼出来的可复用做法，仅供参考）】');
  L.push('注意：这些是通用做法与机制，可以借鉴思路、结构和覆盖点；');
  L.push('但绝不能把其中的项目名称、招标人、金额、资质证书编号、业绩数量当成这个项目的实际情况写进去。本章一切以本题招标文件原文与本公司真实情况为准。');
  CARD_TYPES.forEach((t) => {
    const list = byType[t.key] || [];
    if (!list.length) return;
    L.push('');
    L.push('▍' + t.name + '（' + t.desc + '）');
    list.forEach((c) => {
      const src = c.source && c.source.projectName ? '（来自：' + c.source.projectName + '）' : '';
      L.push('- ' + c.title + src);
      L.push('  ' + String(c.body || '').replace(/\n+/g, '\n  ').slice(0, 400));
    });
  });
  // 记一次使用
  try {
    const f = readCards(kind, project.id);
    if (f && Array.isArray(f.cards)) {
      picked.forEach((p) => {
        const c = f.cards.find((x) => x.id === p.id);
        if (c) { c.usedCount = (c.usedCount || 0) + 1; c.lastUsedAt = nowIso(); }
      });
      saveCards(kind, project.id, f);
    }
  } catch {}
  return { text: L.join('\n'), used: picked.map((c) => ({ id: c.id, title: c.title, type: c.type })) };
}

// 检索指定项目的卡片（跨项目挑最相关的，供「知识卡」列表页统计用）
export function allCardsOfKind(kind) {
  ensureCardDirs();
  const dir = dirOf(kind);
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const j = readJson(path.join(dir, f), null);
    if (j && Array.isArray(j.cards)) j.cards.forEach((c) => out.push(Object.assign({ projectId: j.projectId, projectName: j.projectName }, c)));
  }
  return out;
}
