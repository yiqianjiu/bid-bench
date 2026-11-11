// 模块4：投标文件核查
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, PROJECT_DIR } from './config.mjs';
import { uid, nowIso, sha256 } from './util.mjs';
import { docxToPdf, docToDocx, extractPdfText, extractDocxText, getPageInfo } from './extract.mjs';
import { apiReady } from './ai.mjs';
import { aiRequirementCheck, aiDeepScore, guessKind, reqSectionsFor, flattenRequirements } from './checkAI.mjs';
import { loadDraft } from './draft.mjs';
import { renderPdfPages } from './extract.mjs';
import { ocrImageFile, detectOcr } from './ocr.mjs';
import { sleep } from './convert.mjs';

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

// v1.2.1：招标类文件的特征（这类文件永远不是「投标文件」，绝不能进核查候选）
const TENDER_NAME_RE = /招标文件|招标公告|投标邀请|采购文件|磋商文件|询比文件|谈判文件|竞价文件|资格预审文件|澄清|答疑|更正公告|中标公告|中标结果/;

// 把「01招标文件」里所有文件的指纹（SHA-256）算出来：和它内容完全一样的，一定是招标文件
function tenderFingerprints(dir) {
  const map = new Map();
  const d = path.join(dir, '01招标文件');
  if (!fs.existsSync(d)) return map;
  const walk = (dd) => {
    let names = [];
    try { names = fs.readdirSync(dd); } catch { return; }
    for (const name of names) {
      const fp = path.join(dd, name);
      let st;
      try { st = fs.statSync(fp); } catch { continue; }
      if (st.isDirectory()) { walk(fp); continue; }
      if (!st.isFile() || st.size > 200 * 1024 * 1024) continue;
      try {
        map.set(sha256(fs.readFileSync(fp)), name);
      } catch {}
    }
  };
  walk(d);
  return map;
}

export function listSources(project) {
  const dir = path.join(PROJECT_DIR, project.dir || '');
  const out = [];
  const seen = new Map();
  const tenderHashes = tenderFingerprints(dir);
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
      // ---- 闸门1：文件名一看就是招标类文件 → 直接排除 ----
      if (TENDER_NAME_RE.test(name)) {
        out.push({
          id: stage + ':' + name, stage, name, baseName: meta.baseName, docKey: meta.docKey,
          origin: 'tender', path: fp, relPath: sub + '/' + name, size: st.size,
          mtime: st.mtime.toISOString(), ext, final: false,
          label: '这是招标类文件，不是投标文件', excluded: true
        });
        continue;
      }
      // ---- 闸门2：内容和「01招标文件」里某份完全一样 → 也排除（改名了也认得出） ----
      let fpHash = '';
      try { if (st.size <= 200 * 1024 * 1024) fpHash = sha256(fs.readFileSync(fp)); } catch {}
      if (fpHash && tenderHashes.has(fpHash)) {
        out.push({
          id: stage + ':' + name, stage, name, baseName: meta.baseName, docKey: meta.docKey,
          origin: 'tender', path: fp, relPath: sub + '/' + name, size: st.size,
          mtime: st.mtime.toISOString(), ext, final: false,
          label: '这份和招标文件内容完全一样（' + tenderHashes.get(fpHash) + '），不是投标文件', excluded: true
        });
        continue;
      }
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
    } else if (!row.excluded) {
      // ---- 闸门3：文件名不标准（既不是导入的、也不是工作台导出的）→ 一律不当最终版 ----
      // 以前这里直接 final=true，导致随手放进来的招标文件被当成投标文件去核查。
      row.final = false;
      row.label = '名字不标准，不确定是不是投标文件';
      row.suspect = true;
    }
    // 已被闸门1/闸门2 判定为招标类文件的，保留原来的排除理由，不要被覆盖
  }
  // ---- 闸门4：一份合格候选都没有时，不再「全勾兜底」 ----
  // 只在「确实没有任何上传版/导出版」时，才把名字不标准的文件列出来给用户确认（默认不勾）。
  if (!out.some((x) => x.final)) {
    const suspects = out.filter((x) => x.suspect && !x.excluded);
    if (!out.some((x) => x.origin === 'upload' || x.origin === 'export') && suspects.length === 1) {
      suspects[0].final = true;
      suspects[0].label = '没找到你的投标文件，先拿它顶上——请确认这份是不是你的标书';
    }
  }

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

