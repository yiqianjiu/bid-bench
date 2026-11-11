// 模块4：AI 逐条核查 + 深度模拟评标
import { callJson } from './ai.mjs';
import { isFatalClause } from './fatalScan.mjs';

// 每份文件要对照招标文件的哪些板块
const REQ_MAP = {
  price: ['format', 'sign', 'fatal'],
  biz: ['format', 'sign', 'fatal', 'business', 'tech', 'deliver', 'conform', 'score'],
  qual: ['format', 'sign', 'fatal', 'qualify', 'conform'],
  merged: ['format', 'sign', 'fatal', 'frontTable', 'qualify', 'conform', 'score', 'business', 'tech', 'deliver', 'other']
};

// 印刷/密封/现场递交类要求无法从电子文件核查，不参与逐条比对（界面另行提示）
const SKIP_SECTIONS = ['print', 'onsite'];

export function reqSectionsFor(kind) {
  return REQ_MAP[kind] || REQ_MAP.merged;
}

function secMap(analysis) {
  if (!analysis || !Array.isArray(analysis.sections)) return new Map();
  return new Map(analysis.sections.map((s) => [s.key, s]));
}

function itemText(it) {
  if (it.text) return String(it.text);
  if (Array.isArray(it.cells)) return it.cells.filter(Boolean).join(' ｜ ');
  return '';
}

// 前附表里有些格子只是「招标代理机构 | 某某公司」「资金来源 | 自有资金」这类信息值，
// 不是对投标人提出的要求，拿去逐条比对只会产生误报，这里排除掉。
function looksLikeInfoValue(text, sec) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return true;
  const hasNumber = /[0-9０-９]/.test(t);
  const hasVerb = /(应|须|必须|不得|应当|禁止|要求|提供|提交|提交|加盖|签字|盖章|装订|密封|份数|有效期|保证金|金额|费率|比例|评分|得分|扣分|不少于|不超过|至少|以内|以上|以下|之前|之前|前完成|日历天|工作日)/.test(t);
  if (sec === 'frontTable') {
    // 前附表：必须带数字、带要求性动词，或者讲到份数/时间/金额，才算一条要求
    return !(hasNumber || hasVerb);
  }
  // 其它板块：排除只有单位/机构名、没有人称要求的短词
  if (t.length <= 12 && !hasNumber && !hasVerb && /(公司|中心|院|所|大学|集团|研究所|银行|平台)$/.test(t)) return true;
  if (t.length <= 6 && !hasNumber && !hasVerb) return true;
  return false;
}

// 把招标文件要求摊平成清单
export function flattenRequirements(analysis, kind) {
  const map = secMap(analysis);
  const keys = reqSectionsFor(kind).filter((k) => !SKIP_SECTIONS.includes(k));
  const out = [];
  for (const k of keys) {
    const sec = map.get(k);
    if (!sec) continue;
    for (const it of sec.items || []) {
      const text = itemText(it).trim();
      if (!text) continue;
      if (looksLikeInfoValue(text, k)) continue;
      out.push({
        n: out.length + 1,
        sec: k,
        secTitle: sec.title || k,
        text,
        page: it.page == null ? null : Number(it.page),
        star: !!it.isStar,
        fatal: !!it.isFatal,
        fatalByRule: isFatalClause(text)
      });
    }
  }
  return out;
}

// 投标文件正文（带页码标记），超长时截断并注明
export function buildDocContext(pages, budget) {
  const parts = [];
  let used = 0;
  let cut = 0;
  for (const p of pages) {
    const t = String(p.text || '').replace(/\n{2,}/g, '\n').trim();
    if (!t) continue;
    const seg = '[第' + p.page + '页] ' + t;
    if (used + seg.length > budget) { cut++; continue; }
    used += seg.length;
    parts.push(seg);
  }
  const tail = cut ? '\n……（正文较长，还有 ' + cut + ' 页没放进本次核对范围；若某条判断不出，按「部分响应」并注明需人工确认）' : '';
  return { text: parts.join('\n'), chars: used, omittedPages: cut };
}

// ---------- 全文检索：按相关度挑页 ----------
// 长标书动辄上百页，整份塞不进去；这里改成「先定位、再给原文」，
// 免得像以前那样只取前半本、后半本的报价和业绩材料根本没看。
function normTxt(s) {
  return String(s || '').replace(/[\s\u3000]+/g, '').replace(/[，。、；：""''（）()《》【】\[\]·—\-_.\/\\|]/g, '').toLowerCase();
}

