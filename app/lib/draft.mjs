import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';
import { uid, nowIso } from './util.mjs';
import { callJson, callText } from './ai.mjs';
import { SYSTEM_DRAFT, draftUserPrompt } from './prompt.mjs';

export const DRAFT_DIR = path.join(DATA_DIR, '制作');
const TASKS_DIR = path.join(DRAFT_DIR, '.tasks');
export function ensureDraftDirs() {
  [DRAFT_DIR, TASKS_DIR].forEach((d) => fs.mkdirSync(d, { recursive: true }));
}
ensureDraftDirs();

const draftFile = (pid) => path.join(DRAFT_DIR, pid + '.json');

export function loadDraft(pid) {
  try { return JSON.parse(fs.readFileSync(draftFile(pid), 'utf8')); } catch { return null; }
}
export function saveDraft(pid, d) {
  d.updatedAt = nowIso();
  fs.writeFileSync(draftFile(pid), JSON.stringify(d, null, 1), 'utf8');
  return d;
}

export const DOC_META = {
  price: { title: '价格文件', short: '价格' },
  biz: { title: '商务技术文件', short: '商务技术' },
  qual: { title: '资格证明文件', short: '资格证明' },
  merged: { title: '投标文件（合并版）', short: '合并' },
};
export const DOC_ORDER = ['price', 'biz', 'qual'];

function ch(title, type, hint, words) {
  return { id: uid('c_'), title, type: type || 'normal', hint: hint || '', words: words || 450, body: '', source: '', level: 0, number: '', noIdx: false, updatedAt: '' };
}

// 用上传的 Word 结构整份替换章节（保留封面/目录在前），并留一份自动框架备份供「恢复自动框架」
export function applyUploadedOutline(doc, outline, fileName) {
  const cover = (doc.chapters || []).find((c) => c.type === 'cover') || ch('封面', 'cover');
  const toc = (doc.chapters || []).find((c) => c.type === 'toc') || ch('目录', 'toc');
  if (!doc.autoBackup || !doc.autoBackup.length) {
    doc.autoBackup = JSON.parse(JSON.stringify((doc.chapters || []).filter((c) => c.type !== 'cover' && c.type !== 'toc')));
    doc.autoBackupAt = nowIso();
  }
  const list = [cover, toc];
  for (const c of outline) {
    const t = String(c.title || '').trim();
    if (!t) continue;
    const item = ch(t, 'normal', '', 0);
    item.body = String(c.body || '').trim();
    item.level = Number(c.level) || 1;
    // 保留 Word 里原本的自动编号（如「1」「5.1」）；分部标题（资格审查部分/商务部分/技术部分）本来就没编号
    item.number = String(c.number == null ? '' : c.number);
    item.noIdx = true; // 上传的标书按原编号显示，不再用数组下标重新编号
    item.source = 'upload';
    item.updatedAt = nowIso();
    list.push(item);
  }
  doc.chapters = list;
  doc.built = true;
  doc.source = 'upload';
  doc.importedAt = nowIso();
  doc.importFileName = fileName || '';
  doc.updatedAt = nowIso();
  return doc;
}

export function restoreAutoOutline(doc) {
  if (!doc.autoBackup || !doc.autoBackup.length) return null;
  const cover = (doc.chapters || []).find((c) => c.type === 'cover') || ch('封面', 'cover');
  const toc = (doc.chapters || []).find((c) => c.type === 'toc') || ch('目录', 'toc');
  doc.chapters = [cover, toc, ...JSON.parse(JSON.stringify(doc.autoBackup))];
  doc.source = 'auto';
  doc.updatedAt = nowIso();
  return doc;
}

