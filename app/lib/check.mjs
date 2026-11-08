// 模块4：投标文件核查
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, PROJECT_DIR } from './config.mjs';
import { uid, nowIso } from './util.mjs';
import { docxToPdf, docToDocx, extractPdfText, extractDocxText, getPageInfo } from './extract.mjs';
import { apiReady } from './ai.mjs';
import { aiRequirementCheck, aiDeepScore, guessKind, reqSectionsFor, flattenRequirements } from './checkAI.mjs';
import { loadDraft } from './draft.mjs';

export const CHECK_DIR = path.join(DATA_DIR, '核查');
const TASKS_DIR = path.join(CHECK_DIR, '.tasks');

export function ensureCheckDirs() {
  for (const d of [CHECK_DIR, TASKS_DIR]) fs.mkdirSync(d, { recursive: true });
}

export function loadCheck(pid) {
  const f = path.join(CHECK_DIR, pid + '.json');
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

export function saveCheck(pid, c) {
  ensureCheckDirs();
  fs.writeFileSync(path.join(CHECK_DIR, pid + '.json'), JSON.stringify(c, null, 2), 'utf8');
  return c;
}

// ---------- 待核查文件 ----------
// 「导入_xxx_时间戳_原名.docx」= 你上传的原件；「价格文件_日期.docx」= 工作台导出的版本
const DOC_KEY_RULES = [
  [/^投标文件（合并版）_|^投标文件\(合并版\)_/, 'merged'],
  [/^商务技术文件_/, 'biz'],
  [/^资格证明文件_/, 'qual'],
  [/^价格文件_/, 'price']
];

export function parseDocName(name) {
  const m = String(name).match(/^导入_(price|biz|qual|merged)_\d+_(.+)$/);
  if (m) return { docKey: m[1], origin: 'upload', baseName: m[2] };
  for (const [re, key] of DOC_KEY_RULES) {
    if (re.test(name)) return { docKey: key, origin: 'export', baseName: name };
  }
  return { docKey: null, origin: 'other', baseName: name };
}

export function listSources(project) {
  const dir = path.join(PROJECT_DIR, project.dir || '');
  const out = [];
  const seen = new Map();
  const scan = (sub, stage) => {
    const d = path.join(dir, sub);
    if (!fs.existsSync(d)) return;
    for (const name of fs.readdirSync(d)) {
      const fp = path.join(d, name);
      let st;
      try { st = fs.statSync(fp); } catch { continue; }
      if (!st.isFile()) continue;
      const ext = path.extname(name).toLowerCase();
      if (!['.docx', '.doc', '.pdf'].includes(ext)) continue;
      if (name.startsWith('~$')) continue;
      // 工作台自己生成的报告不算待核查的投标文件
      if (/^(核查报告|递交行动清单|关键信息清单)_/.test(name)) continue;
      const meta = parseDocName(name);
      // 去重键要带 docKey：同一份原始标书可能以「导入_price_…」「导入_merged_…」两个身份导入过
      const key = (meta.docKey || '') + '|' + meta.baseName.replace(/\.[^.]+$/, '') + '|' + st.size;
      const prev = seen.get(key);
      if (prev && prev.mtime > st.mtime.getTime()) continue;
      const row = {
        id: stage + ':' + name,
        stage,
        name,
        baseName: meta.baseName,
        docKey: meta.docKey,
        origin: meta.origin,
        path: fp,
        relPath: sub + '/' + name,
        size: st.size,
        mtime: st.mtime.toISOString(),
        ext
      };
      if (prev) {
        const at = out.indexOf(prev);
        if (at >= 0) out.splice(at, 1);
      }
      seen.set(key, row);
      out.push(row);
    }
  };
  scan('03制作', 'draft');
  scan('04核查', 'check');

  // 判断哪一份才是「最终要投的那份」：
  // 你上传过 Word 的那份，就以你上传的原件为准，工作台自动生成的同名文件不再默认核查；
  // 没上传过的，才默认核查工作台导出的版本。
  const d = loadDraft(project.id);
  const mode = d && d.mode ? d.mode : null;
  const activeKeys = mode === 'merged' ? ['merged'] : mode === 'split' ? ['price', 'biz', 'qual'] : null;
  const docs = (d && d.docs) || {};
  for (const row of out) {
    const doc = row.docKey ? docs[row.docKey] : null;
    const uploaded = !!(doc && doc.source === 'upload');
    const inMode = !activeKeys || !row.docKey || activeKeys.includes(row.docKey);
    if (row.origin === 'upload') {
      row.final = inMode && (!doc || uploaded);
      row.label = row.final ? '你上传的最终版' : '你上传的版本（当前不用它投）';
    } else if (row.origin === 'export') {
      row.final = inMode && !uploaded;
      row.label = uploaded ? '工作台生成的草稿（不核查）' : '工作台生成';
    } else {
      row.final = true;
      row.label = '其他文件';
    }
  }
  if (!out.some((x) => x.final)) out.forEach((x) => { x.final = true; });

  out.sort((a, b) => (b.final ? 1 : 0) - (a.final ? 1 : 0) || String(b.mtime).localeCompare(String(a.mtime)));
  return out;
}

// ---------- 文本工具 ----------
function norm(s) {
  return String(s || '').replace(/[\s\u3000]+/g, '').replace(/[，。、；：""''（）()《》【】\[\]·—\-_.]/g, '').toLowerCase();
}

function bigrams(s) {
  const t = norm(s);
  const set = new Set();
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}

function hitRate(bodySet, clause) {
  const cb = bigrams(clause);
  if (!cb.size) return 1;
  let hit = 0;
  for (const g of cb) if (bodySet.has(g)) hit++;
  return hit / cb.size;
}

function secItems(analysis, key) {
  if (!analysis || !Array.isArray(analysis.sections)) return [];
  const s = analysis.sections.find((x) => x.key === key);
  if (!s) return [];
  return (s.items || []).map((it) => ({
    text: it.text || (it.cells || []).filter(Boolean).join(' '),
    page: it.page,
    isStar: !!it.isStar,
    isFatal: !!it.isFatal
  })).filter((x) => x.text);
}

// ---------- 日期 ----------
function parseCnDate(s) {
  const m = String(s).match(/(20\d{2})\s*[年\-\/\.]\s*(\d{1,2})\s*[月\-\/\.]\s*(\d{1,2})/);
  if (!m) return null;
  return m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0');
}

function datesIn(text) {
  const out = [];
  const re = /(20\d{2})\s*[年\-\/\.]\s*(\d{1,2})\s*[月\-\/\.]\s*(\d{1,2})\s*日?/g;
  let m;
  while ((m = re.exec(text))) {
    const d = m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0');
    out.push(d);
  }
  return out;
}

// ---------- 单份文档的规则检查 ----------
function ruleCheck(pages, project, doc, pageInfo) {
  const items = [];
  const add = (o) => items.push({ id: uid('k_'), ...o });
  const pageTexts = pages.map((p) => String(p.text || '').trim());
  const fullText = pageTexts.join('\n');
  const fullSet = bigrams(fullText);
  const imgOf = (i) => {
    const r = (pageInfo || []).find((x) => x.page === i + 1);
    return r ? r.images : 0;
  };

  // 1 空白页（有图的是扫描页，不算空白）
  const blanks = [];
  const scans = [];
  pageTexts.forEach((t, i) => {
    const len = t.replace(/第\s*\d+\s*页/g, '').replace(/[\s\u3000]/g, '').length;
    if (len >= 6) return;
    if (imgOf(i) > 0) scans.push(i + 1);
    else if (i > 0) blanks.push(i + 1);
  });
  add({
    group: 'format',
    key: 'blank',
    level: blanks.length ? 'fatal' : 'ok',
    title: blanks.length ? `有 ${blanks.length} 页是空白页` : '没有空白页',
    detail: [
      blanks.length ? '第 ' + blanks.join('、') + ' 页既没有文字也没有图片，印刷后就是白纸。' : '逐页检查通过，没有发现白页。',
      scans.length ? `另有 ${scans.length} 页是整页扫描图（第 ${scans.slice(0, 12).join('、')} 页${scans.length > 12 ? ' 等' : ''}），文字核对不到，请人工翻一遍。` : ''
    ].filter(Boolean).join(' '),
    pages: blanks,
    suggest: blanks.length ? '回到 Word 把这几页的内容补齐，或删掉多余的分页符。' : ''
  });

  // 2 页码：页脚可能在抽出来的文本的开头也可能在结尾，只看首尾各 3 行
  const nums = [];
  pageTexts.forEach((t, i) => {
    const lines = t.split('\n').map((x) => x.trim()).filter(Boolean);
    const edge = [...lines.slice(0, 3), ...lines.slice(-3)];
    const cands = [];
    for (const line of edge) {
      for (const m of line.matchAll(/第\s*(\d{1,4})\s*页/g)) cands.push(Number(m[1]));
      if (/^[-－—\s]*\d{1,4}[-－—\s]*$/.test(line)) cands.push(Number(line.replace(/\D/g, '')));
      const m2 = line.match(/^[－—\-]\s*(\d{1,4})\s*[－—\-]$/);
      if (m2) cands.push(Number(m2[1]));
    }
    let no = null;
    const expect = i + 1;
    let best = Infinity;
    for (const n of cands) {
      const d = Math.abs(n - expect);
      if (d <= 3 && d < best) { best = d; no = n; }
    }
    nums.push({ page: i + 1, no });
  });
  const withNo = nums.filter((x) => x.no != null);
  let pageMsg = '全文没有找到页码。';
  let pageLevel = 'fatal';
  let pageDetail = '需求要求每份文件都要有页码。';
  if (withNo.length) {
    const gaps = [];
    for (let i = 1; i < withNo.length; i++) {
      // 允许「这张纸本身是第几页」与「页脚写的号」之间有固定偏移（封面不编页码）
      const offPrev = withNo[i - 1].page - withNo[i - 1].no;
      const offCur = withNo[i].page - withNo[i].no;
      if (withNo[i].no !== withNo[i - 1].no + 1 && offCur !== offPrev) {
        gaps.push(`第 ${withNo[i].page} 张纸页脚写的是「第 ${withNo[i].no} 页」，上一张是「第 ${withNo[i - 1].no} 页」`);
      }
    }
    const startNo = withNo[0].no;
    const startPage = withNo[0].page;
    if (gaps.length) {
      pageLevel = 'fatal';
      pageMsg = `页码不连续（${gaps.length} 处断开）`;
      pageDetail = gaps.slice(0, 8).join('；') + (gaps.length > 8 ? ' 等' : '');
    } else if (startNo !== 1 && startPage <= 2) {
      pageLevel = 'ok';
      pageMsg = '页码连续';
      pageDetail = `封面从「第 ${startNo} 页」开始编号，全篇连续。`;
    } else {
      pageLevel = 'ok';
      pageMsg = '页码连续';
      pageDetail = `共 ${withNo.length} 页带页码，从「第 ${startNo} 页」到「第 ${withNo[withNo.length - 1].no} 页」连续。`;
    }
  }
  add({ group: 'format', key: 'pageno', level: pageLevel, title: pageMsg, detail: pageDetail, pages: [], suggest: pageLevel === 'ok' ? '' : '在 Word 里插入「页码」，并从正文第一页起重新编号。' });

  // 3 封面要素
  const cover = pageTexts.slice(0, 2).join('\n');
  const need = [
    ['项目名称', /项目名称|采购项目/],
    ['招标编号', /招标编号|采购编号|项目编号|采购项目编号/],
    ['投标人名称', /投标人|供应商|响应人|响应单位|报价人|报价单位/]
  ];
  const missCover = need.filter(([n, re]) => !re.test(cover)).map(([n]) => n);
  const hasCopy = /正本|副本/.test(cover);
  add({
    group: 'format',
    key: 'cover',
    level: missCover.length || !hasCopy ? 'warn' : 'ok',
    title: missCover.length || !hasCopy ? '封面上有要素缺失' : '封面要素齐全',
    detail: [
      missCover.length ? '缺少：' + missCover.join('、') : '',
      hasCopy ? '' : '没有看到「正本 / 副本」标注'
    ].filter(Boolean).join('；') || '项目名称、招标编号、投标人、正副本标注都在。',
    pages: [1],
    suggest: missCover.length || !hasCopy ? '在封面补齐这些文字，正本、副本要各印一份并分别标注。' : ''
  });

  // 4 占位符残留
  const ph = [];
  pageTexts.forEach((t, i) => {
    const m = t.match(/【请填写[^】]*】/g);
    if (m) ph.push({ page: i + 1, texts: [...new Set(m)] });
  });
  const phCount = ph.reduce((a, b) => a + b.texts.length, 0);
  add({
    group: 'content',
    key: 'placeholder',
    level: phCount ? 'fatal' : 'ok',
    title: phCount ? `还有 ${phCount} 处「【请填写】」没填` : '没有未填的占位内容',
    detail: phCount ? ph.slice(0, 10).map((x) => `第 ${x.page} 页：` + x.texts.slice(0, 3).join('、')).join('；') : 'AI 生成时留下的空白占位已全部填好。',
    pages: ph.map((x) => x.page),
    suggest: phCount ? '这些地方必须由你亲手填真实信息（公司名、业绩、金额、人名），不能留空。' : ''
  });

  // 5 投标时间一致性
  if (project.bidDeadline) {
    const want = String(project.bidDeadline).slice(0, 10);
    const all = datesIn(fullText);
    const uniq = [...new Set(all)];
    const near = uniq.filter((d) => {
      const t1 = Date.parse(d), t2 = Date.parse(want);
      if (isNaN(t1) || isNaN(t2)) return false;
      return Math.abs(t1 - t2) / 86400000 <= 30 && d !== want;
    });
    add({
      group: 'content',
      key: 'date',
      level: near.length ? 'warn' : 'ok',
      title: near.length ? `文中出现 ${near.length} 个与投标截止日接近但不一致的日期` : '投标时间一致',
      detail: near.length
        ? `招标要求的投标截止时间是 ${want}；文中还出现 ${near.join('、')}，请确认是不是写错了日期。`
        : `文中出现的日期与投标截止时间 ${want} 不冲突。`,
      pages: [],
      suggest: near.length ? '逐处核对：投标函、开标一览表、授权委托书里的日期必须与招标文件一致。' : ''
    });
  }

  // 6 项目名称 / 编号 是否出现
  const nameOk = project.name && hitRate(fullSet, project.name) >= 0.6;
  const codeOk = !project.code || hitRate(fullSet, project.code) >= 0.5;
  add({
    group: 'content',
    key: 'idfill',
    level: !nameOk || !codeOk ? 'warn' : 'ok',
    title: !nameOk || !codeOk ? '项目名称或编号可能漏填' : '项目名称与编号都写了',
    detail: [!nameOk ? `整份文件里没有找到项目名称「${project.name}」` : '', !codeOk ? `没有找到招标编号「${project.code}」` : ''].filter(Boolean).join('；') || '招标文件要求的项目名称、编号都能在正文中找到。',
    pages: [],
    suggest: !nameOk || !codeOk ? '封面、投标函、开标一览表、偏离表抬头都要写全项目名称和编号。' : ''
  });

  return items;
}

// 判断这份标书是价格 / 商务技术 / 资格证明 / 合并版
const docKindOf = (name) => guessKind(name);

// ---------- 读取一份待核查文件（统一转成 PDF 再按页抽出文字 + 图片数） ----------
const CONV_DIR = path.join(CHECK_DIR, '.conv');

function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
}