function bgSet(text) {
  const t = normTxt(text);
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}

function prepareUnits(pages) {
  return (pages || [])
    .map((p) => ({ page: p.page, text: String(p.text || '').replace(/\n{2,}/g, '\n').trim(), set: null }))
    .filter((u) => u.text);
}

function unitSet(u) {
  if (!u.set) u.set = bgSet(u.text);
  return u.set;
}

function pickPages(units, qText, budget, mustPages) {
  const q = bgSet(qText);
  const scored = units
    .map((u) => {
      const set = unitSet(u);
      let hit = 0;
      for (const g of q) if (set.has(g)) hit++;
      return { u, s: hit / Math.sqrt(u.text.length || 1) };
    })
    .sort((a, b) => b.s - a.s);
  const picked = new Set();
  let chars = 0;
  const take = (u) => {
    if (!u || picked.has(u.page)) return;
    if (chars + u.text.length + 12 > budget) return;
    picked.add(u.page);
    chars += u.text.length + 12;
  };
  for (const n of mustPages || []) take(units.find((x) => x.page === n));
  for (const it of scored) {
    if (it.s <= 0.0001) break;
    take(it.u);
  }
  if (!picked.size) for (const u of units.slice(0, 6)) take(u);
  const list = units.filter((u) => picked.has(u.page)).sort((a, b) => a.page - b.page);
  return { text: list.map((u) => '[第' + u.page + '页] ' + u.text).join('\n'), pages: list.map((u) => u.page), chars, used: list.length };
}

// 找投标文件里的「评分索引表 / 评审索引 / 响应索引」这类对照表
const INDEX_RE = /(评分|评审|打分|得分)[^\n]{0,12}(索引|对照表|导航|一览表|明细)|(索引|对照表)[^\n]{0,12}(评分|评审)/;

export function detectScoreIndex(pages, scoreItems) {
  const names = (scoreItems || [])
    .map((it) => ((Array.isArray(it.cells) && it.cells[1]) || '').trim())
    .filter((x) => x && x.length >= 2);
  const hitPages = [];
  const chunks = [];
  let chars = 0;
  for (const p of pages || []) {
    const t = String(p.text || '');
    if (!t.trim()) continue;
    const re = INDEX_RE.test(t);
    let nameHits = 0;
    for (const n of names) if (t.includes(n.slice(0, 8))) nameHits++;
    if (!re && nameHits < 2) continue;
    hitPages.push(p.page);
    const seg = '[第' + p.page + '页] ' + t.trim();
    if (chars + seg.length <= 6000) { chunks.push(seg); chars += seg.length; }
  }
  return { found: hitPages.length > 0, pages: hitPages.slice(0, 6), text: chunks.join('\n') };
}

function buildScoreContext(units, indexInfo, item, budget) {
  const std = itemText(item) + ' ' + (Array.isArray(item.cells) ? item.cells.filter(Boolean).join(' ') : '');
  const must = (indexInfo && indexInfo.found ? indexInfo.pages : []).concat(units.slice(0, 2).map((u) => u.page));
  const pick = pickPages(units, std, budget || 42000, must);
  const parts = [];
  if (indexInfo && indexInfo.found) {
    parts.push('【投标文件里的评分索引表（第 ' + indexInfo.pages.join('、') + ' 页）】\n' + indexInfo.text);
  }
  parts.push('【全文检索到的、与本题最相关的内容（用到 ' + pick.used + ' 页 / 全文 ' + units.length + ' 页，按页码排序）】\n' + pick.text);
  return {
    text: parts.join('\n\n'),
    usedPages: pick.used,
    omitted: Math.max(0, units.length - pick.used),
    indexFound: !!(indexInfo && indexInfo.found),
    indexPages: (indexInfo && indexInfo.pages) || []
  };
}

function batchRequirements(list, maxItems, maxChars) {
  const batches = [];
  let cur = [];
  let chars = 0;
  for (const it of list) {
    const len = it.text.length + 40;
    if (cur.length && (cur.length >= maxItems || chars + len > maxChars)) {
      batches.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(it);
    chars += len;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

async function pool(tasks, limit, onStep) {
  const out = new Array(tasks.length);
  let idx = 0;
  let done = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= tasks.length) return;
      out[i] = await tasks[i]();
      done++;
      if (onStep) onStep(done, tasks.length);
    }
  });
  await Promise.all(workers);
  return out;
}

