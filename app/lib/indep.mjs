// v1.1.2 独立编制：针对「重要技术 / 重要商务」章节，开一个独立窗口与 AI 多轮对话，
// 生成验收用的 Word（不按投标文件版式，方便粘贴回正式标书），并可把结果写回正文。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, PROJECT_DIR } from './config.mjs';
import { uid, nowIso, safeName } from './util.mjs';
import { callJson, callText, chatMessages, apiReady } from './ai.mjs';
import { draftSystemPrompt } from './prompt.mjs';
import { getProfile, profileToPrompt } from './profile.mjs';
import { buildReferenceBlock } from './knowledge.mjs';
import { buildSvg, svgToPng, browserStatus, normalizeTable } from './chart.mjs';

export const INDEP_DIR = path.join(DATA_DIR, '独立编制');

export function ensureIndepDirs() { fs.mkdirSync(INDEP_DIR, { recursive: true }); }

function dirOf(pid) { return path.join(INDEP_DIR, pid); }
function fileOf(pid, cid) { return path.join(dirOf(pid), safeName(cid) + '.json'); }

export function loadSession(pid, cid) {
  try {
    const j = JSON.parse(fs.readFileSync(fileOf(pid, cid), 'utf8'));
    if (!Array.isArray(j.messages)) j.messages = [];
    if (!Array.isArray(j.charts)) j.charts = [];
    if (!Array.isArray(j.hints)) j.hints = [];
    return j;
  } catch { return null; }
}

export function saveSession(s) {
  fs.mkdirSync(dirOf(s.projectId), { recursive: true });
  s.updatedAt = nowIso();
  fs.writeFileSync(fileOf(s.projectId, s.chapterId), JSON.stringify(s, null, 1), 'utf8');
  return s;
}

export function ensureSession(project, docKey, chapter) {
  const old = loadSession(project.id, chapter.id);
  if (old) {
    old.chapterTitle = chapter.title;
    old.docKey = docKey;
    if (chapter.role) old.role = chapter.role;
    return old;
  }
  return saveSession({
    projectId: project.id, projectName: project.name, docKey,
    chapterId: chapter.id, chapterTitle: chapter.title,
    role: chapter.role === 'tech' || chapter.role === 'biz' ? chapter.role : 'tech',
    createdAt: nowIso(), messages: [], text: chapter.body || '', charts: [], hints: [],
    outDir: '', exports: []
  });
}

// 该项目下所有独立编制会话（归档时并入知识库）
export function listSessions(pid) {
  const d = dirOf(pid);
  if (!fs.existsSync(d)) return [];
  const out = [];
  for (const f of fs.readdirSync(d)) {
    if (!f.endsWith('.json')) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'))); } catch {}
  }
  return out;
}

// 给前端用的会话副本：把图片的绝对路径换成可直接访问的 URL，别把本机路径吐给浏览器
export function clientSession(s) {
  if (!s) return null;
  const out = { ...s };
  out.charts = (s.charts || []).map((c) => {
    if (!c.png) return { ...c, url: '' };
    const name = path.basename(c.png);
    return { ...c, png: undefined, url: '/api/indep-image/' + encodeURIComponent(s.projectId) + '/' + encodeURIComponent(s.chapterId) + '/' + encodeURIComponent(name) };
  });
  return out;
}

/* ---------------- 上下文：招标文件原文 + 画像 + 历史经验 ---------------- */
function clausesFor(analysis, docKey, title, role) {
  if (!analysis || !Array.isArray(analysis.sections)) return [];
  const t = String(title || '');
  let keys;
  if (docKey === 'qual') keys = ['qualify', 'conform'];
  else if (docKey === 'price') keys = ['frontTable', 'business'];
  else if (role === 'tech') keys = ['tech', 'deliver', 'business'];
  else if (role === 'biz') keys = ['business', 'qualify', 'conform', 'score'];
  else keys = /技术|方案|实施|工艺|设备|系统/.test(t) ? ['tech', 'deliver', 'business'] : ['business', 'tech', 'deliver', 'conform', 'score'];
  const out = [];
  for (const sec of analysis.sections) {
    if (!keys.includes(sec.key)) continue;
    for (const it of sec.items || []) {
      const text = String(it.text || it.cells ? (it.text || '') : '').trim();
      if (text && text.length > 8) out.push({ text, page: it.page, star: !!it.isStar, fatal: !!it.isFatal });
    }
  }
  return out;
}

