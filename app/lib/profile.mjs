// v1.1.0 专家画像：技术专家 / 商务专家
// 画像 = AI 对这个项目的"上岗 briefing"，生成一次、用户确认、后续章节复用。
import fs from 'node:fs';
import path from 'node:path';
import { callJson } from './ai.mjs';
import { nowIso } from './util.mjs';
import { DATA_DIR } from './config.mjs';

// v1.2.0：把相似项目记录变成给 AI 看的文字（原来是 refs.join → [object Object]）
function refTextOf(refs) {
  const L = ['【历史经验参考（本工作台做过的相似项目，只借鉴思路，不要搬名称/金额/指标）】'];
  refs.slice(0, 3).forEach((r, i) => {
    if (!r || typeof r !== 'object') return;
    const bits = [];
    if (r.name) bits.push(r.name);
    if (r.purchaseMethod) bits.push(r.purchaseMethod);
    if (r.year) bits.push(r.year + ' 年');
    L.push('- 参考项目 ' + (i + 1) + '：' + (bits.join('，') || '（未命名）'));
    if (r.direction && typeof r.direction === 'object') {
      const d = r.direction;
      if (d.techDirection) L.push('  技术方向：' + d.techDirection);
      if (d.bizDirection) L.push('  商务方向：' + d.bizDirection);
    }
    if (Array.isArray(r.titles) && r.titles.length) L.push('  当时覆盖的章节：' + r.titles.slice(0, 8).join('、'));
  });
  return L.join('\n');
}

export const PROFILE_KINDS = ['tech', 'biz'];
export const KIND_LABEL = { tech: '技术', biz: '商务' };

function secMap(analysis) {
  const s = analysis && analysis.sections;
  if (!s) return {};
  if (Array.isArray(s)) { const m = {}; s.forEach((x) => { if (x && x.key) m[x.key] = x; }); return m; }
  return s;
}
function rowText(it) {
  if (it && it.cells && it.cells.length) return it.cells.filter(Boolean).join(' ｜ ');
  return (it && it.text) || '';
}
function pick(analysis, keys, limit) {
  const map = secMap(analysis);
  const out = [];
  keys.forEach((k) => {
    const s = map[k];
    if (s && Array.isArray(s.items)) s.items.forEach((it) => out.push({ text: rowText(it), page: it.page, star: !!it.isStar }));
  });
  return out.filter((x) => x.text && x.text.length > 6).slice(0, limit || 120);
}

function projectBrief(project) {
  return [
    '项目名称：' + (project.name || '—'),
    '招标编号：' + (project.code || '—'),
    '招标人：' + (project.owner || '—'),
    '采购方式：' + (project.purchaseMethod || '—'),
    '预算金额：' + (project.budget || '—'),
    '投标截止：' + (project.bidDeadline || '—')
  ].join('\n');
}

const SYS_TECH = [
  '你是中国招投标领域的资深技术专家，长期担任大型项目的技术负责人。',
  '任务：在正式写标书之前，先把这个项目的技术底子摸清楚，形成一份"技术专家上岗档案"，供后面逐章撰写技术标使用。',
  '要求：',
  '1. 只依据我给你的招标文件内容，不编造。文件没写的不要臆想。',
  '2. 技术指标必须原文引用（数字、单位、频次、期限原样照抄），并给出页码。',
  '3. 站在"这个项目该由什么样的技术负责人来做"的角度去判断方向和技术栈，要具体到本行业本方向，不要写成放之四海皆准的套话。',
  '4. summary 是给不懂技术的操作人员看的一句话，必须用大白话说清"这是个什么项目、我打算以什么身份去写"，不要堆术语。',
  '5. 只输出 JSON。'
].join('\n');

