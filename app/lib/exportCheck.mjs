// 模块4：核查报告导出 docx（逐条响应对照 + 深度模拟评标）
import fs from 'node:fs';
import path from 'node:path';
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType, Footer, PageNumber,
  TableLayoutType
} from 'docx';

const FONT = '宋体';
const HEI = '黑体';
const PAGE_TEXT_WIDTH = 11906 - 1418 * 2;

const COL_WEIGHT = { '序号': 7, '页码': 12, '结论': 12, '满分': 9, '得分': 9, '得分点': 26, '判断': 12, '评分项': 22, '招标要求': 58, '证据/说明': 52, '证明材料': 40, '怎么补': 45, '加分': 9, '风险': 45 };

function weightOf(name) {
  const k = String(name == null ? '' : name).replace(/\s/g, '');
  if (COL_WEIGHT[k]) return COL_WEIGHT[k];
  if (/页码|序号|结论|满分|得分|加分|判断/.test(k)) return 11;
  return 52;
}

function computeWidths(columns) {
  // 列定义里给了 w 就用它，没给才按表头名猜
  const ws = columns.map((c) => (c && typeof c === 'object' && c.w ? Number(c.w) : weightOf(c && c.t)));
  const total = ws.reduce((a, b) => a + b, 0);
  let out = ws.map((w) => Math.max(600, Math.round((w / total) * PAGE_TEXT_WIDTH)));
  const diff = PAGE_TEXT_WIDTH - out.reduce((a, b) => a + b, 0);
  if (diff) {
    let mi = 0;
    for (let i = 1; i < out.length; i++) if (out[i] > out[mi]) mi = i;
    out[mi] += diff;
  }
  return out;
}

function cellPara(text, o = {}) {
  return new Paragraph({
    alignment: o.center ? AlignmentType.CENTER : AlignmentType.LEFT,
    spacing: { before: 20, after: 20 },
    children: [new TextRun({ text: String(text == null ? '' : text), font: FONT, size: o.size || 17, bold: !!o.bold, color: o.color || '000000' })]
  });
}

function makeCell(text, widthDxa, o = {}) {
  return new TableCell({
    width: { size: widthDxa, type: WidthType.DXA },
    shading: o.fill ? { type: ShadingType.CLEAR, fill: o.fill, color: 'auto' } : undefined,
    margins: { top: 40, bottom: 40, left: 80, right: 80 },
    children: [cellPara(text, o)]
  });
}

function buildTable(columns, rows) {
  const widths = computeWidths(columns);
  const border = { style: BorderStyle.SINGLE, size: 4, color: 'AAAAAA' };
  const borders = { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border };
  return new Table({
    layout: TableLayoutType.FIXED,
    width: { size: PAGE_TEXT_WIDTH, type: WidthType.DXA },
    columnWidths: widths,
    borders,
    rows: [
      new TableRow({
        tableHeader: true,
        children: columns.map((c, i) => makeCell(c.t, widths[i], { bold: true, center: true, fill: 'D9E2F3', size: 17 }))
      }),
      ...rows.map((r) => new TableRow({
        // 一行内容不跨页断开，避免下一页顶部出现只有半截文字的空白序号
        cantSplit: true,
        children: columns.map((c, i) => makeCell(r[c.k] == null ? '' : r[c.k], widths[i], { fill: r.__fill, size: 16 }))
      }))
    ]
  });
}

const LEVEL = { fatal: '必须改', warn: '建议核对', ok: '通过' };
const LEVEL_FILL = { fatal: 'FBE4E4', warn: 'FFF6DA' };
const S_TEXT = { 2: '完全响应', 1: '部分响应', 0: '未响应' };
const S_FILL = { 2: 'E8F4E8', 1: 'FFF6DA', 0: 'FBE4E4' };

function p(text, o = {}) {
  return new Paragraph({
    alignment: o.center ? AlignmentType.CENTER : AlignmentType.LEFT,
    spacing: { before: o.before == null ? 60 : o.before, after: o.after == null ? 60 : o.after, line: o.line || 320 },
    indent: o.indent ? { firstLine: 480 } : undefined,
    children: [new TextRun({ text: String(text == null ? '' : text), font: o.font || FONT, size: o.size || 21, bold: !!o.bold, color: o.color || '000000' })]
  });
}

function h(text, level) {
  return new Paragraph({
    heading: level === 1 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2,
    spacing: { before: level === 1 ? 300 : 220, after: 120 },
    children: [new TextRun({ text, font: HEI, size: level === 1 ? 30 : 25, bold: true, color: '000000' })]
  });
}