function projectBrief(project) {
  return [
    '项目名称：' + (project.name || '—'),
    '招标编号：' + (project.code || '—'),
    '招标人：' + (project.owner || '—'),
    '采购方式：' + (project.purchaseMethod || '—'),
    '预算金额：' + (project.budget || '—'),
    '投标截止时间：' + (project.bidDeadline || '—')
  ].join('\n');
}

function buildContext(project, session, analysis, extra) {
  const role = session.role === 'biz' ? 'biz' : 'tech';
  const cl = clausesFor(analysis, session.docKey, session.chapterTitle, role);
  // 条款按相关度排序后截断到 18000 字
  const kw = session.chapterTitle + ' ' + (extra || '');
  const scored = cl.map((x, i) => ({ ...x, i, sc: (x.star ? 0.4 : 0) + (x.fatal ? 0.3 : 0) + jaccard(kw, x.text) }));
  scored.sort((a, b) => b.sc - a.sc);
  let used = 0;
  const picked = [];
  for (const x of scored) { if (used + x.text.length > 18000) continue; picked.push(x); used += x.text.length; }
  picked.sort((a, b) => a.i - b.i);
  let profileText = '';
  try {
    const p = getProfile(project.id, role);
    if (p && p.confirmed && p.data) profileText = profileToPrompt(role, p.data);
  } catch {}
  let refText = '';
  try {
    const r = buildReferenceBlock(project, role, 3);
    if (r && r.text) refText = r.text;
  } catch {}
  return { role, clauses: picked, profileText, refText };
}

function jaccard(a, b) {
  const bg = (s) => { const t = String(s || '').replace(/[\s\p{P}]/gu, ''); const g = new Set(); for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2)); return g; };
  const A = bg(a), B = bg(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  A.forEach((x) => { if (B.has(x)) n++; });
  return n / Math.min(A.size, B.size);
}

const ROLE_WORD = { tech: '技术负责人（AI 技术专家）', biz: '商务负责人（AI 商务专家）' };

/* ---------------- 系统提示词 ---------------- */
const SYS_CHAT = [
  '你是投标业务工作台里的「独立编制助手」，服务对象是一位不懂代码、正在编标书的业务人员。',
  '你面对的章节是重要技术内容或重要商务内容，需要深度、专业、可落地。',
  '对话规则：',
  '1. 说话简短、直接、口语化，不要长篇大论。用户问什么答什么。',
  '2. 用户如果说「改第 2 段」「扩写实施方案」「加个进度表」，你要先一句话说明你打算怎么改，再等他点「执行更新」；不要假装已经改好了。',
  '3. 你可以主动指出当前稿件的问题（缺数据、太空泛、没对应招标文件某条要求），并给出具体建议。',
  '4. 需要图/表时，说明「这里适合放什么图、说明什么问题」，不要自己画（你画不了图，系统会按你的描述生成）。',
  '5. 绝不编造招标文件里没有的硬指标（金额、工期、资质等级、证书编号）。缺信息就明确让用户补充。'
].join('\n');

const SYS_GEN = [
  '你是中国招投标领域资深的标书编写专家，现在要为用户编制一份「章节草稿」，供他验收确认后再粘贴进正式标书。',
  '写作要求：',
  '1. 只能以本项目的招标文件原文、用户补充说明为依据；不得写放在任何项目上都成立的通用套话。',
  '2. 凡是招标文件里的★条款、废标条款、量化指标，必须原样引用并明确响应（写清「完全响应、无偏离」或具体做法）。',
  '3. 技术类内容必须逐条逐项对应技术需求/技术要求/技术指标，一条一条写「该要求是什么、我方如何满足」，不许合并归纳成几大类。',
  '4. 商务类内容逐条对应商务条款，把人员、进度、质量、售后、保密等落到具体做法、具体数字、具体责任人角色。',
  '5. 语言专业、书面、无口语；不使用 markdown 记号（不要 **、#、- 列表符）；层级只用「一、」「1.」「(1)」三种。',
  '6. 篇幅要够：重要技术不少于 2500 字，重要商务不少于 1800 字，宁可细不要空。',
  '7. 不要写封面、目录、页码、页眉页脚——这只是草稿。',
  '8. 你认为需要配图/配表的地方，不要自己编造图片，而是在 charts 里给出结构化描述，由系统生成示意图；确实画不出来的（照片、现场图、证书扫描件）放进 hints 提醒用户自己放。'
].join('\n');

