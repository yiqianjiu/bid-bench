import { readZipEntry } from './docxZip.mjs';

const HEADING_NAME = [
  { rx: /^(?:heading|标题)\s*([1-9])$/i, lv: 1 },
  { rx: /^([1-9])\s*级标题$/, lv: 1 },
  { rx: /^([1-9])级标题$/, lv: 1 },
];

function decodeXml(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

// 解析 styles.xml：styleId -> { name, level, numId, ilvl, basedOn }
export function parseStyles(xml) {
  const map = new Map();
  if (!xml) return map;
  const styleRx = /<w:style\b[^>]*>([\s\S]*?)<\/w:style>/g;
  let m;
  while ((m = styleRx.exec(xml))) {
    const body = m[1];
    const idM = /<w:style\b[^>]*w:styleId="([^"]+)"/.exec(m[0]);
    if (!idM) continue;
    const id = idM[1];
    const nameM = /<w:name\b[^>]*w:val="([^"]*)"/.exec(body);
    const lvlM = /<w:outlineLvl\b[^>]*w:val="(\d+)"/.exec(body);
    const baseM = /<w:basedOn\b[^>]*w:val="([^"]+)"/.exec(body);
    const name = nameM ? decodeXml(nameM[1]) : '';
    let level = lvlM ? Number(lvlM[1]) + 1 : 0;
    if (!level && name) {
      for (const h of HEADING_NAME) {
        const mm = h.rx.exec(name.trim());
        if (mm) { level = Number(mm[1]) || h.lv; break; }
      }
    }
    const np = /<w:numPr>([\s\S]*?)<\/w:numPr>/.exec(body);
    let numId = '';
    let ilvl = '';
    if (np) {
      const a = /<w:numId\b[^>]*w:val="(\d+)"/.exec(np[1]);
      const b = /<w:ilvl\b[^>]*w:val="(\d+)"/.exec(np[1]);
      if (a) numId = a[1];
      if (b) ilvl = b[1];
    }
    // 标题类样式：没写 outlineLvl 时按「N级标题」推层级
    if (!level && name) {
      const mm = /^([1-9])\s*级标题$/.exec(name.trim()) || /^(?:heading|标题)\s*([1-9])$/i.exec(name.trim());
      if (mm) level = Number(mm[1]);
    }
    map.set(id, { name, level, numId, ilvl, basedOn: baseM ? baseM[1] : '', hasNumPr: !!np, hasOutline: !!lvlM });
  }
  // basedOn 链继承（只继承本样式没写的东西）
  for (const [id, st] of map) {
    let p = st.basedOn ? map.get(st.basedOn) : null;
    let guard = 0;
    const chain = [];
    while (p && guard++ < 12) { chain.push(p); p = p.basedOn ? map.get(p.basedOn) : null; }
    if (!st.level) {
      for (const q of chain) if (q.level) { st.level = q.level; break; }
    }
    if (!st.numId) {
      for (const q of chain) if (q.numId) { st.numId = q.numId; if (!st.ilvl && q.ilvl) st.ilvl = q.ilvl; break; }
    }
    st.isHeadingStyle = st.level >= 1;
  }
  return map;
}

// 解析 numbering.xml：numId -> { abs, overrides }，abstractNumId -> Map(ilvl -> 定义)
export function parseNumbering(xml) {
  const nums = new Map();
  const abs = new Map();
  if (!xml) return { nums, abs };

  const aRx = /<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g;
  let m;
  while ((m = aRx.exec(xml))) {
    const lvls = new Map();
    const lRx = /<w:lvl\b[^>]*w:ilvl="(\d+)"[^>]*>([\s\S]*?)<\/w:lvl>/g;
    let l;
    while ((l = lRx.exec(m[2]))) {
      const body = l[2];
      const startM = /<w:start\b[^>]*w:val="(\d+)"/.exec(body);
      const fmtM = /<w:numFmt\b[^>]*w:val="([^"]+)"/.exec(body);
      const txtM = /<w:lvlText\b[^>]*w:val="([^"]*)"/.exec(body);
      const psM = /<w:pStyle\b[^>]*w:val="([^"]+)"/.exec(body);
      lvls.set(Number(l[1]), {
        start: startM ? Number(startM[1]) : 1,
        numFmt: fmtM ? fmtM[1] : 'decimal',
        lvlText: txtM ? decodeXml(txtM[1]) : '',
        pStyle: psM ? psM[1] : '',
      });
    }
    abs.set(m[1], lvls);
  }

  const nRx = /<w:num\b[^>]*w:numId="(\d+)"[^>]*>([\s\S]*?)<\/w:num>/g;
  while ((m = nRx.exec(xml))) {
    const body = m[2];
    const a = /<w:abstractNumId\b[^>]*w:val="(\d+)"/.exec(body);
    const overrides = new Map();
    const oRx = /<w:lvlOverride\b[^>]*w:ilvl="(\d+)"[^>]*>([\s\S]*?)<\/w:lvlOverride>/g;
    let o;
    while ((o = oRx.exec(body))) {
      const sM = /<w:startOverride\b[^>]*w:val="(\d+)"/.exec(o[2]);
      if (sM) overrides.set(Number(o[1]), Number(sM[1]));
    }
    nums.set(m[1], { abs: a ? a[1] : '', overrides });
  }
  return { nums, abs };
}