async function checkOneDoc(project, src, analysis, opts) {
  const o = opts || {};
  const onStage = typeof o.onStage === 'function' ? o.onStage : () => {};
  const signal = o.signal;

  fs.mkdirSync(CONV_DIR, { recursive: true });
  pruneConv();

  // v1.2.3：缓存键加上文件修改时间。同名同文件不同版本（改了内容但大小没变）不会再命中旧缓存。
  const mtimeMs = src.mtime ? Date.parse(src.mtime) || 0 : 0;
  const stamp = safeName(src.baseName || src.name).replace(/\.[^.]+$/, '') + '_' + src.size + '_' + mtimeMs;
  const pdfPath = path.join(CONV_DIR, stamp + '.pdf');
  let sourceForPdf = src.path;
  let docxForText = null;

  // .doc → 先另存为 .docx
  if (src.ext === '.doc') {
    const docxPath = path.join(CONV_DIR, stamp + '.docx');
    if (!fs.existsSync(docxPath)) {
      try {
        fs.writeFileSync(docxPath, await docToDocx(src.path, docxPath, { onProgress: o.onProgress, signal }));
      } catch (e) {
        if (e && e.code === 'CONVERT_CANCELLED') throw e;
        throw new Error('这份老版 Word（.doc）打不开：' + (e && e.message ? e.message : e) + '。请在 Word 里另存为 .docx 再上传。');
      }
    }
    sourceForPdf = docxPath;
    docxForText = docxPath;
  } else if (src.ext === '.docx') {
    docxForText = src.path;
  }

  // .docx → Word 另存 PDF（页码、空白页、正副本标注都要看真实排版）
  let degradedReason = '';
  if (sourceForPdf !== src.path || src.ext === '.docx') {
    if (!fs.existsSync(pdfPath)) {
      let lastErr = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (signal && signal.aborted) { const e2 = new Error('已取消'); e2.code = 'CONVERT_CANCELLED'; throw e2; }
        try {
          await docxToPdf(sourceForPdf, pdfPath, { onProgress: o.onProgress, signal });
          lastErr = null;
          break;
        } catch (e) {
          if (e && e.code === 'CONVERT_CANCELLED') throw e;
          lastErr = e;
          // 超时了就别再重试，直接走降级，不然要白等两个 8 分钟
          if (e && (e.code === 'CONVERT_TIMEOUT' || e.code === 'CONVERT_STALLED')) break;
          await sleep(2000);
          try { if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath); } catch {}
        }
      }
      if (lastErr) {
        degradedReason = (lastErr && lastErr.message) || String(lastErr) || 'Word 转 PDF 失败';
      }
    }
    if (!degradedReason) sourceForPdf = pdfPath;
  }

  // ---- 降级：转不了 PDF 时只做「文字类核查」，不让整次核查失败 ----
  if (degradedReason) {
    const fallback = await textPagesFallback(src, docxForText);
    if (!fallback) {
      throw new Error(degradedReason + ' 这份是 .doc 老格式，不能只读文字，请在 Word 里另存为 .docx 再上传。');
    }
    return { pages: fallback, pageInfo: [], text: fallback.map((p) => p.text || '').join('\n'), degraded: degradedReason };
  }

  const buf = fs.readFileSync(sourceForPdf);
  const pages = await extractPdfText(buf);
  let pageInfo = [];
  try {
    pageInfo = await getPageInfo(buf);
  } catch {
    pageInfo = [];
  }
  let text = pages.map((p) => p.text || '').join('\n');

  // v1.1.4：整份几乎没有文字（扫描件/图片版 PDF）时，用本机 OCR 补一遍文字，否则条款核对全是空的
  if (text.replace(/\s/g, '').length < 200 && pages.length) {
    const tool = detectOcr();
    if (tool.available) {
      onStage('这份是扫描件，正在用本机 OCR 识别文字…');
      const maxPage = Math.min(pages.length, 60);
      const nums = [];
      for (let i = 1; i <= maxPage; i++) nums.push(i);
      try {
        const imgs = await renderPdfPages(buf, nums, 2);
        const tmpDir = path.join(CONV_DIR, 'ocr');
        fs.mkdirSync(tmpDir, { recursive: true });
        for (const n of nums) {
          if (signal && signal.aborted) { const e2 = new Error('已取消'); e2.code = 'CONVERT_CANCELLED'; throw e2; }
          const img = imgs.get(n);
          if (!img) continue;
          const fp = path.join(tmpDir, stamp + '_p' + n + '.png');
          fs.writeFileSync(fp, img);
          const r = await ocrImageFile(fp);
          const got = String((r && r.text) || '').trim();
          if (got && pages[n - 1]) pages[n - 1].text = got;
          try { fs.unlinkSync(fp); } catch {}
        }
        text = pages.map((p) => p.text || '').join('\n');
      } catch (e) {
        if (e && e.code === 'CONVERT_CANCELLED') throw e;
        // 识别失败不阻断核查，按原来的「文字核对不到」提示继续
      }
    }
  }

  return { pages, pageInfo, text, degraded: '' };
}