function pruneConv() {
  try {
    const files = fs.readdirSync(CONV_DIR).map((n) => {
      const fp = path.join(CONV_DIR, n);
      let st;
      try { st = fs.statSync(fp); } catch { return null; }
      return { fp, t: st.mtimeMs };
    }).filter(Boolean).sort((a, b) => a.t - b.t);
    const keep = 12;
    while (files.length > keep) {
      const f = files.shift();
      try { fs.unlinkSync(f.fp); } catch {}
    }
  } catch {}
}

async function checkOneDoc(project, src, analysis) {
  fs.mkdirSync(CONV_DIR, { recursive: true });
  pruneConv();

  const stamp = safeName(src.baseName || src.name).replace(/\.[^.]+$/, '') + '_' + src.size;
  const pdfPath = path.join(CONV_DIR, stamp + '.pdf');
  let sourceForPdf = src.path;

  // .doc → 先另存为 .docx
  if (src.ext === '.doc') {
    const docxPath = path.join(CONV_DIR, stamp + '.docx');
    if (!fs.existsSync(docxPath)) {
      try {
        fs.writeFileSync(docxPath, docToDocx(src.path, docxPath));
      } catch (e) {
        throw new Error('这份老版 Word（.doc）打不开：' + (e && e.message ? e.message : e) + '。请在 Word 里另存为 .docx 再上传。');
      }
    }
    sourceForPdf = docxPath;
  }

  // .docx → Word 另存 PDF（页码、空白页、正副本标注都要看真实排版）
  if (sourceForPdf !== src.path || src.ext === '.docx') {
    if (!fs.existsSync(pdfPath)) {
      let lastErr = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          docxToPdf(sourceForPdf, pdfPath);
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          await new Promise((r) => setTimeout(r, 2000));
          try { if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath); } catch {}
        }
      }
      if (lastErr) {
        throw new Error('这份 Word 转成 PDF 失败（' + (lastErr.message || lastErr) + '）。常见原因：Word 窗口卡住没关。请在任务管理器里结束 WINWORD 后重试。');
      }
    }
    sourceForPdf = pdfPath;
  }

  const buf = fs.readFileSync(sourceForPdf);
  const pages = await extractPdfText(buf);
  let pageInfo = [];
  try {
    pageInfo = await getPageInfo(buf);
  } catch {
    pageInfo = [];
  }
  const text = pages.map((p) => p.text || '').join('\n');
  return { pages, pageInfo, text };
}