const SYSTEM_REQ_CHECK = `你是政府采购与工程招标的评标专家。你的任务是：严格按照招标文件的要求，逐条核对投标文件是否作出响应，一条都不能漏。

判断标准（只能依据给你的投标文件原文，不得臆测、不得因为"一般都会写"就判定通过）：
- 2 = 完全响应：投标文件里有明确的对应内容、材料或表述，能看出满足要求。
- 1 = 部分响应：提到了但不完整（缺关键要素、缺证明材料、缺签章、只写"满足"没有具体内容），或者这条要求属于装订/密封/现场递交等电子文件无法体现的，一并标 1 并说明需现场确认。
- 0 = 未响应：在投标文件里找不到对应内容。

硬性要求：
- 每一条判 2 或 1 的，必须在 e 里抄一段投标文件里的证据原句；e 为空的不许判 2。
- 标 [废标] / [条款含废标后果] 的条目：只要投标文件里没有明确对应内容，或招标要求的证明材料/证书/凭证没出现在文件里，一律判 0，不得因为「这类材料一般都会提供」判 1 或 2。只有文字提到了、只是不完整（缺签名、缺页、写"满足"但无实质内容）才判 1。
- 标 [废标] 的条目判 1 或 0 时，note 必须直接写明「不满足将被判废标」；标 [★] 的条目是实质性条款，负偏离同样可能被判无效，note 要写明风险。

输出要求：严格 JSON，不要任何解释文字。对给你的每一条编号 n 都要有一条结果，不得遗漏、不得新增编号。
{"results":[{"n":1,"s":2,"e":"投标文件里的证据原句，最多40字，没有就留空","note":"缺什么或为什么只给1/0，最多40字"}],"overview":"对这份文件响应情况的一句话总评，最多60字"}`;

function reqUser(project, list, docText, docName) {
  const lines = list.map((it) => {
    const mark = (it.fatal ? '[废标]' : '') + (it.fatalByRule && !it.fatal ? '[条款含废标后果]' : '') + (it.star ? '[★]' : '');
    const pg = it.page ? '[招标第' + it.page + '页]' : '';
    return it.n + '. ' + mark + pg + '（' + it.secTitle + '）' + it.text.slice(0, 400);
  }).join('\n');
  return `【项目】${project.name || ''}　招标编号：${project.code || '—'}

【招标文件要求清单】共 ${list.length} 条
${lines}

【待核查的投标文件：${docName}】
${docText}
`;
}

function tryParseList(data) {
  const rows = Array.isArray(data) ? data : (data && (data.results || data.items)) || [];
  return Array.isArray(rows) ? rows : [];
}

// 逐条核查（分批并发）
export async function aiRequirementCheck(project, analysis, pages, docName, onStep) {
  const reqs = flattenRequirements(analysis, docName ? guessKind(docName) : 'merged');
  if (!reqs.length) return null;
  const units = prepareUnits(pages);
  const batches = batchRequirements(reqs, 55, 7000);
  const byN = new Map(reqs.map((r) => [r.n, r]));
  const results = new Map();
  let overview = '';
  let failed = 0;
  let maxOmitted = 0;

  const tasks = batches.map((batch, bi) => async () => {
    if (onStep) onStep('正在逐条核对招标要求（第 ' + (bi + 1) + ' / ' + batches.length + ' 批，' + batch.length + ' 条）');
    // 每批按其自身要求去全文检索最相关的页，不再只喂前半本
    const pick = pickPages(units, batch.map((x) => x.text).join('\n'), 48000, units.slice(0, 2).map((u) => u.page));
    if (units.length - pick.used > maxOmitted) maxOmitted = units.length - pick.used;
    const user = reqUser(project, batch, pick.text, docName);
    let data = null;
    for (let attempt = 0; attempt < 2 && !data; attempt++) {
      try {
        data = await callJson(SYSTEM_REQ_CHECK, user, { maxTokens: 9000, temperature: 0.1, timeoutMs: 300000, purpose: 'check' });
      } catch (e) {
        if (attempt === 1) { failed++; return; }
      }
    }
    if (!data) return;
    if (data.overview && !overview) overview = String(data.overview).slice(0, 120);
    for (const r of tryParseList(data)) {
      const n = Number(r.n);
      if (!byN.has(n)) continue;
      const s = Number(r.s);
      results.set(n, {
        s: s === 2 ? 2 : s === 1 ? 1 : 0,
        e: String(r.e || '').slice(0, 120),
        note: String(r.note || '').slice(0, 160)
      });
    }
  });

  await pool(tasks, 3, (d, total) => { if (onStep) onStep('正在逐条核对招标要求（已完成 ' + d + ' / ' + total + ' 批）'); });

  const items = reqs.map((r) => {
    const got = results.get(r.n) || { s: 1, e: '', note: '这一条没有核对结果，请人工确认' };
    return { ...r, s: got.s, evidence: got.e, note: got.note };
  });
  const stat = {
    total: items.length,
    ok: items.filter((x) => x.s === 2).length,
    partial: items.filter((x) => x.s === 1).length,
    missing: items.filter((x) => x.s === 0).length,
    missFatal: items.filter((x) => x.s === 0 && (x.fatal || x.star || x.fatalByRule)).length,
    // 废标/实质性条款判「部分响应」也是风险（缺材料、缺签章），单独计数给界面提示
    riskyFatal: items.filter((x) => x.s === 1 && (x.fatal || x.fatalByRule || x.star)).length,
    omittedPages: maxOmitted
  };
  return { items, stat, overview, failedBatches: failed };
}

