// 废标项确定性召回（关键词扫描）
// 实务经验：招标文件里凡是出现「有效 / 应当 / 满足 / 禁止 / 否决 / 不能 / 要求 / 视为 / 无效 / 承诺 /
// 不得 / 必须 / 星号 / 资格 / 废标 / 响应 / 需要 / 应该」这类关键性词汇的句子，极大概率是废标/无效投标条款，
// 必须逐条看语义确认。本模块只负责「一条不漏地捞出来」（召回），真伪判定交给 AI 做语义分析，
// 避免把普通合规要求一律扣成废标，反过来让清单读不下去。

export const TRIGGER_WORDS = [
  '有效', '应当', '满足', '禁止', '否决', '不能', '要求', '视为', '无效', '承诺',
  '不得', '必须', '星号', '资格', '废标', '响应', '需要', '应该'
];

// 句子里直接写明法定后果 —— 命中即为废标项（不需要再判）
const STRONG_RE = /(废标|无效投标|投标无效|响应无效|报价无效|否决(?:其)?投标|不予受理|拒绝接收|拒收|取消(?:其)?(?:投标|成交|中标|中标候选)?资格|资格审查不合格|符合性审查不合格|视为(?:无效|未响应|未提交|放弃成交|放弃中标|撤回)|按无效(?:投标|响应)?处理|作无效(?:投标|响应)?处理)/;

// 条件 + 处置后果的词（出现了就要 AI 看语义）
const CONSEQ_RE = /(否则|不予|拒绝|视为|作废|无效|不合格|取消|不得分|记0分)/;

const SPLIT_RE = /[。；;\n\r]+/;

function nkey(t) {
  return String(t || '')
    .replace(/[\s\u3000，。、；：""''（）()【】《》·—\-_\/\\|]/g, '')
    .slice(0, 60);
}

// 目录行特征：连续点线（…… / ......），或形如「10.废标 ...... 28」以页码结尾
function isTocLine(t) {
  if (/[.．·…]{3,}/.test(t)) return true;
  if (/^\s*\d+(?:\.\d+)*[.．、]/.test(t) && t.length < 40) return true;
  return false;
}

// 只约束采购人/评审委员会的内部程序条款，不是对投标人的要求，收进废标清单会变噪声
function organOnly(t) {
  if (/(评审委员会|评标委员会|采购人|采购代理机构|评审专家|评委)/.test(t) && !/(供应商|投标人|响应人|响应单位|报价人|乙方)/.test(t)) return true;
  return false;
}

function splitSentences(pages, maxPages) {
  const out = [];
  for (const p of pages || []) {
    const page = Number(p.page);
    if (maxPages && page > maxPages) continue;
    // PDF 抽出来的文字会在句中硬换行，先拼回去再按句号切，否则会切出「全的视为资格审查不合格」这种残句
    const raw = String(p.text || '').replace(/\r/g, '').replace(/\n+/g, '');
    if (!raw.trim()) continue;
    for (const seg of raw.split(SPLIT_RE)) {
      const t = seg.replace(/[ \t\u3000]+/g, ' ').trim();
      if (t.length < 12) continue;             // 标题碎片、页眉页脚
      if (isTocLine(t)) continue;              // 目录行（点点点 + 页码）
      if (/[：:]$/.test(t)) continue;          // 「出现下列情形之一的：」这种引子，本身不构成条款
      if (t.length > 500) {
        out.push({ text: t.slice(0, 400), page });
        continue;
      }
      out.push({ text: t, page });
    }
  }
  return out;
}

/**
 * 扫描全文，返回废标项候选。
 * @param {Array<{page:number,text:string}>} pages
 * @param {{maxPages?:number}} [opts]
 * @returns {{strong:Array,weak:Array,counts:{strong:number,weak:number,scanned:number}}}
 */
export function scanFatalCandidates(pages, opts) {
  const maxPages = (opts && opts.maxPages) || 0;
  const sents = splitSentences(pages, maxPages);
  const seen = new Set();
  const strong = [];
  const weak = [];
  for (const s of sents) {
    const t = s.text;
    if (organOnly(t)) continue;
    const isStar = /[★▲※]/.test(t);
    const hits = TRIGGER_WORDS.filter((w) => t.includes(w));
    const strongHit = STRONG_RE.test(t);
    if (!strongHit && !isStar && !hits.length) continue;
    const k = nkey(t);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    const rec = { text: t, page: s.page, star: isStar, trigger: hits.slice(0, 4) };
    if (strongHit) strong.push(rec);
    else if (isStar) weak.push(rec);                    // 星号条款多为实质性条款，负偏离即无效，必须复核
    else if (CONSEQ_RE.test(t)) weak.push(rec);         // 「条件 + 后果」句式，交给 AI 判
    // 只有触发词、没有任何处置后果的普通要求不召回，否则噪声太大
  }
  // 弱候选按「报废标后果词 + 触发词数量」排个序，注入 prompt 时只带前面一部分
  const scoreOf = (r) => (STRONG_RE.test(r.text) ? 3 : /无效|废标|不予|拒绝|取消|不合格/.test(r.text) ? 2 : 1) + r.trigger.length * 0.1;
  weak.sort((a, b) => scoreOf(b) - scoreOf(a) || (a.page || 0) - (b.page || 0));
  return { strong, weak, counts: { strong: strong.length, weak: weak.length, scanned: sents.length } };
}

/** 判断一句招标要求文本本身是否写明了废标后果（核查阶段补漏用） */
export function isFatalClause(text) {
  const t = String(text || '');
  if (!t) return false;
  if (STRONG_RE.test(t)) return true;
  return /[★▲]/.test(t) && /(无效|废标|否决|不予|拒绝|取消|不合格)/.test(t);
}