// ---------- 逐条核查 / 评标 由 checkAI.mjs 负责 ----------

export function requirementSummary(doc) {
  const r = doc && doc.req;
  if (!r || !r.stat) return null;
  return r;
}

// ---------- 任务 ----------
const tasks = new Map();

function taskFile(id) { return path.join(TASKS_DIR, id + '.json'); }
function persist(t) { try { fs.writeFileSync(taskFile(t.id), JSON.stringify(t, null, 2), 'utf8'); } catch {} }

export function getCheckTask(id) {
  if (tasks.has(id)) return tasks.get(id);
  const f = taskFile(id);
  if (fs.existsSync(f)) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch {} }
  return null;
}

function pickScoreDoc(results) {
  return results.find((d) => !d.error && d.kind === 'merged' && d._pages)
    || results.find((d) => !d.error && d.kind === 'biz' && d._pages)
    || results.find((d) => !d.error && d.kind === 'qual' && d._pages)
    || results.find((d) => !d.error && d.kind === 'price' && d._pages)
    || null;
}

export function startCheckTask(project, sources, analysis) {
  ensureCheckDirs();
  for (const t of tasks.values()) {
    if (t.projectId === project.id && t.state === 'running') return t;
  }
  const aiOn = apiReady();
  const t = {
    id: uid('t_'),
    projectId: project.id,
    state: 'running',
    message: '准备开始核查…',
    progress: 0,
    total: sources.length,
    ai: aiOn && !!analysis,
    startedAt: nowIso()
  };
  tasks.set(t.id, t);
  persist(t);

  const step = (msg) => { t.message = msg; persist(t); };

  (async () => {
    const results = [];
    try {
      for (let i = 0; i < sources.length; i++) {
        const src = sources[i];
        step(`正在读取文件：${src.name}（${i + 1}/${sources.length}）`);
        t.progress = i;
        const one = { id: src.id, name: src.name, stage: src.stage, relPath: src.relPath, size: src.size };
        try {
          const { pages, pageInfo, text } = await checkOneDoc(project, src, analysis);
          one.pages = pages.length;
          one.checks = ruleCheck(pages, project, src, pageInfo);
          one.kind = docKindOf(src.name);
          one.textChars = text.length;
          one._pages = pages;

          // ① 逐条对照招标文件要求核查
          if (aiOn && analysis && one.kind !== 'price') {
            try {
              one.req = await aiRequirementCheck(project, analysis, pages, src.name, (m) => step(src.name + ' · ' + m));
            } catch (e) {
              one.reqError = '逐条核查没跑成功：' + (e && e.message ? e.message : e);
            }
          }

          const reqStat = one.req && one.req.stat;
          one.fatal = one.checks.filter((c) => c.level === 'fatal').length + (reqStat ? reqStat.missFatal : 0);
          one.warn = one.checks.filter((c) => c.level === 'warn').length
            + (reqStat ? ((reqStat.missing - reqStat.missFatal) > 0 ? 1 : 0) + (reqStat.partial > 0 ? 1 : 0) : 0);
        } catch (e) {
          one.error = e.message;
        }
        results.push(one);
      }

      // ② 深度模拟评标（只对一份主要是投标文件的那份做）
      if (aiOn && analysis) {
        const pick = pickScoreDoc(results);
        if (pick && pick._pages) {
          try {
            pick.score = await aiDeepScore(project, analysis, pick._pages, pick.name, (m) => step(m));
          } catch (e) {
            pick.score = { error: '模拟评标没跑成功：' + (e && e.message ? e.message : e) };
          }
        }
      }

      for (const d of results) { delete d._pages; delete d._text; }

      const fatal = results.reduce((a, b) => a + (b.fatal || 0), 0);
      const warn = results.reduce((a, b) => a + (b.warn || 0), 0);
      const check = {
        projectId: project.id,
        docs: results,
        fatal,
        warn,
        aiUsed: aiOn && !!analysis,
        reqTotal: results.reduce((a, b) => a + (b.req && b.req.stat ? b.req.stat.total : 0), 0),
        verdict: fatal ? 'red' : warn ? 'amber' : 'green',
        checkAt: nowIso()
      };
      saveCheck(project.id, check);

      t.state = 'done';
      t.progress = sources.length;
      t.total = sources.length;
      t.message = fatal ? `核查完成：${fatal} 个必须改的问题` : warn ? `核查完成：${warn} 处建议核对` : '核查完成：全部通过';
      t.finishedAt = nowIso();
      persist(t);
    } catch (e) {
      t.state = 'error';
      t.message = e.message || '核查失败';
      t.finishedAt = nowIso();
      persist(t);
    }
  })();

  return t;
}