function guessKind(name) {
  const n = String(name || '');
  if (/价格|报价|开标一览/.test(n) && !/商务技术/.test(n)) return 'price';
  if (/商务技术/.test(n)) return 'biz';
  if (/资格证明/.test(n)) return 'qual';
  return 'merged';
}

export { guessKind };

// ---------- 深度模拟评标 ----------
const SYSTEM_SCORE_DEEP = `你是政府采购与工程招标的资深评标专家兼投标顾问。现在只针对【一个评分项】，深入分析投标文件能拿多少分，并给出可执行的提分办法。

要求：
1. 把该评分项的评分标准拆成若干"得分点"（例如：数量要求、时间范围、证明材料、签章、专业/职称、原件扫描件等），一个都不能漏。
2. 每个得分点判断投标文件是否提供、是否完整，引用投标文件原句作为证据（最多 50 字），并给出该得分点应得的分数。
3. 得分点分数之和必须等于该项总分 got，不得超过满分。
4. 明确写出失分点、失分原因，以及"具体怎么补"——补哪份材料、在哪一章补写什么内容、补了能多拿几分。
5. 只依据给你的投标文件原文判断，正文里没有的按不得分处理，不要臆测、不要假设"应该有"。
6. 投标文件对同一个评分项的内容，可能分散在全文件很多地方（例如业绩在附件、人员在汇总表、资质在资格部分），不一定单列一章。你拿到的是全文检索出的最相关页面 +（如果有的话）评分索引表，请综合这些页判断；只有这些页里确实都找不到，才判不得分，并在 note 里写明"全文未检索到"。
7. 如果给了评分索引表：先按索引定位，再用原文复核。索引写的页码和实际内容对不上时，以实际原文为准，并把它作为 risk 提出来。
8. 报价类评分项注意算数一致性（总价=分项合计、大写=小写、是否超预算），这些必须逐项验算后给分。

只输出 JSON，不要解释文字：
{"name":"评分项名称","max":10,"got":6,"reason":"本项得分理由，最多80字",
"breakdown":[{"point":"得分点要求","need":"需要什么证明材料","found":true,"evidence":"投标文件里的证据原句","page":12,"judge":"得分|部分得分|不得分","score":2,"note":"判断说明"}],
"lost":[{"point":"失分点","why":"缺什么","fix":"具体补什么、补在哪儿","gain":2}],
"risk":["评委可能判定不响应的风险点"],
"improve":"按上述修改后预计得分，如：可从6分提到9分"}`;

function scoreUser(project, scoreItem, docText, docName, meta) {
  const std = itemText(scoreItem);
  const cells = Array.isArray(scoreItem.cells) ? scoreItem.cells : [];
  const m = meta || {};
  const idx = m.indexFound
    ? '【定位方式】这份投标文件编制了评分索引表（第 ' + (m.indexPages || []).join('、') + ' 页），下面已把索引表给你：先按索引写明的章节/页码定位，再用后面的原文证据复核；索引与实际内容不一致时以实际原文为准，并写进 risk。'
    : '【定位方式】这份投标文件没有评分索引表，相关内容可能分散在全文件任何位置。下面给的是按本题关键词在整份文件（' + (m.docPages || '?') + ' 页）里检索出的最相关页面，请据此判断，不要假设内容一定集中在某一章。';
  return `【项目】${project.name || ''}　招标编号：${project.code || '—'}　预算：${project.budget || '—'}

【评分项】${cells[1] || ''}　分值：${cells[2] || ''}
【评分标准原文（招标文件第 ${scoreItem.page || '?'} 页）】
${std}

${idx}

【投标文件：${docName}（全文 ${m.docPages || '?'} 页，本次给你 ${m.usedPages || '?'} 页）】
${docText}
`;
}