const SYS_BIZ = [
  '你是中国招投标领域的资深商务负责人（懂技术、统筹质量部/市场部/保密办等职能部门）。',
  '任务：在正式写标书之前，先把这个项目的商务与管理底子摸清楚，形成一份"商务专家上岗档案"，供后面逐章撰写商务标使用。',
  '要求：',
  '1. 只依据我给你的招标文件内容，不编造。文件没写的不要臆想。',
  '2. 商务条款（交付、付款、质保、售后、保密、违约、知识产权等）必须原文引用关键数值，并给出页码。',
  '3. 要具体到本项目，不要写成通用管理体系套话。',
  '4. summary 是给不懂技术的操作人员看的一句话，必须用大白话说清"这是个什么项目、我打算以什么身份去写"。',
  '5. 只输出 JSON。'
].join('\n');

function techUserPrompt(project, analysis, refs) {
  const L = [];
  L.push(projectBrief(project));
  L.push('');
  L.push('【招标文件里的技术要求/技术条款（原文，含页码）】');
  const tech = pick(analysis, ['tech', 'deliver'], 90);
  if (tech.length) tech.forEach((x) => L.push('- ' + (x.page ? '[第' + x.page + '页] ' : '') + (x.star ? '★' : '') + x.text));
  else L.push('（没有单独的技术条款板块，请从全文与交付要求里判断）');
  L.push('');
  const score = pick(analysis, ['score'], 30);
  if (score.length) {
    L.push('【评分标准（技术相关部分）】');
    score.forEach((x) => L.push('- ' + (x.page ? '[第' + x.page + '页] ' : '') + x.text));
    L.push('');
  }
  const front = pick(analysis, ['frontTable'], 25);
  if (front.length) {
    L.push('【前附表关键要素】');
    front.forEach((x) => L.push('- ' + x.text));
    L.push('');
  }
  if (refs && refs.length) {
    // v1.2.0 修正：refs 是「相似项目记录」对象数组，以前直接 join 会输出 [object Object]
    L.push(refTextOf(refs));
    L.push('');
  }
  L.push('请输出这份"技术专家上岗档案"的 JSON：');
  L.push('{');
  L.push('  "summary": "用一句大白话说清这是个什么项目、我打算以什么身份去写（不超过120字，给不懂技术的人看）",');
  L.push('  "direction": "这个项目属于哪个产品/服务方向（一句话，具体到本行业）",');
  L.push('  "stack": [{"stage":"环节名称","desc":"这个环节要做什么、关键点是什么"}],');
  L.push('  "targets": [{"item":"指标名称","value":"招标文件原文的数值或要求","page":12}],');
  L.push('  "difficulty": ["本项目的技术难点（3-6条，具体到本项目）"],');
  L.push('  "focus": ["评委在技术评分上会重点看什么（3-6条）"],');
  L.push('  "approach": "本项目的技术逻辑主线：总体思路 → 技术路线 → 关键保障（200字以内）"');
  L.push('}');
  L.push('stack 给 5-9 个环节，要覆盖这个方向从准备到交付的全流程技术链条。targets 给 6-15 条硬指标。');
  return L.join('\n');
}

function bizUserPrompt(project, analysis, refs) {
  const L = [];
  L.push(projectBrief(project));
  L.push('');
  L.push('【招标文件里的商务要求/商务条款（原文，含页码）】');
  const biz = pick(analysis, ['business'], 80);
  if (biz.length) biz.forEach((x) => L.push('- ' + (x.page ? '[第' + x.page + '页] ' : '') + (x.star ? '★' : '') + x.text));
  else L.push('（没有单独的商务条款板块）');
  L.push('');
  const score = pick(analysis, ['score'], 30);
  if (score.length) {
    L.push('【评分标准（商务相关部分）】');
    score.forEach((x) => L.push('- ' + (x.page ? '[第' + x.page + '页] ' : '') + x.text));
    L.push('');
  }
  const qual = pick(analysis, ['qualify', 'conform'], 40);
  if (qual.length) {
    L.push('【资格与符合性审查要点】');
    qual.forEach((x) => L.push('- ' + x.text));
    L.push('');
  }
  const fatal = pick(analysis, ['fatal'], 30);
  if (fatal.length) {
    L.push('【废标/无效投标条款（承诺时绝不能碰）】');
    fatal.forEach((x) => L.push('- ' + x.text));
    L.push('');
  }
  if (refs && refs.length) {
    L.push(refs.join('\n'));
    L.push('');
  }
  L.push('请输出这份"商务专家上岗档案"的 JSON：');
  L.push('{');
  L.push('  "summary": "用一句大白话说清这是个什么项目、我打算以什么身份去写（不超过120字）",');
  L.push('  "direction": "我方以什么身份来写商务标（如：项目管理专家 / 质量保证专家 / 售后运维专家 / 保密管理专家，可组合）",');
  L.push('  "bizLogic": "本项目的商务逻辑主线：交付 → 验收 → 付款 → 质保 → 售后 → 违约，怎么串起来（150字以内）",');
  L.push('  "mgmtLogic": "整体管理逻辑：组织怎么设、职责怎么分、协调与信息台账怎么管（150字以内）",');
  L.push('  "qualityLogic": "质量管理逻辑：体系、过程控制、检验、追溯（120字以内）",');
  L.push('  "commitments": [{"item":"可以承诺的事项","note":"怎么承诺既拿分又稳妥"}],');
  L.push('  "boundary": ["需要谨慎、不能乱承诺的地方（3-6条，来自招标文件的约束）"],');
  L.push('  "focus": ["评委在商务评分上会重点看什么（3-6条）"]');
  L.push('}');
  return L.join('\n');
}