function genUserPrompt(project, session, ctx, extra) {
  const L = [];
  L.push('【项目信息】'); L.push(projectBrief(project)); L.push('');
  L.push('【章节】' + session.chapterTitle + '（性质：' + ROLE_WORD[ctx.role] + '）');
  if (ctx.profileText) { L.push(''); L.push('【已确认的专家画像】'); L.push(ctx.profileText); }
  if (ctx.refText) { L.push(''); L.push(ctx.refText); }
  if (ctx.clauses.length) {
    L.push('');
    L.push('【招标文件原文条款 —— 每一条都要在正文里有对应响应，一条都不能漏】');
    ctx.clauses.forEach((c, i) => L.push((i + 1) + '. ' + (c.page ? '[第' + c.page + '页] ' : '') + (c.star ? '★' : '') + (c.fatal ? '【废标】' : '') + c.text));
  }
  if (extra) { L.push(''); L.push('【用户的补充说明 / 本轮对话要求（优先满足）】'); L.push(extra); }
  L.push('');
  L.push('请输出 JSON，格式：');
  L.push('{"title":"本章标题","text":"正文（纯文本，用 一、/1./(1) 编号，段落之间用 \\n 分隔）","charts":[{"afterText":"正文里紧挨着这张图前面的一句话（照抄 15-30 字）","kind":"chart","chartType":"gantt|flow|arch|timeline|line|bar|sequence|org","title":"图标题","caption":"图1 xxx（示意图）","reason":"这张图要说明什么","spec":{...}}],"hints":[{"afterText":"正文里的一句话","text":"此处建议插入：现场照片 / 资质证书扫描件 …"}]}');
  L.push('charts 的 spec 按类型给：');
  L.push('- gantt: {"unit":"天","tasks":[{"name":"阶段名","start":0,"span":5,"label":"T+0~5"}]}');
  L.push('- flow: {"nodes":[{"label":"步骤","kind":"start|process|end"}]}');
  L.push('- arch: {"layers":[{"name":"层名","items":["组件"]}]}');
  L.push('- timeline: {"items":[{"time":"T+7","label":"事件"}]}');
  L.push('- line/bar: {"categories":["1月"],"series":[{"name":"系列","data":[1,2]}],"yLabel":"单位"}');
  L.push('- sequence: {"actors":["甲方"],"steps":[{"from":"甲方","to":"乙方","label":"动作"}]}');
  L.push('- org: {"root":"项目经理","children":[{"name":"技术负责人","children":["开发组"]}]}');
  L.push('- table: {"columns":["阶段","时间","工作内容","交付物"],"rows":[["准备","T+0~5","…","…"]]}（表格直接排成 Word 表格，适合进度计划、人员配备、设备清单、指标对照这类）');
  L.push('重要商务内容不必拘泥于某一种图表：进度安排适合用 table 逐项拆分环节（用 T+n 表示），人员配备适合 table 或 org，服务流程适合 flow，指标趋势适合 line/bar。按内容需要选，不要为了配图硬加。');
  L.push('图里的数值必须来自招标文件原文、用户补充说明，或你在前两者基础上给出的合理方案值；不要凭空编造。不需要图表就返回空数组。');
  return L.join('\n');
}

function parseGen(out) {
  const j = out && typeof out === 'object' ? out : {};
  let text = String(j.text || '').trim();
  if (!text && typeof out === 'string') text = out;
  const charts = Array.isArray(j.charts) ? j.charts.filter((c) => c && c.chartType) : [];
  const hints = Array.isArray(j.hints) ? j.hints.filter((c) => c && c.text) : [];
  return { title: String(j.title || '').trim(), text, charts, hints };
}

/* ---------------- 编制生成 ---------------- */
export async function generateDraft(project, session, analysis, extra) {
  if (!apiReady()) throw new Error('还没有填写 DeepSeek API Key，请到「设置」里填。');
  const ctx = buildContext(project, session, analysis, extra);
  const out = await callJson(SYS_GEN, genUserPrompt(project, session, ctx, extra), { maxTokens: 32000, timeoutMs: 420000, temperature: 0.55 });
  const g = parseGen(out);
  if (!g.text || g.text.length < 80) throw new Error('AI 没有返回有效正文，请重试一次');
  session.text = g.text;
  session.title = g.title || session.chapterTitle;
  session.generatedAt = nowIso();
  // 渲染图表
  session.charts = [];
  for (const c of g.charts.slice(0, 6)) {
    try {
      const rec = await renderChart(project.id, session.chapterId, c);
      if (rec) session.charts.push(rec);
    } catch (e) {
      session.hints.push({ afterText: c.afterText || '', text: '此处建议插入：' + (c.title || '示意图') + '（自动生成失败：' + (e.message || e) + '）' });
    }
  }
  session.hints = g.hints.slice(0, 8);
  saveSession(session);
  return session;
}