// 转不了 PDF 时的兜底：从 Word 里抽纯文字，按长度切成「伪页」，只够做文字类核查
async function textPagesFallback(src, docxPath) {
  const target = docxPath || (src.ext === '.docx' ? src.path : null);
  if (!target) return null;
  let text = '';
  try { text = await extractDocxText(fs.readFileSync(target)); } catch { return null; }
  const clean = String(text || '').replace(/\r/g, '').trim();
  if (!clean) return null;
  const size = 2400;
  const out = [];
  for (let i = 0; i < clean.length; i += size) {
    out.push({ page: out.length + 1, text: clean.slice(i, i + size) });
  }
  return out;
}

// 降级时只能做这些文字类检查（页码、空白页、正副本标注要真实排版，做不了）
function textOnlyRuleCheck(pages, project, doc) {
  const fake = ruleCheck(pages, project, doc, []);
  const keep = new Set(['placeholder', 'date', 'idfill']);
  return fake.filter((x) => keep.has(x.key));
}

// ---------- 逐条核查 / 评标 由 checkAI.mjs 负责 ----------

export function requirementSummary(doc) {
  const r = doc && doc.req;
  if (!r || !r.stat) return null;
  return r;
}

// ---------- 任务 ----------
// v1.2.3：核查任务加了「阶段 / 已用时 / 最后活动时间 / 可停止」，
// 用来把「正在读取文件」这种笼统提示换成看得懂的进度，并让僵死可判定。
const tasks = new Map();
const STALL_MS = 180 * 1000;      // 3 分钟没有任何进展 → 判定卡死
const WATCH_MS = 10 * 1000;

function taskFile(id) { return path.join(TASKS_DIR, id + '.json'); }
function persist(t) {
  try {
    // 不要把 AbortController 这种运行时对象写进 json（会变成 {}，重启后读出来是个假对象）
    const { _abort, ...plain } = t;
    fs.writeFileSync(taskFile(t.id), JSON.stringify(plain, null, 2), 'utf8');
  } catch {}
}

function taskView(t) {
  if (!t) return t;
  const started = Date.parse(t.startedAt) || Date.now();
  const o = { ...t };
  o.elapsedSec = Math.max(0, Math.round(((t.finishedAt ? Date.parse(t.finishedAt) : Date.now()) - started) / 1000));
  o.idleSec = t.lastTickAt ? Math.max(0, Math.round((Date.now() - t.lastTickAt) / 1000)) : 0;
  o.canStop = t.state === 'running';
  return o;
}

export function getCheckTask(id) {
  if (tasks.has(id)) return taskView(tasks.get(id));
  const f = taskFile(id);
  if (fs.existsSync(f)) {
    try {
      const t = JSON.parse(fs.readFileSync(f, 'utf8'));
      // v1.2.3 启动自愈：落盘里还是 running 但内存里没有 → 说明上次服务退出/崩了，不会再有人更新它
      if (t && t.state === 'running') {
        t.state = 'stalled';
        t.message = '上次核查没跑完（工作台中途重启或转换卡住了）。点「重新核查」重跑一次。';
        t.finishedAt = new Date().toISOString();
        t.lastTickAt = 0;
        try { fs.writeFileSync(f, JSON.stringify(t, null, 2), 'utf8'); } catch {}
      }
      return taskView(t);
    } catch {}
  }
  return null;
}

// v1.1.5：列出所有还在跑的核查任务（首页任务中心用）
export function listCheckTasks() {
  const out = [];
  tasks.forEach((t) => { if (t && t.state === 'running') out.push(taskView(t)); });
  return out;
}