const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

function chineseNumber(n) {
  if (n <= 0) return String(n);
  if (n < 10) return CN_DIGITS[n];
  if (n < 20) return '十' + (n % 10 ? CN_DIGITS[n % 10] : '');
  if (n < 100) return CN_DIGITS[Math.floor(n / 10)] + '十' + (n % 10 ? CN_DIGITS[n % 10] : '');
  return String(n);
}

function romanNumber(n) {
  const table = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let out = '';
  let v = n;
  for (const [num, sym] of table) {
    while (v >= num) { out += sym; v -= num; }
  }
  return out;
}

function letterNumber(n, upper) {
  let v = n;
  let out = '';
  while (v > 0) {
    const r = (v - 1) % 26;
    out = String.fromCharCode((upper ? 65 : 97) + r) + out;
    v = Math.floor((v - 1) / 26);
  }
  return out || (upper ? 'A' : 'a');
}

function formatNum(n, fmt) {
  switch (String(fmt || 'decimal')) {
    case 'none': return '';
    case 'decimalZero': return n < 10 ? '0' + n : String(n);
    case 'upperLetter': return letterNumber(n, true);
    case 'lowerLetter': return letterNumber(n, false);
    case 'upperRoman': return romanNumber(n);
    case 'lowerRoman': return romanNumber(n).toLowerCase();
    case 'chineseCounting':
    case 'chineseCountingThousand':
    case 'ideographDigital':
    case 'japaneseCounting': return chineseNumber(n);
    case 'decimalEnclosedCircle': return n >= 1 && n <= 20 ? String.fromCharCode(0x2460 + n - 1) : String(n);
    default: return String(n);
  }
}

// 自动编号计数器
// 关键：Word 的编号计数器是「按 abstractNum 实例」维护的，不是按 numId。
// 同一 abstractNum 下的多个 numId 共用一套计数器；某个 numId 带 lvlOverride/starToverride
// 时，第一次用到它会把这套计数器在该层级（及更深层）重置为起始值。
// 实测《弘武机电-响应文件.docx》：报价函(numId 30, 重启) → 「1」，紧随其后的
// 报价一览表(numId 23，无重启) → 「2」；服务方案(numId 31, 重启) → 「1」，
// 其下的二级标题(numId 23, ilvl 1) → 「1.1」。与 Word 目录/PDF 完全一致。
function makeNumberer(nums, abs) {
  const counters = new Map();
  const used = new Set();
  function lvlDef(absId, ilvl) {
    const l = abs.get(absId);
    return l ? (l.get(ilvl) || null) : null;
  }
  function baseStart(absId, ilvl) {
    const d = lvlDef(absId, ilvl);
    return d ? d.start : 1;
  }
  function ensure(absId) {
    let a = counters.get(absId);
    if (!a) {
      a = new Array(9).fill(0);
      for (let i = 0; i < 9; i++) a[i] = baseStart(absId, i) - 1;
      counters.set(absId, a);
    }
    return a;
  }
  function applyOverrides(numId, absId) {
    const def = nums.get(numId);
    if (!def || !def.overrides || !def.overrides.size) return;
    const a = ensure(absId);
    for (const [lv, startVal] of def.overrides) {
      if (lv < 0 || lv > 8) continue;
      a[lv] = startVal - 1;
      for (let i = lv + 1; i < 9; i++) a[i] = baseStart(absId, i) - 1;
    }
  }
  return function next(numId, ilvl) {
    const def = nums.get(numId);
    const absId = def ? def.abs : '';
    const a = ensure(absId);
    if (!used.has(numId)) { applyOverrides(numId, absId); used.add(numId); }
    const lv = Math.max(0, Math.min(8, Number(ilvl) || 0));
    a[lv] = (a[lv] || 0) + 1;
    for (let i = lv + 1; i < 9; i++) a[i] = baseStart(absId, i) - 1;
    const d = lvlDef(absId, lv);
    const tpl = d && d.lvlText ? d.lvlText : new Array(lv + 1).fill('').map((_, i) => '%' + (i + 1)).join('.');
    let out = tpl.replace(/%(\d)/g, (_, k) => {
      const idx = Number(k) - 1;
      const ld = lvlDef(absId, idx);
      return formatNum(a[idx] || 1, ld ? ld.numFmt : 'decimal');
    });
    out = String(out).replace(/\s+/g, ' ').trim();
    return out;
  };
}

function styleLevel(styles, styleId) {
  const s = styles.get(styleId);
  return s && s.level ? s.level : 0;
}

function isTocStyle(id, name) {
  const s = (String(id || '') + ' ' + String(name || '')).toLowerCase();
  return /toc|目录/.test(s);
}