async function renderChart(pid, cid, c) {
  const spec = { ...(c.spec || {}), chartType: c.chartType, title: c.title || '' };
  // 表格不画成图：直接存结构化行列，导出 Word 时排成真正的 Word 表格（方便你改数字）
  if (String(c.chartType).toLowerCase() === 'table') {
    const t = normalizeTable({ ...(c.spec || {}), ...spec });
    if (!t.columns.length || !t.rows.length) throw new Error('表格没给行列内容');
    return {
      id: uid('ch_'), chartType: 'table', title: c.title || '', caption: c.caption || '', reason: c.reason || '',
      afterText: c.afterText || '', spec, table: t, at: nowIso()
    };
  }
  const svg = buildSvg(spec);
  const dir = path.join(INDEP_DIR, pid, safeName(cid));
  fs.mkdirSync(dir, { recursive: true });
  const id = uid('ch_');
  const png = path.join(dir, id + '.png');
  const r = await svgToPng(svg, png, { scale: 2 });
  return {
    id, chartType: c.chartType, title: c.title || '', caption: c.caption || '', reason: c.reason || '',
    afterText: c.afterText || '', spec, pngRel: path.relative(DATA_DIR, png).replace(/\\/g, '/'),
    png, width: r.width, height: r.height, at: nowIso()
  };
}

// 单独重新生成某张图（用户改说明后重画）
export async function redoChart(pid, cid, chartId, patch) {
  const s = loadSession(pid, cid);
  if (!s) throw new Error('会话不存在');
  const i = s.charts.findIndex((x) => x.id === chartId);
  if (i < 0) throw new Error('这张图不存在了');
  const old = s.charts[i];
  const spec = { ...(old.spec || {}), ...(patch && patch.spec ? patch.spec : {}) };
  if (patch && patch.chartType) spec.chartType = patch.chartType;
  // 表格重画时，patch 里给了 columns/rows 就直接替换（避免新旧行拼在一起）
  if (patch && (patch.columns || patch.rows)) {
    if (patch.columns) spec.columns = patch.columns;
    if (patch.rows) spec.rows = patch.rows;
  }
  const rec = await renderChart(pid, cid, {
    chartType: spec.chartType, title: (patch && patch.title) || old.title,
    caption: (patch && patch.caption) || old.caption, reason: old.reason,
    afterText: (patch && patch.afterText) || old.afterText, spec
  });
  s.charts[i] = { ...rec, id: old.id };
  saveSession(s);
  return s;
}

// 用户用一句话要求改图 → AI 重新给 spec → 重画
const SYS_CHART = [
  '你是标书里的图表设计助手。用户会给你一张现有的图（或表）和一句修改要求，你要输出改好之后的图表结构 JSON。',
  '只能输出 JSON，格式：{"chartType":"gantt|flow|arch|timeline|line|bar|sequence|org|table","title":"图标题","caption":"图1 xxx（示意图）","reason":"这张图要说明什么","spec":{...}}',
  'spec 按类型给：gantt {"unit":"天","tasks":[{"name":"阶段","start":0,"span":5,"label":"T+0~5"}]}；flow {"nodes":[{"label":"步骤","kind":"start|process|end"}]}；arch {"layers":[{"name":"层","items":["组件"]}]}；timeline {"items":[{"time":"T+7","label":"事件"}]}；line/bar {"categories":["1月"],"series":[{"name":"系列","data":[1,2]}],"yLabel":"单位"}；sequence {"actors":["甲方"],"steps":[{"from":"甲方","to":"乙方","label":"动作"}]}；org {"root":"项目经理","children":[{"name":"技术负责人","children":["开发组"]}]}；table {"columns":["列1"],"rows":[["值"]]}',
  '数值只能来自原图、招标文件原文或用户说明；不要编造。'
].join('\n');