// v1.2.3：启动自愈。上次服务退出/崩掉时，落盘里可能还留着 running 的任务，
// 那些任务再也不会有人更新了，启动时统一标成「上次没跑完」，页面上就不会一直转圈。
export function healStaleTasks() {
  try {
    if (!fs.existsSync(TASKS_DIR)) return 0;
    let n = 0;
    for (const name of fs.readdirSync(TASKS_DIR)) {
      if (!name.endsWith('.json')) continue;
      const fp = path.join(TASKS_DIR, name);
      let t;
      try { t = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; }
      if (!t || t.state !== 'running') continue;
      t.state = 'stalled';
      t.message = '上次核查没跑完（工作台中途重启或转换卡住了）。点「重新核查」重跑一次。';
      t.finishedAt = new Date().toISOString();
      t.lastTickAt = 0;
      delete t._abort;
      try { fs.writeFileSync(fp, JSON.stringify(t, null, 2), 'utf8'); n++; } catch {}
    }
    return n;
  } catch { return 0; }
}

// v1.2.3：手动停止本次核查
export function stopCheckTask(id) {
  const t = tasks.get(id);
  if (!t) return null;
  if (t.state !== 'running') return taskView(t);
  t.stopRequested = true;
  t.message = '正在停止…（等当前这一步收尾）';
  t.lastTickAt = Date.now();
  persist(t);
  try { if (t._abort) t._abort.abort(); } catch {}
  return taskView(t);
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
  // 同项目已经在跑：只有在它还活着（3 分钟内有进展）时才复用它；
  // 已经僵死的就标成 stalled，另外开一个新任务——这就是以前点「重新核查」没反应的原因。
  for (const t of tasks.values()) {
    if (t.projectId !== project.id || t.state !== 'running') continue;
    if (Date.now() - (t.lastTickAt || 0) < STALL_MS) return taskView(t);
    t.state = 'stalled';
    t.message = '上一次核查超过 3 分钟没有任何进展，判定为卡死，已经自动停下。下面是重新开的这一次。';
    t.finishedAt = new Date().toISOString();
    persist(t);
    try { if (t._abort) t._abort.abort(); } catch {}
  }

  const aiOn = apiReady();
  const t = {
    id: uid('t_'),
    projectId: project.id,
    state: 'running',
    stage: '准备',
    message: '准备开始核查…',
    progress: 0,
    total: sources.length,
    docIndex: 0,
    ai: aiOn && !!analysis,
    startedAt: new Date().toISOString(),
    lastTickAt: Date.now(),
    stopRequested: false
  };
  const ac = new AbortController();
  t._abort = ac;
  tasks.set(t.id, t);
  persist(t);

  // 进度统一入口：任何一步只要动一下，就刷新最后活动时间，卡死判定不会被误触
  const step = (msg, stage) => {
    t.message = msg;
    if (stage) t.stage = stage;
    t.lastTickAt = Date.now();
    persist(t);
  };
  const onProgress = (sec) => {
    t.message = (t.stage || '转换') + '：Word 还在处理，已经等了 ' + sec + ' 秒…（超时会长提示，可以点「停止本次核查」）';
    t.lastTickAt = Date.now();
    persist(t);
  };

  // 看门狗：3 分钟没进展就自己判死，别让页面一直转圈
  const watch = setInterval(() => {
    if (t.state !== 'running') { clearInterval(watch); return; }
    if (Date.now() - (t.lastTickAt || 0) >= STALL_MS) {
      t.state = 'stalled';
      t.message = '已经 3 分钟没有任何进展，判定卡死了（多半是 Word 转换卡住）。点「重新核查」重跑，或先到任务管理器结束 WINWORD。';
      t.finishedAt = new Date().toISOString();
      persist(t);
      try { ac.abort(); } catch {}
      clearInterval(watch);
    }
  }, WATCH_MS);
  if (watch.unref) watch.unref();

  (async () => {
    const results = [];
    const degradedDocs = [];
    try {
      for (let i = 0; i < sources.length; i++) {
        if (ac.signal.aborted) throw Object.assign(new Error('已停止'), { code: 'STOPPED' });
        const src = sources[i];
        t.docIndex = i + 1;
        t.progress = i;
        step('正在读取文件：' + src.name + '（' + (i + 1) + '/' + sources.length + '）', '读取文件');
        const one = { id: src.id, name: src.name, stage: src.stage, relPath: src.relPath, size: src.size };
        try {
          const conv = await checkOneDoc(project, src, analysis, {
            signal: ac.signal,
            onProgress,
            onStage: (m) => step(src.name + ' · ' + m, '读取文件')
          });
          const { pages, pageInfo, text } = conv;
          one.degraded = conv.degraded || '';
          if (one.degraded) degradedDocs.push(src.name);
          one.pages = pages.length;
          one.kind = docKindOf(src.name);

          if (ac.signal.aborted) throw Object.assign(new Error('已停止'), { code: 'STOPPED' });
          step(src.name + ' · 正在做格式与要素检查…', '格式检查');
          one.checks = one.degraded ? textOnlyRuleCheck(pages, project, src) : ruleCheck(pages, project, src, pageInfo);
          if (one.degraded) one.checksOmitted = ['空白页（需要真实排版）', '页码连续性（需要真实排版）', '封面正副本标注（需要真实排版）'];
          one.textChars = text.length;
          one._pages = pages;

          // ① 逐条对照招标文件要求核查
          if (aiOn && analysis && one.kind !== 'price') {
            try {
              step(src.name + ' · 准备逐条核对招标要求…', '逐条核对');
              one.req = await aiRequirementCheck(project, analysis, pages, src.name, (m) => step(src.name + ' · ' + m, '逐条核对'));
            } catch (e) {
              one.reqError = '逐条核查没跑成功：' + (e && e.message ? e.message : e);
            }
          }

          const reqStat = one.req && one.req.stat;
          one.fatal = one.checks.filter((c) => c.level === 'fatal').length + (reqStat ? reqStat.missFatal : 0);
          one.warn = one.checks.filter((c) => c.level === 'warn').length
            + (reqStat ? ((reqStat.missing - reqStat.missFatal) > 0 ? 1 : 0) + (reqStat.partial > 0 ? 1 : 0) : 0);
          // 废标/★条款只做到「部分响应」（缺材料、缺签章）也单独提示，这一项交人工确认
          if (reqStat && reqStat.riskyFatal > 0) one.warn += 1;
        } catch (e) {
          // 用户点了「停止本次核查」时，转换会被取消，错误码是 CONVERT_CANCELLED。
          // 以前这里只认 STOPPED，取消就被当成「这份文件读不了」吞掉，
          // 结果照样保存成一份「核查完成：全部通过」的假结论。现在取消一律往上抛。
          if (e && (e.code === 'STOPPED' || e.code === 'CONVERT_CANCELLED' || t.stopRequested)) throw e;
          one.error = e.message;
        }
        results.push(one);
        t.progress = i + 1;
        t.lastTickAt = Date.now();
      }

      // ② 深度模拟评标（只对一份主要是投标文件的那份做）
      if (aiOn && analysis && !ac.signal.aborted) {
        const pick = pickScoreDoc(results);
        if (pick && pick._pages) {
          try {
            step('正在按评分项逐项模拟评标…', '模拟评标');
            pick.score = await aiDeepScore(project, analysis, pick._pages, pick.name, (m) => step(m, '模拟评标'));
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
        checkAt: new Date().toISOString()
      };
      saveCheck(project.id, check);

      t.state = 'done';
      t.stage = '完成';
      t.progress = sources.length;
      t.total = sources.length;
      const base = fatal ? ('核查完成：' + fatal + ' 个必须改的问题') : warn ? ('核查完成：' + warn + ' 处建议核对') : '核查完成：全部通过';
      t.message = degradedDocs.length
        ? base + '（' + degradedDocs.length + ' 份文件 Word 转 PDF 失败，只做了文字类核查：空白页、页码、封面标注这三项没查，请人工补看）'
        : base;
      t.degradedDocs = degradedDocs;
      t.finishedAt = new Date().toISOString();
      t.lastTickAt = Date.now();
      persist(t);
    } catch (e) {
      const stopped = e && (e.code === 'STOPPED' || e.code === 'CONVERT_CANCELLED' || t.stopRequested);
      t.state = stopped ? 'stopped' : 'error';
      t.message = stopped ? '已停止本次核查（没查完的没保存，随时可以重新核查）' : (e.message || '核查失败');
      t.finishedAt = new Date().toISOString();
      t.lastTickAt = Date.now();
      persist(t);
    } finally {
      clearInterval(watch);
    }
  })();

  return taskView(t);
}