function paraInfo(pXml, styles) {
  const pPrM = /<w:pPr>([\s\S]*?)<\/w:pPr>/.exec(pXml);
  const pPr = pPrM ? pPrM[1] : '';
  const stM = /<w:pStyle\b[^>]*w:val="([^"]*)"/.exec(pPr);
  const styleId = stM ? stM[1] : '';
  const st = styles.get(styleId);
  const styleName = st ? st.name : styleId;
  // 层级：段落自身 outlineLvl 优先，其次样式（含 basedOn 继承）
  let level = 0;
  const dirM = /<w:outlineLvl\b[^>]*w:val="(\d+)"/.exec(pPr);
  if (dirM) level = Number(dirM[1]) + 1;
  if (!level) level = styleLevel(styles, styleId);
  // 编号：段落自身 numPr 优先，否则继承样式
  let numId = '';
  let ilvl = '';
  const npM = /<w:numPr>([\s\S]*?)<\/w:numPr>/.exec(pPr);
  if (npM) {
    const a = /<w:numId\b[^>]*w:val="(\d+)"/.exec(npM[1]);
    const b = /<w:ilvl\b[^>]*w:val="(\d+)"/.exec(npM[1]);
    if (a) numId = a[1];
    if (b) ilvl = b[1];
  }
  if (!numId && st && st.numId) {
    numId = st.numId;
    if (!ilvl && st.ilvl) ilvl = st.ilvl;
  }
  if (!ilvl && numId) ilvl = String(Math.max(0, level - 1));
  // 文本：拼接所有 w:t，w:tab 记为空格，w:br 记为换行
  let text = '';
  const tokRx = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>/g;
  let t;
  while ((t = tokRx.exec(pXml))) {
    if (t[0].startsWith('<w:tab')) text += ' ';
    else if (t[0].startsWith('<w:br')) text += '\n';
    else text += decodeXml(t[1]);
  }
  return { styleId, styleName, level, numId, ilvl, text: text.replace(/\u00a0/g, ' ').trim(), toc: isTocStyle(styleId, styleName) };
}

// 从 document.xml 抽出「标题 + 正文」结构
// opts.maxLevel：只保留到第几级标题（默认 2，即只列一级与二级标题）
export function parseDocxOutline(buf, opts) {
  const o = opts || {};
  const maxLevel = Number(o.maxLevel) || 2;
  const docXmlBuf = readZipEntry(buf, 'word/document.xml');
  if (!docXmlBuf) throw new Error('这个文件不是标准的 Word（缺少 word/document.xml）');
  const stylesBuf = readZipEntry(buf, 'word/styles.xml');
  const styles = parseStyles(stylesBuf ? stylesBuf.toString('utf8') : '');
  const numBuf = readZipEntry(buf, 'word/numbering.xml');
  const { nums, abs } = parseNumbering(numBuf ? numBuf.toString('utf8') : '');
  const numberAt = makeNumberer(nums, abs);

  const xml = docXmlBuf.toString('utf8');
  const bodyM = /<w:body>([\s\S]*)<\/w:body>/.exec(xml);
  const bodyXml = bodyM ? bodyM[1] : xml;
  const paras = [];
  const pRx = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>|<w:p\b[^>]*\/>/g;
  let m;
  while ((m = pRx.exec(bodyXml))) {
    const info = paraInfo(m[1] || '', styles);
    // 编号必须在整篇顺序里推进（3/4 级不输出也要占号），但空段落不占号：
    // 实测该文档每个「部分」末尾都有一个空的 1 级标题段落（带 sectPr 分节符），
    // 若让它占号，后面所有序号都会比 Word 目录大 1。
    if (info.numId && info.text) info.number = numberAt(info.numId, info.ilvl);
    else info.number = '';
    paras.push(info);
  }
  const chapters = [];
  let cur = null;
  const preface = [];
  let skippedToc = 0;
  let skippedDeep = 0;
  let lastKept = null;
  for (const p of paras) {
    if (!p.text) continue;
    if (p.toc) { skippedToc++; continue; }
    if (p.level >= 1 && p.level <= 4 && p.text.length <= 60) {
      if (p.level > maxLevel) {
        // 3/4 级标题不再单列成章，但标题文字保留在上一级章节正文里，避免内容丢失
        skippedDeep++;
        if (cur) cur.body.push((p.number ? p.number + ' ' : '') + p.text);
        continue;
      }
      cur = { title: p.text, number: p.number || '', level: p.level, body: [] };
      chapters.push(cur);
      lastKept = cur;
      continue;
    }
    if (cur) cur.body.push(p.text);
    else preface.push(p.text);
  }
  const out = chapters.map((c) => ({
    title: c.title || '（未命名）',
    number: c.number || '',
    level: c.level,
    body: c.body.join('\n').trim(),
  }));
  return { chapters: out, preface: preface.join('\n').trim(), skippedToc, skippedDeep, lastKeptLevel: lastKept ? lastKept.level : 0 };
}