function normalize(kind, raw) {
  const r = raw || {};
  const arr = (v) => (Array.isArray(v) ? v : []);
  const s = (v) => (v == null ? '' : String(v));
  if (kind === 'tech') {
    return {
      summary: s(r.summary),
      direction: s(r.direction),
      stack: arr(r.stack).map((x) => ({ stage: s(x && x.stage), desc: s(x && x.desc) })).filter((x) => x.stage),
      targets: arr(r.targets).map((x) => ({ item: s(x && x.item), value: s(x && x.value), page: x && x.page != null ? Number(x.page) || '' : '' })).filter((x) => x.item || x.value),
      difficulty: arr(r.difficulty).map(s).filter(Boolean),
      focus: arr(r.focus).map(s).filter(Boolean),
      approach: s(r.approach)
    };
  }
  return {
    summary: s(r.summary),
    direction: s(r.direction),
    bizLogic: s(r.bizLogic),
    mgmtLogic: s(r.mgmtLogic),
    qualityLogic: s(r.qualityLogic),
    commitments: arr(r.commitments).map((x) => ({ item: s(x && x.item), note: s(x && x.note) })).filter((x) => x.item),
    boundary: arr(r.boundary).map(s).filter(Boolean),
    focus: arr(r.focus).map(s).filter(Boolean)
  };
}

// 生成一份画像（不落盘，由调用方决定是否保存/确认）
export async function generateProfile(project, analysis, kind, refs) {
  const k = kind === 'biz' ? 'biz' : 'tech';
  if (!analysis) throw new Error('还没有招标分析结果，请先完成招标文件分析');
  const sys = k === 'tech' ? SYS_TECH : SYS_BIZ;
  const user = k === 'tech' ? techUserPrompt(project, analysis, refs) : bizUserPrompt(project, analysis, refs);
  const raw = await callJson(sys, user, { maxTokens: 6000, timeoutMs: 240000, temperature: 0.3, reasoningEffort: 'none' });
  const data = normalize(k, raw);
  if (!data.summary && !data.direction) throw new Error('AI 没有返回有效的画像内容，请重试');
  return data;
}