export async function aiDeepScore(project, analysis, pages, docName, onStep) {
  const map = secMap(analysis);
  const sec = map.get('score');
  const list = (sec && sec.items) || [];
  if (!list.length) return null;
  const units = prepareUnits(pages);
  const indexInfo = detectScoreIndex(pages, list);
  const out = [];
  let failed = 0;
  let maxOmitted = 0;
  let ctxUsedSum = 0;

  const tasks = list.map((it) => async () => {
    const name = (Array.isArray(it.cells) && it.cells[1]) || String(it.text || '').slice(0, 20);
    if (onStep) onStep('正在深度分析评分项：' + name);
    // 每个评分项单独在全文里检索强关联内容；有索引表就先给索引表，再给原文复核
    const ctx = buildScoreContext(units, indexInfo, it, 42000);
    if (ctx.omitted > maxOmitted) maxOmitted = ctx.omitted;
    ctxUsedSum += ctx.usedPages;
    const user = scoreUser(project, it, ctx.text, docName, { docPages: units.length, usedPages: ctx.usedPages, indexFound: ctx.indexFound, indexPages: ctx.indexPages });
    let data = null;
    for (let attempt = 0; attempt < 2 && !data; attempt++) {
      try {
        data = await callJson(SYSTEM_SCORE_DEEP, user, { maxTokens: 9000, temperature: 0.2, timeoutMs: 300000, purpose: 'score' });
      } catch (e) {
        if (attempt === 1) { failed++; data = null; }
      }
    }
    const max = Number((Array.isArray(it.cells) && String(it.cells[2]).replace(/\D/g, '')) || 0) || 0;
    if (!data) {
      out.push({ name, max, got: null, reason: '这一项没能分析成功，请点「重新核查」再试', breakdown: [], lost: [], risk: [], improve: '' });
      return;
    }
    const bd = (Array.isArray(data.breakdown) ? data.breakdown : []).map((x) => ({
      point: String(x.point || ''),
      need: String(x.need || ''),
      found: x.found === true || x.found === 'true',
      evidence: String(x.evidence || ''),
      page: x.page == null || x.page === '' ? null : Number(x.page),
      judge: String(x.judge || ''),
      score: Number(x.score) || 0,
      note: String(x.note || '')
    }));
    let got = Number(data.got);
    if (!isFinite(got)) got = bd.reduce((a, b) => a + (b.score || 0), 0);
    if (max) got = Math.max(0, Math.min(max, got));
    out.push({
      name: String(data.name || name),
      max,
      got,
      reason: String(data.reason || ''),
      breakdown: bd,
      lost: (Array.isArray(data.lost) ? data.lost : []).map((x) => ({
        point: String(x.point || ''),
        why: String(x.why || ''),
        fix: String(x.fix || ''),
        gain: Number(x.gain) || 0
      })),
      risk: (Array.isArray(data.risk) ? data.risk : []).map(String),
      improve: String(data.improve || '')
    });
  });

  await pool(tasks, 3, (d, total) => { if (onStep) onStep('正在深度分析评分项（已完成 ' + d + ' / ' + total + ' 项）'); });

  const items = out.filter(Boolean);
  const know = items.filter((x) => x.got != null);
  const total = know.reduce((a, b) => a + (b.got || 0), 0);
  const full = items.reduce((a, b) => a + (b.max || 0), 0);
  const tips = items.flatMap((x) => (x.lost || []).map((l) => ({ ...l, item: x.name })))
    .sort((a, b) => (b.gain || 0) - (a.gain || 0))
    .slice(0, 12);
  const pct = full ? Math.round((total / full) * 100) : 0;
  return {
    items,
    total,
    full,
    pct,
    tips,
    failedItems: failed,
    overview: '按评分表逐项拆解后预估得分 ' + total + ' / ' + full + ' 分（' + pct + '%）。',
    omittedPages: maxOmitted,
    docPages: units.length,
    avgUsedPages: items.length ? Math.round(ctxUsedSum / items.length) : 0,
    indexFound: indexInfo.found,
    indexPages: indexInfo.pages
  };
}