export async function reworkChart(project, session, chartId, instruction) {
  if (!apiReady()) throw new Error('还没有填写 DeepSeek API Key，请到「设置」里填。');
  const old = (session.charts || []).find((x) => x.id === chartId);
  if (!old) throw new Error('这张图不存在了');
  const ctx = buildContext(project, session, null, instruction);
  const user = [
    '【章节】' + session.chapterTitle,
    '【现有图表】' + JSON.stringify({ chartType: old.chartType, title: old.title, caption: old.caption, reason: old.reason, spec: old.spec, table: old.table || null }, null, 1).slice(0, 6000),
    '【用户的修改要求】' + (instruction || '（没说，就换个更好的画法）'),
    ctx.profileText ? '【专家画像】' + ctx.profileText.slice(0, 2000) : ''
  ].filter(Boolean).join('\n\n');
  const out = await callJson(SYS_CHART, user, { maxTokens: 4000, timeoutMs: 180000, temperature: 0.4, reasoningEffort: 'none' });
  const j = out && typeof out === 'object' ? out : {};
  const chartType = String(j.chartType || old.chartType || '').toLowerCase();
  const patch = { chartType, spec: j.spec || {}, title: j.title || old.title, caption: j.caption || old.caption };
  if (chartType === 'table') { patch.columns = (j.spec && j.spec.columns) || []; patch.rows = (j.spec && j.spec.rows) || []; }
  const ns = await redoChart(project.id, session.chapterId, chartId, patch);
  if (j.reason) { const i = ns.charts.findIndex((x) => x.id === chartId); if (i >= 0) ns.charts[i].reason = String(j.reason).slice(0, 300); saveSession(ns); }
  return ns;
}

// 把现有所有图按当前 spec 重画一遍（不调 AI，快；用于修「图没画出来」或改完 spec 后刷新）
export async function redoAllCharts(pid, cid) {
  const s = loadSession(pid, cid);
  if (!s) throw new Error('会话不存在');
  const out = [];
  for (const old of (s.charts || [])) {
    try {
      const rec = await renderChart(pid, cid, {
        chartType: old.chartType, title: old.title, caption: old.caption,
        reason: old.reason, afterText: old.afterText, spec: old.spec || {}
      });
      const i = s.charts.findIndex((x) => x.id === old.id);
      if (i >= 0) s.charts[i] = { ...rec, id: old.id, reason: old.reason };
      out.push({ id: old.id, ok: true });
    } catch (e) {
      out.push({ id: old.id, ok: false, error: String((e && e.message) || e) });
    }
  }
  saveSession(s);
  return { session: s, results: out };
}

/* ---------------- 多轮对话 ---------------- */
export async function chatWithAI(project, session, analysis, message) {
  if (!apiReady()) throw new Error('还没有填写 DeepSeek API Key，请到「设置」里填。');
  const ctx = buildContext(project, session, analysis, message);
  const msgs = [{ role: 'system', content: SYS_CHAT }];
  const head = [
    '【项目】' + projectBrief(project).replace(/\n/g, ' / '),
    '【当前章节】' + session.chapterTitle + '（' + ROLE_WORD[ctx.role] + '）'
  ].join('\n');
  msgs.push({ role: 'user', content: head + '\n\n【当前稿件】\n' + (session.text ? session.text.slice(0, 12000) : '（还没有生成，用户可以先让你生成）') });
  msgs.push({ role: 'assistant', content: '好，我已了解项目和当前稿件。你想改哪里、或者想加什么内容？' });
  const hist = session.messages.slice(-16);
  for (const m of hist) msgs.push({ role: m.role === 'ai' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 4000) });
  msgs.push({ role: 'user', content: message });
  const reply = await chatMessages(msgs, { maxTokens: 6000, timeoutMs: 180000, temperature: 0.6, reasoningEffort: 'none' });
  session.messages.push({ role: 'user', content: message, at: nowIso() });
  session.messages.push({ role: 'ai', content: reply, at: nowIso() });
  if (session.messages.length > 200) session.messages = session.messages.slice(-200);
  saveSession(session);
  return { reply, session };
}

/* ---------------- 执行更新（按对话改稿） ---------------- */
export async function applyUpdate(project, session, analysis) {
  if (!apiReady()) throw new Error('还没有填写 DeepSeek API Key，请到「设置」里填。');
  const recent = session.messages.slice(-12).map((m) => (m.role === 'user' ? '用户：' : '助手：') + String(m.content || '').slice(0, 1500)).join('\n');
  if (!recent) throw new Error('还没有对话内容。先跟 AI 说清楚要改什么，再点「执行更新」。');
  const ctx = buildContext(project, session, analysis, recent);
  const extra = [
    '【本轮要执行的修改（按对话理解，优先执行这一轮的要求）】',
    recent,
    '',
    '【当前稿件（在它的基础上改，不要推倒重写没提到的部分）】',
    String(session.text || '').slice(0, 20000)
  ].join('\n');
  const out = await callJson(SYS_GEN, genUserPrompt(project, session, ctx, extra), { maxTokens: 32000, timeoutMs: 420000, temperature: 0.5 });
  const g = parseGen(out);
  if (!g.text || g.text.length < 80) throw new Error('AI 没有返回有效正文，请重试一次');
  session.text = g.text;
  session.generatedAt = nowIso();
  session.updateAt = nowIso();
  const kept = [];
  for (const c of g.charts.slice(0, 6)) {
    const oldSame = (session.charts || []).find((x) => x.title && c.title && x.title === c.title);
    if (oldSame) { kept.push(oldSame); continue; }
    try {
      const rec = await renderChart(project.id, session.chapterId, c);
      if (rec) kept.push(rec);
    } catch {}
  }
  session.charts = kept;
  session.hints = g.hints.slice(0, 8);
  saveSession(session);
  return session;
}