// 把画像渲染成注入提示词的一段文字
export function profileToPrompt(kind, p) {
  if (!p) return '';
  const L = [];
  if (kind === 'tech') {
    if (p.direction) L.push('本项目所属方向：' + p.direction);
    if (p.summary) L.push('项目定位：' + p.summary);
    if (p.approach) L.push('技术逻辑主线：' + p.approach);
    if (p.stack && p.stack.length) {
      L.push('这个方向的全流程技术链条（写方案时要体现这些环节，不要漏环节、不要跨到别的行业去）：');
      p.stack.forEach((x, i) => L.push('  ' + (i + 1) + '. ' + x.stage + (x.desc ? '：' + x.desc : '')));
    }
    if (p.targets && p.targets.length) {
      L.push('本项目硬指标（必须在正文里逐条落到具体数值）：');
      p.targets.forEach((x) => L.push('  · ' + x.item + '：' + x.value + (x.page ? '（第' + x.page + '页）' : '')));
    }
    if (p.difficulty && p.difficulty.length) { L.push('技术难点：'); p.difficulty.forEach((x) => L.push('  · ' + x)); }
    if (p.focus && p.focus.length) { L.push('评委技术评分关注点：'); p.focus.forEach((x) => L.push('  · ' + x)); }
  } else {
    if (p.direction) L.push('你以这个身份来写：' + p.direction);
    if (p.summary) L.push('项目定位：' + p.summary);
    if (p.bizLogic) L.push('商务逻辑主线：' + p.bizLogic);
    if (p.mgmtLogic) L.push('整体管理逻辑：' + p.mgmtLogic);
    if (p.qualityLogic) L.push('质量管理逻辑：' + p.qualityLogic);
    if (p.commitments && p.commitments.length) {
      L.push('可以承诺的事项：');
      p.commitments.forEach((x) => L.push('  · ' + x.item + (x.note ? '（' + x.note + '）' : '')));
    }
    if (p.boundary && p.boundary.length) { L.push('承诺边界（这些地方必须谨慎，不能乱承诺）：'); p.boundary.forEach((x) => L.push('  · ' + x)); }
    if (p.focus && p.focus.length) { L.push('评委商务评分关注点：'); p.focus.forEach((x) => L.push('  · ' + x)); }
  }
  return L.join('\n');
}

// 供界面显示的一段大白话
export function profileHeadline(kind, p) {
  if (!p) return '';
  const who = kind === 'tech' ? '技术专家' : '商务专家';
  return '我理解：' + (p.summary || p.direction || '（暂无）') + (p.direction && p.summary ? '（身份：' + p.direction + '）' : '');
}

export function blankProfile(kind) {
  return kind === 'tech'
    ? { summary: '', direction: '', stack: [], targets: [], difficulty: [], focus: [], approach: '' }
    : { summary: '', direction: '', bizLogic: '', mgmtLogic: '', qualityLogic: '', commitments: [], boundary: [], focus: [] };
}

/* ---------- 画像存储（每个项目一份，确认后复用） ---------- */

export const PROFILE_DIR = path.join(DATA_DIR, '画像');
function profFile(pid) { return path.join(PROFILE_DIR, pid + '.json'); }

export function loadProfiles(pid) {
  try { return JSON.parse(fs.readFileSync(profFile(pid), 'utf8')); } catch { return {}; }
}
export function saveProfiles(pid, obj) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.writeFileSync(profFile(pid), JSON.stringify(obj, null, 1), 'utf8');
  return obj;
}
export function getProfile(pid, kind) {
  const all = loadProfiles(pid);
  return all[kind] || null;
}
// 确认画像：把用户改过的内容存下来，并记录这次修改
export function confirmProfile(pid, kind, data, opts) {
  const all = loadProfiles(pid);
  const prev = all[kind];
  const rec = {
    kind,
    data,
    confirmed: true,
    confirmedAt: nowIso(),
    generatedAt: (prev && prev.generatedAt) || nowIso(),
    confirmedBy: (opts && opts.by) || 'user',
    revisions: ((prev && prev.revisions) || []).slice(-19)
  };
  if (opts && opts.revisionNote) {
    rec.revisions.push({ at: nowIso(), note: String(opts.revisionNote).slice(0, 300), before: (prev && prev.data) || null });
  }
  all[kind] = rec;
  saveProfiles(pid, all);
  return rec;
}
export function setProfileDraft(pid, kind, data, extra) {
  const all = loadProfiles(pid);
  all[kind] = { ...(all[kind] || {}), kind, data, confirmed: false, generatedAt: nowIso(), ...(extra || {}) };
  saveProfiles(pid, all);
  return all[kind];
}

export function profileRecord(kind, data, extra) {
  return { kind, data: data || blankProfile(kind), confirmed: false, generatedAt: nowIso(), ...(extra || {}) };
}