const OUTLINES = {
  price: () => [
    ch('封面', 'cover'),
    ch('目录', 'toc'),
    ch('开标一览表', 'priceTable'),
    ch('投标报价明细（价格构成表）', 'priceTable2'),
  ],
  biz: () => [
    ch('封面', 'cover'),
    ch('目录', 'toc'),
    ch('商务评审索引表', 'index', '按招标文件商务条款逐条索引', 0),
    ch('技术评审索引表', 'index', '按招标文件技术要求逐条索引', 0),
    ch('投标函', 'normal', '按招标文件给定格式编写投标函，承诺投标有效期、报价有效、接受招标文件全部条款。', 600),
    ch('法定代表人身份证明', 'normal', '写明法定代表人姓名、职务、身份证号，附身份证复印件位置说明。姓名与证件号用【请填写】占位。', 350),
    ch('授权委托书', 'normal', '写明授权代表姓名、身份证号、授权范围与期限，声明由此产生的法律责任由我方承担。', 400),
    ch('商务条款响应及偏离表', 'deviation'),
    ch('技术条款响应及偏离表', 'deviation'),
    ch('投标人基本情况', 'normal', '介绍企业成立时间、注册资本、经营范围、组织机构、人员规模、资质荣誉，紧扣资格与商务评分点。', 700),
    ch('类似项目业绩', 'normal', '按招标文件业绩要求逐项列出类似项目，一项一条，写明项目名称、采购人、合同金额、时间、服务内容；无数据处用【请填写】占位。', 700),
    ch('财务状况与纳税社保', 'normal', '说明近年度财务审计情况、依法纳税与缴纳社保情况，呼应资格性审查与商务评分。', 500),
    ch('技术方案', 'normal', '这是技术标主体，必须逐条响应技术要求，写清总体思路、技术路线、实施方法、资源配置，覆盖技术评分要点。', 1600),
    ch('项目实施与进度计划', 'normal', '写清项目组织、人员分工、实施阶段划分、进度安排与里程碑、与采购人的配合机制。', 900),
    ch('质量保证措施', 'normal', '写清质量管理体系、过程控制、检验与验收、质量责任与追溯，呼应质量相关评分点。', 800),
    ch('售后服务与承诺', 'normal', '写清服务响应时限、服务方式、质保期、培训、备品备件、应急处理、服务网点与人员。', 800),
    ch('其他材料', 'normal', '补充招标文件要求但前述章节未覆盖的材料，如廉洁承诺、保密承诺、中小企业声明等。', 500),
  ],
  qual: () => [
    ch('封面', 'cover'),
    ch('目录', 'toc'),
    ch('资格证明文件索引表', 'index', '按资格性审查表逐条索引', 0),
    ch('营业执照', 'normal', '说明营业执照载明的名称、统一社会信用代码、住所、法定代表人、注册资本、成立日期、经营范围，并注明复印件加盖公章。', 350),
    ch('资质证书', 'normal', '逐项列出招标文件要求的资质证书名称、等级、编号、有效期、发证机关；无证书处用【请填写】占位。', 400),
    ch('财务状况报告', 'normal', '说明近年度经审计的财务报表情况、资产负债与盈利情况、无重大亏损声明。', 400),
    ch('依法缴纳税收和社会保障资金证明', 'normal', '说明近若干月纳税凭证与社保缴纳凭证情况，声明依法纳税与缴纳社保、无欠缴。', 350),
    ch('类似项目业绩证明', 'normal', '逐项列出符合资格要求的业绩，附合同或验收证明的位置说明。', 450),
    ch('拟投入项目人员', 'normal', '列出项目负责人及主要人员姓名、职务、职称、执业资格、类似项目经验；姓名与证书编号用【请填写】占位。', 600),
    ch('信用记录与无重大违法声明', 'normal', '声明未被列入失信被执行人、重大税收违法案件当事人名单、政府采购严重违法失信行为记录名单，并说明查询渠道。', 400),
    ch('其他资格证明材料', 'normal', '补充招标文件资格性审查表要求但前述未覆盖的证明材料。', 400),
  ],
};

function mergedOutline() {
  const biz = OUTLINES.biz().filter((c) => c.type !== 'cover' && c.type !== 'toc');
  const qual = OUTLINES.qual().filter((c) => c.type !== 'cover' && c.type !== 'toc' && c.type !== 'index');
  const price = OUTLINES.price().filter((c) => c.type !== 'cover' && c.type !== 'toc');
  return [
    ch('封面', 'cover'),
    ch('目录', 'toc'),
    ...price,
    ch('资格证明文件索引表', 'index', '按资格性审查表逐条索引', 0),
    ...qual,
    ...biz,
  ];
}