/* ---------------- 导出 Word（验收用草稿，不按投标文件版式） ---------------- */
export async function exportDraftWord(project, session, outDir) {
  const {
    Document, Packer, Paragraph, TextRun, AlignmentType, ImageRun, Table, TableRow, TableCell,
    WidthType, BorderStyle, ShadingType, TableLayoutType
  } = await import('docx');
  const FONT = '宋体', HEI = '黑体';
  const A4 = { width: 11906, height: 16838 };
  const MARGIN = { top: 1440, bottom: 1440, left: 1418, right: 1418 };
  const TEXT_W = A4.width - MARGIN.left - MARGIN.right;
  const kids = [];

  // 标题
  kids.push(new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { before: 120, after: 240, line: 400 },
    children: [new TextRun({ text: session.title || session.chapterTitle, font: HEI, size: 36, bold: true })]
  }));
  kids.push(new Paragraph({
    alignment: AlignmentType.CENTER, spacing: { after: 320 },
    children: [new TextRun({
      text: '（本章草稿 · 仅供验收确认，不按投标文件版式；确认后可粘贴进正式标书重排）',
      font: FONT, size: 18, color: '808080'
    })]
  }));

  const lines = String(session.text || '').split(/\n+/).map((x) => x.trim()).filter(Boolean);
  const chartsByAnchor = (session.charts || []).slice();
  const hintsByAnchor = (session.hints || []).slice();
  const usedChart = new Set(), usedHint = new Set();

  function placeAfter(line) {
    const out = [];
    for (const c of chartsByAnchor) {
      if (usedChart.has(c.id)) continue;
      if (c.afterText && line.includes(String(c.afterText).slice(0, 12))) { out.push({ kind: 'chart', v: c }); usedChart.add(c.id); }
    }
    for (let i = 0; i < hintsByAnchor.length; i++) {
      const h = hintsByAnchor[i];
      if (usedHint.has(i)) continue;
      if (h.afterText && line.includes(String(h.afterText).slice(0, 12))) { out.push({ kind: 'hint', v: h }); usedHint.add(i); }
    }
    return out;
  }

  // 把 AI 给的行列排成真正的 Word 表格（带表头底纹、固定列宽）
  function docTable(t, totalW) {
    const cols = t.columns || [];
    const rows = t.rows || [];
    const weights = cols.map((c, i) => {
      const lens = [String(c).length * 2].concat(rows.map((r) => String(r[i] == null ? '' : r[i]).length));
      return Math.max(6, Math.min(60, Math.round(lens.reduce((a, b) => a + b, 0) / lens.length)));
    });
    const sum = weights.reduce((a, b) => a + b, 0) || 1;
    const widths = weights.map((w) => Math.max(700, Math.round((w / sum) * totalW)));
    const border = { style: BorderStyle.SINGLE, size: 4, color: '808080' };
    const cellP = (text, i, head) => new TableCell({
      width: { size: widths[i], type: WidthType.DXA },
      shading: head ? { type: ShadingType.CLEAR, fill: 'EDF2F7', color: 'auto' } : undefined,
      margins: { top: 60, bottom: 60, left: 90, right: 90 },
      children: [new Paragraph({
        alignment: head ? AlignmentType.CENTER : AlignmentType.LEFT,
        spacing: { line: 300 },
        children: [new TextRun({ text: String(text == null ? '' : text), font: FONT, size: 21, bold: !!head, color: '000000' })]
      })]
    });
    return new Table({
      layout: TableLayoutType.FIXED,
      width: { size: totalW, type: WidthType.DXA },
      columnWidths: widths,
      borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
      rows: [new TableRow({ tableHeader: true, children: cols.map((c, i) => cellP(c, i, true)) })]
        .concat(rows.map((r) => new TableRow({ children: cols.map((_, i) => cellP(r[i], i, false)) })))
    });
  }

  const HEAD1 = /^[一二三四五六七八九十]+[、.．]/;
  const HEAD2 = /^\d+[.．、]/;
  const HEAD3 = /^[(（]\d+[)）]/;

  for (const line of lines) {
    let para;
    if (HEAD1.test(line)) {
      para = new Paragraph({
        spacing: { before: 240, after: 120, line: 400 },
        children: [new TextRun({ text: line, font: HEI, size: 28, bold: true, color: '000000' })]
      });
    } else if (HEAD2.test(line)) {
      para = new Paragraph({
        spacing: { before: 160, after: 90, line: 380 },
        children: [new TextRun({ text: line, font: HEI, size: 26, bold: true, color: '000000' })]
      });
    } else if (HEAD3.test(line)) {
      para = new Paragraph({
        spacing: { before: 120, after: 60, line: 380 },
        children: [new TextRun({ text: line, font: FONT, size: 24, bold: true, color: '000000' })]
      });
    } else {
      para = new Paragraph({
        spacing: { line: 360, after: 60 },
        indent: { firstLine: 480 },
        alignment: AlignmentType.JUSTIFIED,
        children: [new TextRun({ text: line, font: FONT, size: 24, color: '000000' })]
      });
    }
    kids.push(para);
    for (const p of placeAfter(line)) {
      if (p.kind === 'chart') {
        const c = p.v;
        if (c.chartType === 'table' && c.table && c.table.columns.length) {
          kids.push(new Paragraph({
            alignment: AlignmentType.CENTER, spacing: { before: 160, after: 80 },
            children: [new TextRun({ text: c.caption || c.title || '表', font: HEI, size: 22, bold: true, color: '000000' })]
          }));
          kids.push(docTable(c.table, TEXT_W));
          if (c.reason) kids.push(new Paragraph({
            spacing: { after: 160 }, alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: '说明：' + c.reason, font: FONT, size: 18, color: '808080' })]
          }));
          continue;
        }
        try {
          const buf = fs.readFileSync(c.png);
          const maxW = 580;
          const w = Math.min(maxW, c.width || maxW);
          const h = Math.round((c.height || 300) * (w / (c.width || maxW)));
          kids.push(new Paragraph({
            alignment: AlignmentType.CENTER, spacing: { before: 160, after: 60 },
            children: [new ImageRun({ type: 'png', data: buf, transformation: { width: w, height: h } })]
          }));
          kids.push(new Paragraph({
            alignment: AlignmentType.CENTER, spacing: { after: 60 },
            children: [new TextRun({ text: (c.caption || c.title || '图') + '（示意图，数值依据招标文件与本项目方案）', font: FONT, size: 20, color: '404040' })]
          }));
          if (c.reason) kids.push(new Paragraph({
            alignment: AlignmentType.CENTER, spacing: { after: 160 },
            children: [new TextRun({ text: '说明：' + c.reason, font: FONT, size: 18, color: '808080' })]
          }));
        } catch { /* 图片丢了就跳过 */ }
      } else {
        kids.push(new Paragraph({
          spacing: { before: 120, after: 120, line: 320 },
          shading: { type: ShadingType.CLEAR, fill: 'FFF1E0', color: 'auto' },
          border: {
            top: { style: BorderStyle.SINGLE, size: 8, color: 'ED8936' },
            bottom: { style: BorderStyle.SINGLE, size: 8, color: 'ED8936' },
            left: { style: BorderStyle.SINGLE, size: 8, color: 'ED8936' },
            right: { style: BorderStyle.SINGLE, size: 8, color: 'ED8936' }
          },
          indent: { left: 120, right: 120 },
          children: [new TextRun({ text: '⚠ ' + p.v.text, font: HEI, size: 22, bold: true, color: 'C05621' })]
        }));
      }
    }
  }

  // 没挂上锚点的图 / 提示，统一放到文末
  const restCharts = (session.charts || []).filter((c) => !usedChart.has(c.id));
  if (restCharts.length) {
    kids.push(new Paragraph({ spacing: { before: 300, after: 120 }, children: [new TextRun({ text: '附：建议插入的图（位置未定，请按内容自行摆放）', font: HEI, size: 26, bold: true })] }));
    for (const c of restCharts) {
      if (c.chartType === 'table' && c.table && c.table.columns.length) {
        kids.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120, after: 80 }, children: [new TextRun({ text: c.caption || c.title || '表', font: HEI, size: 22, bold: true, color: '000000' })] }));
        kids.push(docTable(c.table, TEXT_W));
        continue;
      }
      try {
        const buf = fs.readFileSync(c.png);
        const maxW = 560;
        const w = Math.min(maxW, c.width || maxW);
        const h = Math.round((c.height || 300) * (w / (c.width || maxW)));
        kids.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120, after: 60 }, children: [new ImageRun({ type: 'png', data: buf, transformation: { width: w, height: h } })] }));
        kids.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 120 }, children: [new TextRun({ text: (c.caption || c.title || '图') + '（示意图）', font: FONT, size: 20, color: '404040' })] }));
      } catch {}
    }
  }
  const restHints = (session.hints || []).filter((h, i) => !usedHint.has(i));
  if (restHints.length) {
    kids.push(new Paragraph({ spacing: { before: 300, after: 120 }, children: [new TextRun({ text: '附：需要你补充的材料', font: HEI, size: 26, bold: true })] }));
    restHints.forEach((h) => kids.push(new Paragraph({
      spacing: { after: 80, line: 320 },
      children: [new TextRun({ text: '⚠ ' + h.text, font: FONT, size: 22, color: 'C05621' })]
    })));
  }

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: 24 } } } },
    sections: [{ properties: { page: { size: { width: A4.width, height: A4.height }, margin: MARGIN } }, children: kids }]
  });
  const buf = await Packer.toBuffer(doc);
  const dir = outDir || defaultOutDir(project);
  fs.mkdirSync(dir, { recursive: true });
  const ts = stamp();
  const name = safeName((session.title || session.chapterTitle || '章节').slice(0, 24)) + '_' + ts + '.docx';
  const file = path.join(dir, name);
  fs.writeFileSync(file, buf);
  session.outDir = dir;
  session.exports = (session.exports || []).concat([{ at: nowIso(), file }]).slice(-30);
  saveSession(session);
  return { file, dir, bytes: buf.length };
}