export function exportCheckDocx(project, check, outPath) {
  const verdictText = check.verdict === 'red' ? '存在必须修改的问题，暂不建议递交'
    : check.verdict === 'amber' ? '有几处需要你核对' : '全部检查通过';
  const blocks = [];

  blocks.push(p('投标文件核查报告', { center: true, size: 40, bold: true, font: HEI, before: 0, after: 200 }));
  blocks.push(p(project.name || '', { center: true, size: 28, bold: true, after: 80 }));
  blocks.push(p(`招标编号：${project.code || '—'}　投标截止：${project.bidDeadline || '—'}`, { center: true, size: 21, after: 40 }));
  blocks.push(p(`核查时间：${new Date(check.checkAt).toLocaleString('zh-CN')}`, { center: true, size: 21, after: 200 }));

  blocks.push(p(`总体结论：${verdictText}`, { bold: true, size: 24, before: 120 }));
  const riskyTotal = check.docs.reduce((n, d) => n + ((d.req && d.req.stat && d.req.stat.riskyFatal) || 0), 0);
  blocks.push(p(`必须改 ${check.fatal} 项，建议核对 ${check.warn} 项，共核查 ${check.docs.length} 份文件，逐条对照招标文件要求 ${check.reqTotal || 0} 条。` +
    (riskyTotal ? `其中有 ${riskyTotal} 条废标/★实质性条款只做到「部分响应」（缺材料、缺签章或只写了"满足"），这类条款没有部分响应一说，递交前必须补齐，详见各份文件的逐条对照表。` : ''), { size: 21, after: 120 }));
  if (!check.aiUsed) {
    blocks.push(p('说明：本次没有接入 AI 或还没有做「招标分析」，因此只做了格式与页码等基础检查，没有逐条对照招标要求。建议先跑一次招标分析再核查。', { size: 19, color: 'C00000', after: 120 }));
  }

  blocks.push(h('一、逐份核查结果', 1));
  for (const d of check.docs) {
    blocks.push(h(d.name, 2));
    if (d.error) {
      blocks.push(p('这份文件没能检查：' + d.error, { color: 'C00000' }));
      continue;
    }
    const reqStat = d.req && d.req.stat;
    blocks.push(p(`共 ${d.pages} 页。基础检查：必须改 ${d.checks.filter((c) => c.level === 'fatal').length} 项、建议核对 ${d.checks.filter((c) => c.level === 'warn').length} 项。` +
      (reqStat ? `招标要求逐条对照：共 ${reqStat.total} 条，完全响应 ${reqStat.ok} 条、部分响应 ${reqStat.partial} 条、未响应 ${reqStat.missing} 条（其中带★或废标 ${reqStat.missFatal} 条）。` +
        (reqStat.riskyFatal ? `废标/★实质性条款未完全响应 ${reqStat.riskyFatal} 条，必须逐条补齐。` : '') : ''), { size: 20, after: 80 }));

    // 1.1 基础检查
    blocks.push(p('（一）格式与要素检查', { bold: true, size: 22, before: 120, after: 60 }));
    blocks.push(buildTable([
      { k: 'no', t: '序号', w: 6 },
      { k: 'item', t: '检查项', w: 22 },
      { k: 'level', t: '结论', w: 10 },
      { k: 'detail', t: '具体情况', w: 40 },
      { k: 'suggest', t: '怎么改', w: 24 }
    ], (d.checks || []).map((c, i) => ({
      no: i + 1,
      item: c.title,
      level: LEVEL[c.level] || c.level,
      detail: c.detail,
      suggest: c.suggest || '',
      __fill: c.level === 'ok' ? undefined : LEVEL_FILL[c.level]
    }))));
    blocks.push(p('', { after: 100 }));

    // 1.2 招标要求逐条对照
    if (reqStat) {
      const need = (d.req.items || []).filter((x) => x.s !== 2);
      const okList = (d.req.items || []).filter((x) => x.s === 2);
      blocks.push(p(`（二）招标文件要求逐条对照（${reqStat.total} 条）`, { bold: true, size: 22, before: 140, after: 60 }));
      if (d.req.overview) blocks.push(p('总体判断：' + d.req.overview, { size: 19, color: '444444' }));
      if (reqStat.omittedPages) {
        blocks.push(p(`注：投标文件较长，本次有 ${reqStat.omittedPages} 页没有放进核对范围，涉及这些页的要求可能被误判，请人工确认。`, { size: 18, color: 'C00000' }));
      }

      blocks.push(p(`1. 未完全响应的要求（${need.length} 条）——这些是你要改的地方`, { bold: true, size: 20, before: 100, after: 60 }));
      if (need.length) {
        blocks.push(buildTable([
          { k: 'no', t: '序号', w: 6 },
          { k: 'req', t: '招标要求原件（含页码与★/废标标记）', w: 52 },
          { k: 's', t: '结论', w: 12 },
          { k: 'note', t: '差在哪儿 / 怎么补', w: 30 }
        ], need.map((x, i) => ({
          no: i + 1,
          req: (x.fatal ? '【废标】' : x.fatalByRule ? '【含废标后果】' : '') + (x.star ? '★' : '') + (x.page ? '[第' + x.page + '页] ' : '') + '（' + x.secTitle + '）' + x.text,
          s: S_TEXT[x.s],
          note: [x.note, x.evidence ? '已出现：' + x.evidence : ''].filter(Boolean).join('；'),
          __fill: S_FILL[x.s]
        }))));
      } else {
        blocks.push(p('全部要求都能在投标文件里找到对应内容。', { size: 20 }));
      }
      blocks.push(p('', { after: 100 }));

      blocks.push(p(`2. 完全响应的要求（${okList.length} 条）`, { bold: true, size: 20, before: 100, after: 60 }));
      if (okList.length) {
        blocks.push(buildTable([
          { k: 'no', t: '序号', w: 6 },
          { k: 'req', t: '招标要求', w: 58 },
          { k: 's', t: '结论', w: 12 },
          { k: 'e', t: '投标文件中的证据', w: 24 }
        ], okList.map((x, i) => ({
          no: i + 1,
          req: (x.fatal ? '【废标】' : x.fatalByRule ? '【含废标后果】' : '') + (x.star ? '★' : '') + (x.page ? '[第' + x.page + '页] ' : '') + x.text,
          s: S_TEXT[x.s],
          e: x.evidence || '',
          __fill: 'F2F7F2'
        }))));
      }
      blocks.push(p('', { after: 120 }));
    }
  }

  // 二、模拟评标
  const sim = (check.docs.find((d) => d.score && d.score.items) || {}).score;
  if (sim) {
    blocks.push(h('二、模拟评标（按评分项逐项拆解）', 1));
    if (sim.error) {
      blocks.push(p(sim.error, { color: 'C00000' }));
    } else {
      blocks.push(p(`按招标文件评分表逐项拆解后，预估得分 ${sim.total} / ${sim.full} 分（${sim.pct || 0}%）。这是按现有投标文件内容做的模拟判断，供你查漏补缺。`, { size: 20, after: 120 }));
      blocks.push(buildTable([
        { k: 'name', t: '评分项', w: 26 },
        { k: 'max', t: '满分', w: 9 },
        { k: 'got', t: '预估', w: 9 },
        { k: 'reason', t: '得分理由', w: 56 }
      ], sim.items.map((x) => ({
        name: x.name, max: x.max, got: x.got == null ? '—' : x.got, reason: x.reason,
        __fill: x.got != null && x.max && x.got >= x.max ? 'E8F4E8' : 'FFF6DA'
      }))));
      blocks.push(p('', { after: 120 }));

      for (const it of sim.items) {
        blocks.push(p(`${it.name}（满分 ${it.max}，预估 ${it.got == null ? '—' : it.got}）`, { bold: true, size: 22, before: 200, after: 60 }));
        if ((it.breakdown || []).length) {
          blocks.push(buildTable([
            { k: 'point', t: '得分点要求', w: 30 },
            { k: 'need', t: '需要的证明材料', w: 22 },
            { k: 'found', t: '投标文件里', w: 10 },
            { k: 'evidence', t: '证据原句 / 判断说明', w: 28 },
            { k: 'score', t: '得分', w: 8 }
          ], it.breakdown.map((b) => ({
            point: b.point,
            need: b.need,
            found: b.found ? '有' : '没有',
            evidence: [b.evidence, b.note].filter(Boolean).join('；'),
            score: b.score,
            __fill: b.judge === '不得分' ? 'FBE4E4' : b.judge === '部分得分' ? 'FFF6DA' : undefined
          }))));
        }
        if ((it.lost || []).length) {
          blocks.push(p('失分点与补法', { bold: true, size: 20, before: 100, after: 40 }));
          blocks.push(buildTable([
            { k: 'point', t: '失分点', w: 30 },
            { k: 'why', t: '缺什么', w: 30 },
            { k: 'fix', t: '具体怎么补', w: 32 },
            { k: 'gain', t: '加分', w: 8 }
          ], it.lost.map((l) => ({ point: l.point, why: l.why, fix: l.fix, gain: l.gain || '', __fill: 'FFF6DA' }))));
        }
        if ((it.risk || []).length) {
          blocks.push(p('评委可能质疑的风险点：' + it.risk.join('；'), { size: 19, color: 'C00000', indent: true }));
        }
        if (it.improve) blocks.push(p('修改后预计：' + it.improve, { size: 19, indent: true }));
        blocks.push(p('', { after: 80 }));
      }

      if ((sim.tips || []).length) {
        blocks.push(h('三、提分优先级（按可加分从多到少）', 1));
        sim.tips.forEach((t, i) => {
          blocks.push(p(`${i + 1}. 【${t.item || ''}】${t.point || ''}：${t.fix || ''}（预计 +${t.gain || 0} 分）`, { size: 20, indent: true }));
        });
      }
    }
  }

  blocks.push(h('四、递交前最后一遍', 1));
  blocks.push(p('1. 把上面「必须改」的每一项都改掉，改完再核查一次。', { size: 21, indent: true }));
  blocks.push(p('2. 打开 Word「文件 → 信息 → 检查文档」，删除作者、批注等个人信息。', { size: 21, indent: true }));
  blocks.push(p('3. 打印前用 PDF 预览一遍，重点看表格有没有跨页断开、有没有空白页。', { size: 21, indent: true }));

  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: 21 } } } },
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1440, bottom: 1440, left: 1418, right: 1418 } } },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: '第 ', font: FONT, size: 18 }), new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 18 }), new TextRun({ text: ' 页', font: FONT, size: 18 })]
          })]
        })
      },
      children: blocks
    }]
  });

  return Packer.toBuffer(doc).then((buf) => {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, buf);
    return outPath;
  });
}