export function makeDoc(key) {
  const meta = DOC_META[key];
  const list = key === 'merged' ? mergedOutline() : OUTLINES[key]();
  return { key, title: meta.title, chapters: list, built: false, createdAt: nowIso(), updatedAt: nowIso() };
}

export function ensureDraft(pid, mode) {
  let d = loadDraft(pid);
  if (d) {
    if (mode && mode !== d.mode) { d.mode = mode; saveDraft(pid, d); }
    return d;
  }
  d = { projectId: pid, mode: mode || 'split', docs: {}, createdAt: nowIso() };
  const keys = d.mode === 'merged' ? ['merged'] : DOC_ORDER;
  keys.forEach((k) => { d.docs[k] = makeDoc(k); });
  return saveDraft(pid, d);
}

function normKey(s) { return String(s || '').replace(/[\s　:：、，,。.（）()《》★＊*]/g, ''); }

function bgSet(s) {
  const t = String(s || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}
function bgScore(a, b) {
  const A = bgSet(a), B = bgSet(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  A.forEach((x) => { if (B.has(x)) hit++; });
  return hit / Math.max(A.size, B.size);
}
// 最长公共子序列占比：用于判断「短标题是否只是长标题去掉了若干修饰词」
function lcsRatio(a, b) {
  if (!b.length) return 0;
  const dp = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[b.length] / b.length;
}

function bestMatch(pool, nc) {
  const nt = normKey(nc.title);
  let best = null, bestScore = 0;
  pool.forEach((oc) => {
    const ot = normKey(oc.title);
    let s = 0;
    if (ot === nt) s = 1;
    else if (nc.type === 'index' || nc.type === 'deviation') {
      s = (oc.type === nc.type && ot.slice(0, 6) === nt.slice(0, 6)) ? 1 : 0;
    }
    if (!s) {
      if (ot.length >= 4 && nt.length >= 4 && (ot.includes(nt) || nt.includes(ot))) s = 0.85;
      else s = bgScore(ot, nt);
    }
    if (s > bestScore) { bestScore = s; best = oc; }
  });
  return bestScore >= 0.5 ? best : null;
}

// 编制方式切换时，按章节标题把已写好的正文/表格搬到新结构里，避免用户白干
function carryOver(oldDocs, newDoc) {
  const pool = [];
  Object.keys(oldDocs || {}).forEach((k) => {
    (oldDocs[k].chapters || []).forEach((c) => {
      if (!c) return;
      const hasContent = (c.body && c.body.trim()) || (c.rows && c.rows.length);
      if (hasContent) pool.push(c);
    });
  });
  if (!pool.length) return newDoc;
  newDoc.chapters.forEach((nc) => {
    if ((nc.body && nc.body.trim()) || (nc.rows && nc.rows.length)) return;
    if (nc.type === 'cover' || nc.type === 'toc') return;
    const hit2 = bestMatch(pool, nc);
    if (hit2) {
      if (nc.type === 'index' || nc.type === 'deviation' || nc.type === 'priceTable' || nc.type === 'priceTable2') {
        nc.rows = (hit2.rows || []).map((r) => ({ ...r }));
      } else {
        nc.body = hit2.body || '';
      }
      nc.source = hit2.source || 'manual';
      nc.updatedAt = hit2.updatedAt || nowIso();
    }
  });
  return newDoc;
}

const clone = (x) => JSON.parse(JSON.stringify(x));
const hasContent = (c) => !!((c.body && c.body.trim()) || (c.rows && c.rows.length));

// 合并版：优先用三份里已经生成的章节拼出来（保留 AI 起的真实章节名），没有才用默认模板
function buildMergedDoc(docs) {
  const picked = ['price', 'biz', 'qual'].map((k) => docs[k]).filter((x) => x && ((x.chapters || []).some(hasContent) || x.built));
  if (!picked.length) return makeDoc('merged');
  const pick = (key) => {
    const doc = docs[key];
    if (!doc) return [];
    return (doc.chapters || []).filter((c) => c.type !== 'cover' && c.type !== 'toc').map(clone);
  };
  const raw = [...pick('price'), ...pick('qual'), ...pick('biz')];
  // 1) 完全同名去重
  const seen = new Set();
  const uniq = [];
  raw.forEach((c) => {
    const k = c.type + '|' + normKey(c.title);
    if (seen.has(k)) return;
    seen.add(k);
    uniq.push(c);
  });
  // 2) 近似标题去重：「法定代表人身份证明」「法定代表人身份证明及授权委托书」「法定代表人授权委托书」只留最完整的那一条。
  //    必须循环到不再变化，否则后出现的长标题合不进已经排好的短标题（曾漏掉一对）。
  function dedupePass(list) {
    const out = [];
    list.forEach((c) => {
      const nt = normKey(c.title);
      if (nt.length < 5) { out.push(c); return; }
      const dup = out.find((m) => {
        if (m.type !== c.type) return false;
        const mt = normKey(m.title);
        if (mt.length < 5) return false;
        if (mt.includes(nt) || nt.includes(mt)) return true;
        // 一个标题是另一个的「子序列」时也合并（去掉「身份证明及」这类修饰后基本一致）
        const [lo, hi] = nt.length <= mt.length ? [nt, mt] : [mt, nt];
        if (lo.length >= 5 && lcsRatio(hi, lo) >= 0.85) return true;
        // 两条都还空着的，标题相近就合并；有正文的章节要更严，避免把真不同的章节吃掉
        if (!hasContent(m) && !hasContent(c)) return bgScore(mt, nt) >= 0.55;
        return bgScore(mt, nt) >= 0.82;
      });
      if (!dup) { out.push(c); return; }
      const dupN = normKey(dup.title);
      const win = nt.length > dupN.length ? c : dup;
      const lose = win === c ? dup : c;
      if (!hasContent(win) && hasContent(lose)) {
        win.body = lose.body;
        win.rows = (lose.rows || []).map((r) => ({ ...r }));
        win.source = lose.source;
        win.updatedAt = lose.updatedAt;
      }
      out[out.indexOf(dup)] = win;
    });
    return out;
  }
  let merged = uniq;
  for (let pass = 0; pass < 4; pass++) {
    const next = dedupePass(merged);
    if (next.length === merged.length) break;
    merged = next;
  }
  const shell = makeDoc('merged').chapters;
  const chapters = [shell[0], shell[1], ...merged];
  return { key: 'merged', title: DOC_META.merged.title, chapters, built: true, createdAt: nowIso(), updatedAt: nowIso() };
}

export function setMode(pid, mode) {
  const d = ensureDraft(pid);
  const oldDocs = clone(d.docs || {});
  d.mode = mode === 'merged' ? 'merged' : 'split';
  if (d.mode === 'merged') {
    d.docs.merged = carryOver(oldDocs, buildMergedDoc(oldDocs));
  } else {
    DOC_ORDER.forEach((k) => {
      const base = (d.docs[k] && (d.docs[k].chapters || []).length) ? d.docs[k] : makeDoc(k);
      if (!base.built) base.built = (oldDocs[k] && oldDocs[k].built) || false;
      d.docs[k] = carryOver(oldDocs, base);
    });
  }
  return saveDraft(pid, d);
}

// ---------- 索引表 / 偏离表 ----------
// 分析结果的 sections 是数组（每项带 key），这里统一转成 {key: section}
function secMap(analysis) {
  const s = analysis && analysis.sections;
  if (!s) return {};
  if (Array.isArray(s)) { const m = {}; s.forEach((x) => { if (x && x.key) m[x.key] = x; }); return m; }
  return s;
}

function pickSection(analysis, keys) {
  const map = secMap(analysis);
  const out = [];
  keys.forEach((k) => { const s = map[k]; if (s && Array.isArray(s.items)) out.push(...s.items.map((it) => ({ ...it, _sec: k }))); });
  return out;
}

function rowText(it) {
  if (it.cells && it.cells.length) return it.cells.filter(Boolean).join(' ｜ ');
  return it.text || '';
}

export function refreshTables(draft, analysis) {
  let changed = 0;
  Object.values(draft.docs).forEach((doc) => {
    doc.chapters.forEach((c) => {
      if (c.type !== 'index' && c.type !== 'deviation') return;
      const t = c.title;
      let keys;
      if (/资格/.test(t)) keys = ['qualify'];
      else if (/符合性/.test(t)) keys = ['conform'];
      else if (/商务/.test(t)) keys = ['business'];
      else if (/技术/.test(t)) keys = ['tech'];
      else keys = ['business', 'tech'];
      const items = pickSection(analysis, keys);
      const rows = items.map((it, i) => {
        const base = { no: String(i + 1), clause: rowText(it), page: it.page == null ? '' : String(it.page) };
        if (c.type === 'deviation') return { ...base, response: '完全响应', dev: '无偏离', note: '' };
        return { ...base, where: '' };
      });
      if (rows.length || !c.rows) {
        c.rows = rows;
        c.updatedAt = nowIso();
        changed++;
      }
    });
  });
  return changed;
}

// ---------- 框架生成（AI） ----------
const SYSTEM_OUTLINE = [
  '你是中国招投标标书编写专家。请根据招标文件的要求，为其中一份投标文件设计章节框架。',
  '要求：',
  '1. 必须以「封面」「目录」开头。',
  '2. 章节顺序要符合招标文件给定的投标文件格式要求；招标文件没写死时，按行业通行的合理顺序。',
  '3. 每个章节给出 title（章节标题，不带序号）、type、hint（这一章要写什么，40 字以内，要指出对应招标文件的哪些要求）、words（建议字数，技术方案类 1200-2000，普通章节 400-800，表格类 0）。',
  '4. type 只能取：cover（封面）、toc（目录）、index（评审索引表）、deviation（条款偏离表）、priceTable（开标一览表）、priceTable2（价格构成表）、normal（普通正文）。',
  '5. 章节数量控制在 8-18 个之间，不要过细。',
  '6. 只输出 JSON：{"chapters":[{"title":"","type":"normal","hint":"","words":500}]}'
].join('\n');

function analysisBrief(analysis) {
  const s = secMap(analysis);
  if (!Object.keys(s).length) return '（尚未做招标文件分析）';
  const L = [];
  const get = (k, n) => (s[k] && s[k].items ? s[k].items.slice(0, n) : []);
  const rows = (arr) => arr.map((it) => '- ' + rowText(it).slice(0, 160)).join('\n');
  if (get('format', 8).length) L.push('【版面格式要求】\n' + rows(get('format', 8)));
  if (get('deliver', 10).length) L.push('【交付内容/成果】\n' + rows(get('deliver', 10)));
  if (get('score', 14).length) L.push('【综合评分表】\n' + rows(get('score', 14)));
  if (get('qualify', 20).length) L.push('【资格性审查表】\n' + rows(get('qualify', 20)));
  if (get('conform', 20).length) L.push('【符合性审查表】\n' + rows(get('conform', 20)));
  if (get('business', 15).length) L.push('【商务要求】\n' + rows(get('business', 15)));
  if (get('tech', 15).length) L.push('【技术要求】\n' + rows(get('tech', 15)));
  if (get('fatal', 10).length) L.push('【废标项】\n' + rows(get('fatal', 10)));
  return L.join('\n\n') || '（未提取到有效内容）';
}

const VALID_TYPES = ['cover', 'toc', 'index', 'deviation', 'priceTable', 'priceTable2', 'normal'];

// 每份文件「必须有 / 不许有」的表格类章节，避免 AI 把别的文件里的表塞进来
const TABLE_RULES = {
  price: { forbid: ['index', 'deviation'], must: [['开标一览表', 'priceTable'], ['价格构成表', 'priceTable2']] },
  biz: { forbid: ['priceTable', 'priceTable2'], must: [['商务评审索引表', 'index'], ['技术评审索引表', 'index'], ['商务条款响应及偏离表', 'deviation'], ['技术条款响应及偏离表', 'deviation']] },
  qual: { forbid: ['priceTable', 'priceTable2', 'deviation'], must: [['资格证明文件索引表', 'index']] },
  merged: { forbid: [], must: [['资格证明文件索引表', 'index'], ['商务评审索引表', 'index'], ['技术评审索引表', 'index'], ['商务条款响应及偏离表', 'deviation'], ['技术条款响应及偏离表', 'deviation'], ['开标一览表', 'priceTable'], ['价格构成表', 'priceTable2']] },
};

const IDX_TITLE = { qual: '资格证明文件索引表', biz: '商务评审索引表', tech: '技术评审索引表' };
function idxKind(title) {
  const t = String(title || '');
  if (/资格/.test(t)) return 'qual';
  if (/技术/.test(t)) return 'tech';
  return 'biz';
}

function normTables(docKey, chapters) {
  const rule = TABLE_RULES[docKey] || TABLE_RULES.biz;
  // 1) 去掉不属于这份文件的表格章节
  let list = chapters.filter((c) => !rule.forbid.includes(c.type));
  // 2) 索引表、偏离表按「资格/商务/技术」区分去重；其它表格类按 type 去重；正文类全留
  const seen = new Set();
  list = list.filter((c) => {
    if (c.type === 'normal') return true;
    const k = (c.type === 'index' || c.type === 'deviation') ? c.type + ':' + idxKind(c.title) : c.type;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  // 3) 封面必须第一、目录第二
  const cover = list.find((c) => c.type === 'cover') || ch('封面', 'cover');
  const toc = list.find((c) => c.type === 'toc') || ch('目录', 'toc');
  let rest = list.filter((c) => c.type !== 'cover' && c.type !== 'toc');
  // 4) 补齐必须有的表格（索引表、偏离表按种类判断，其它按 type 判断）
  rule.must.forEach(([title, type]) => {
    if (type === 'index' || type === 'deviation') {
      if (!rest.some((c) => c.type === type && idxKind(c.title) === idxKind(title))) rest.push(ch(title, type, '', 0));
    } else if (!rest.some((c) => c.type === type)) {
      rest.push(ch(title, type, '', 0));
    }
  });
  // 5) 统一索引表标题（偏离表保持原样）
  rest.forEach((c) => { if (c.type === 'index') c.title = IDX_TITLE[idxKind(c.title)]; });
  // 6) 索引表、偏离表、价格表排前（按 must 顺序），正文保持 AI 给的顺序
  const head = [];
  rule.must.forEach(([title, type]) => {
    const c = (type === 'index' || type === 'deviation')
      ? rest.find((x) => x.type === type && idxKind(x.title) === idxKind(title))
      : rest.find((x) => x.type === type);
    if (c && !head.includes(c)) head.push(c);
  });
  const tail = rest.filter((c) => !head.includes(c));
  return [cover, toc, ...head, ...tail];
}

export async function buildOutlineAI(project, draft, docKey, analysis) {
  const doc = draft.docs[docKey];
  const sys = SYSTEM_OUTLINE;
  const user = [
    '项目名称：' + (project.name || '—'),
    '招标编号：' + (project.code || '—'),
    '采购方式：' + (project.purchaseMethod || '—'),
    '',
    '【这份文件的名称】' + doc.title,
    '',
    '【招标文件要点】',
    analysisBrief(analysis),
    '',
    '请为「' + doc.title + '」设计章节框架。'
  ].join('\n');
  const res = await callJson(sys, user, { maxTokens: 4000, timeoutMs: 180000, reasoningEffort: 'none' });
  const arr = (res && res.chapters) || [];
  const chapters = [];
  arr.forEach((c) => {
    if (!c || !c.title) return;
    const type = VALID_TYPES.includes(c.type) ? c.type : 'normal';
    chapters.push(ch((String(c.title)).replace(/^[\d一二三四五六七八九十]+[、.．]\s*/, '').trim(), type, c.hint || '', Number(c.words) || (type === 'normal' ? 500 : 0)));
  });
  if (chapters.length < 4) throw new Error('AI 返回的框架章节太少，请重试');
  const fixTables = normTables(docKey, chapters);
  doc.chapters = fixTables;
  doc.built = true;
  doc.outlineAt = nowIso();
  doc.updatedAt = nowIso();
  return doc;
}

// ---------- 章节正文生成 ----------
const STOP = /^(本文件|未提及|以上|以下|见第|详见)/;

function clausePool(analysis, docKey) {
  const keys = docKey === 'qual' ? ['qualify', 'conform'] : docKey === 'price' ? ['frontTable'] : ['business', 'tech', 'deliver', 'score', 'conform'];
  return pickSection(analysis, keys).map((it) => ({ text: rowText(it), page: it.page, star: it.isStar })).filter((x) => x.text && x.text.length > 8);
}

function bigrams(s) {
  const t = String(s || '').replace(/[\s\p{P}]/gu, '');
  const g = new Set();
  for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2));
  return g;
}

function relevance(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  A.forEach((x) => { if (B.has(x)) n++; });
  return n / Math.min(A.size, B.size);
}

// 章节标题 → 该章必须逐条响应的板块（技术类章节强制对齐技术条款）
function clauseKeysFor(docKey, title) {
  const t = String(title || '');
  const isTech = /技术|方案|实施|工艺|方法|设备|系统|流程|质量|进度|安全|应急|服务内容|服务方案|运维|检测|采集/.test(t);
  const isBiz = /商务|资格|资质|业绩|财务|人员|团队|售后|承诺|保密|知识产权|廉洁|信用/.test(t);
  if (docKey === 'qual') return ['qualify', 'conform'];
  if (docKey === 'price') return ['frontTable', 'business'];
  if (isTech && !isBiz) return ['tech', 'deliver', 'business'];
  if (isBiz) return ['business', 'qualify', 'conform', 'score'];
  return ['business', 'tech', 'deliver', 'conform', 'score'];
}

// 单章注入的条款总字数上限（deepseek-flash 上下文足够大，这里只是防止极端情况）
const MAX_CLAUSE_CHARS = 24000;

export async function generateChapter(project, draft, docKey, chapterId, analysis, mode) {
  const doc = draft.docs[docKey];
  const c = (doc.chapters || []).find((x) => x.id === chapterId);
  if (!c) throw new Error('章节不存在');
  if (!['normal'].includes(c.type)) throw new Error('这一章是表格类，不需要 AI 写正文');
  const keys = clauseKeysFor(docKey, c.title + ' ' + c.hint);
  const pool = pickSection(analysis, keys)
    .map((it) => ({ text: rowText(it), page: it.page, star: !!it.isStar }))
    .filter((x) => x.text && x.text.length > 8);
  // ★ 不再按相似度砍成 top14：整板块全部注入，按「星号优先、与本章相关优先」排序后总字数封顶
  const kw = c.title + ' ' + c.hint;
  const ranked = pool
    .map((x) => ({ ...x, sc: relevance(kw, x.text) + (x.star ? 0.35 : 0), i: pool.indexOf(x) }))
    .sort((a, b) => b.sc - a.sc);
  const picked = [];
  let used = 0;
  for (const x of ranked) {
    if (used + x.text.length > MAX_CLAUSE_CHARS) continue;
    picked.push(x);
    used += x.text.length;
  }
  picked.sort((a, b) => a.i - b.i); // 恢复招标文件原有顺序，便于逐条对应
  const allClauses = pool.map((x, i) => ({ ...x, i }));
  const clauses = picked.map((x) => ({ text: x.text, page: x.page, star: x.star }));
  let scoreStandard = '';
  const scores = pickSection(analysis, ['score']);
  if (scores.length) {
    scoreStandard = scores.map((it) => rowText(it)).filter((t) => relevance(kw, t) > 0.05).slice(0, 8).join('\n');
  }
  const ctx = {
    projectName: project.name, projectCode: project.code, owner: project.owner, method: project.purchaseMethod,
    budget: project.budget, deadline: project.bidDeadline, docName: doc.title, chapterTitle: c.title, hint: c.hint,
    scoreStandard, clauses, outline: (doc.chapters || []).map((x) => x.title),
    words: c.words || 500, mode: mode === 'expand' ? 'expand' : 'first', current: mode === 'expand' ? c.body : ''
  };
  const text = await callText(SYSTEM_DRAFT, draftUserPrompt(ctx), { maxTokens: Math.min(4000 + (c.words || 500) * 4, 20000), timeoutMs: 300000, temperature: 0.5, reasoningEffort: 'none' });
  const body = String(text || '').trim();
  if (!body || body.length < 40) throw new Error('AI 没有返回有效正文');
  c.body = body;
  c.source = 'ai';
  c.updatedAt = nowIso();
  c.coverage = checkCoverage(body, clauses);
  return c;
}

// 生成后自检：注入的条款里，哪些在正文中完全没有出现（用关键 bigram 命中判断）
export function checkCoverage(body, clauses) {
  const B = bigrams(body);
  const missing = [];
  for (const cl of clauses || []) {
    const key = String(cl.text || '').replace(/[\s\p{P}]/gu, '').slice(0, 60);
    if (key.length < 8) continue;
    const G = bigrams(key);
    let hit = 0;
    G.forEach((g) => { if (B.has(g)) hit++; });
    const ratio = G.size ? hit / G.size : 1;
    if (ratio < 0.35) missing.push({ text: String(cl.text).slice(0, 80), page: cl.page || null });
  }
  return { total: (clauses || []).length, missing: missing.slice(0, 30), missingCount: missing.length };
}

// ---------- 任务（异步生成） ----------
const tasks = new Map();
const taskFile = (id) => path.join(TASKS_DIR, id + '.json');
function persist(t) { try { fs.writeFileSync(taskFile(t.id), JSON.stringify(t, null, 1), 'utf8'); } catch {} }
export function getDraftTask(id) {
  if (tasks.has(id)) return tasks.get(id);
  try { return JSON.parse(fs.readFileSync(taskFile(id), 'utf8')); } catch { return null; }
}
const runKey = (pid, docKey, chapterId) => pid + '|' + (chapterId || '');

export function startChapterTask(project, draft, docKey, chapterId, analysis, mode) {
  const k = runKey(project.id, docKey, chapterId);
  for (const t of tasks.values()) if (t.key === k && t.state === 'running') return t;
  const t = { id: uid('t_'), key: k, projectId: project.id, docKey, chapterId, mode: mode || 'first', state: 'running', message: '正在写正文…', startedAt: nowIso() };
  tasks.set(t.id, t);
  persist(t);
  (async () => {
    try {
      const c = await generateChapter(project, draft, docKey, chapterId, analysis, t.mode);
      const fresh = loadDraft(project.id) || draft;
      const fd = fresh.docs[docKey];
      if (fd) {
        const i = (fd.chapters || []).findIndex((x) => x.id === chapterId);
        if (i >= 0) { fd.chapters[i] = { ...fd.chapters[i], body: c.body, source: 'ai', updatedAt: c.updatedAt, coverage: c.coverage }; fd.updatedAt = nowIso(); }
        saveDraft(project.id, fresh);
      }
      t.state = 'done'; t.message = '已生成'; t.finishedAt = nowIso();
      t.chars = c.body.length;
    } catch (e) {
      t.state = 'error'; t.message = e.message || String(e); t.finishedAt = nowIso();
    }
    persist(t);
  })();
  return t;
}

export function startOutlineTask(project, draft, docKey, analysis) {
  const k = runKey(project.id, docKey, 'outline');
  for (const t of tasks.values()) if (t.key === k && t.state === 'running') return t;
  const t = { id: uid('t_'), key: k, projectId: project.id, docKey, chapterId: 'outline', state: 'running', message: '正在设计框架…', startedAt: nowIso() };
  tasks.set(t.id, t);
  persist(t);
  (async () => {
    try {
      const fresh = loadDraft(project.id) || draft;
      const doc = await buildOutlineAI(project, fresh, docKey, analysis);
      fresh.docs[docKey] = doc;
      saveDraft(project.id, fresh);
      t.state = 'done'; t.message = '框架已生成';
      t.finishedAt = nowIso();
    } catch (e) {
      t.state = 'error'; t.message = e.message || String(e); t.finishedAt = nowIso();
    }
    persist(t);
  })();
  return t;
}