export function defaultOutDir(project) {
  const d = path.join(PROJECT_DIR, project.dir || '', '03制作', '独立编制');
  return d;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes());
}

/* ---------------- 写回本章正文 ---------------- */
export function writeBack(session, draft, docKey) {
  const doc = draft.docs[docKey];
  if (!doc) throw new Error('找不到这份投标文件');
  const c = (doc.chapters || []).find((x) => x.id === session.chapterId);
  if (!c) throw new Error('这一章已经不在了（可能你重新生成了框架）');
  c.body = session.text;
  c.source = 'ai';
  c.updatedAt = nowIso();
  c.fromIndep = true;
  doc.updatedAt = nowIso();
  return c;
}

/* ---------------- 本机环境自检 ---------------- */
const ENV_ITEMS = [
  { key: 'browser', name: '浏览器（用来把示意图画成图片）', need: true, url: 'https://www.google.cn/chrome/' },
  { key: 'word', name: 'Microsoft Word（用来把 docx 转 PDF、检查排版）', need: false, url: 'https://www.microsoft.com/zh-cn/microsoft-365/word' },
  { key: 'node', name: 'Node.js（工作台自身运行环境）', need: true, url: 'https://nodejs.org/zh-cn' },
  { key: 'python', name: 'Python（可选，做文档转换备用）', need: false, url: 'https://www.python.org/downloads/' }
];

export async function envCheck() {
  const out = [];
  const b = browserStatus();
  out.push({ ...ENV_ITEMS[0], ok: b.ok, detail: b.ok ? b.name : '没找到 Chrome 或 Edge' });
  // Word
  let wordOk = false, wordDetail = '';
  try {
    const { execFile } = await import('node:child_process');
    const r = await new Promise((resolve) => {
      execFile('reg', ['query', 'HKEY_CLASSES_ROOT\\Word.Application\\CLSID'], { windowsHide: true, timeout: 8000 }, (e, so) => resolve({ e, so }));
    });
    wordOk = !r.e && /Word\.Application/.test(String(r.so || ''));
    wordDetail = wordOk ? '已安装' : '未检测到（不影响生成，只是不能自动转 PDF）';
  } catch { wordDetail = '未检测到'; }
  out.push({ ...ENV_ITEMS[1], ok: wordOk, detail: wordDetail });
  out.push({ ...ENV_ITEMS[2], ok: true, detail: process.version });
  let pyOk = false, pyDetail = '';
  try {
    const { execFile } = await import('node:child_process');
    const r = await new Promise((resolve) => {
      execFile('python', ['--version'], { windowsHide: true, timeout: 8000 }, (e, so, se) => resolve({ e, so, se }));
    });
    pyOk = !r.e;
    pyDetail = pyOk ? String(r.so || r.se || '').trim() : '未安装（可选）';
  } catch { pyDetail = '未安装（可选）'; }
  out.push({ ...ENV_ITEMS[3], ok: pyOk, detail: pyDetail });
  return out;
}
