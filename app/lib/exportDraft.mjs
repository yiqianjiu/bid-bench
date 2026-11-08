import fs from 'node:fs';
import {
  Document, Packer, Paragraph, TextRun, AlignmentType, Table, TableRow, TableCell,
  WidthType, BorderStyle, ShadingType, PageBreak, Footer, PageNumber, HeadingLevel,
  TableOfContents, SectionType, VerticalAlign, TableLayoutType,
} from 'docx';

const FONT = '宋体';
const HEI = '黑体';
const A4 = { width: 11906, height: 16838 };
const MARGIN = { top: 1440, bottom: 1440, left: 1418, right: 1418 };
// A4 去掉左右页边距后的正文可用宽度（dxa）
const PAGE_TEXT_WIDTH = A4.width - MARGIN.left - MARGIN.right;

const P = (text, o = {}) => new Paragraph({
  alignment: o.align || AlignmentType.LEFT,
  spacing: { line: o.line || 360, before: o.before || 0, after: o.after || 0 },
  indent: o.indent,
  children: [new TextRun({ text: String(text == null ? '' : text), font: o.font || FONT, size: o.size || 24, bold: !!o.bold, color: o.color, break: undefined })],
});

const BLANK = (n = 1) => Array.from({ length: n }, () => new Paragraph({ children: [new TextRun({ text: '', size: 24 })] }));

function cell(text, widthDxa, o = {}) {
  return new TableCell({
    width: { size: widthDxa, type: WidthType.DXA },
    verticalAlign: VerticalAlign.CENTER,
    shading: o.fill ? { type: ShadingType.CLEAR, fill: o.fill, color: 'auto' } : undefined,
    margins: { top: 60, bottom: 60, left: 90, right: 90 },
    children: [new Paragraph({
      alignment: o.center === false ? AlignmentType.LEFT : AlignmentType.CENTER,
      spacing: { line: 280, before: 20, after: 20 },
      children: [new TextRun({ text: String(text == null ? '' : text), font: FONT, size: o.size || 19, bold: !!o.bold })],
    })],
  });
}

// 按列权重换算成 dxa 列宽，并保证每列不小于 620dxa（约 1.1cm，能放下两个字）
function computeWidths(columns) {
  const ws = columns.map((c) => Number(c.w) || 1);
  const total = ws.reduce((a, b) => a + b, 0);
  const out = ws.map((w) => Math.max(620, Math.round((w / total) * PAGE_TEXT_WIDTH)));
  // 差额加在最宽的那一列（正文列）上，不动序号/页码这类窄列
  const diff = PAGE_TEXT_WIDTH - out.reduce((a, b) => a + b, 0);
  if (diff) {
    let mi = 0;
    for (let i = 1; i < out.length; i++) if (out[i] > out[mi]) mi = i;
    out[mi] += diff;
  }
  return out;
}

function table(columns, rows, o = {}) {
  const border = { style: BorderStyle.SINGLE, size: 4, color: '808080' };
  const inner = { style: BorderStyle.SINGLE, size: 2, color: 'B0B0B0' };
  const widths = computeWidths(columns);
  const head = new TableRow({
    tableHeader: true,
    children: columns.map((c, i) => cell(c.t, widths[i], { bold: true, fill: 'D9E2F3', size: 19 })),
  });
  const body = rows.length
    ? rows.map((r) => new TableRow({ children: columns.map((c, i) => cell(r[c.k], widths[i], { center: !(o.leftKeys || []).includes(c.k), fill: r.__fill })) }))
    : [new TableRow({ children: columns.map((c, i) => cell(i === 0 ? (o.empty || '（暂无内容）') : '', widths[i], { center: true })) })];
  return new Table({
    layout: TableLayoutType.FIXED,
    width: { size: PAGE_TEXT_WIDTH, type: WidthType.DXA },
    columnWidths: widths,
    rows: [head, ...body],
    borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: inner, insideVertical: inner },
  });
}

function coverPages(doc, project) {
  const out = [];
  out.push(...BLANK(6));
  out.push(P(project.name || '投标文件', { align: AlignmentType.CENTER, font: HEI, size: 52, bold: true, line: 480 }));
  out.push(...BLANK(1));
  out.push(P(doc.title, { align: AlignmentType.CENTER, font: HEI, size: 40, bold: true, line: 440 }));
  out.push(...BLANK(6));
  const rows = [
    ['项目名称', project.name || '【请填写】'],
    ['招标编号', project.code || '【请填写】'],
    ['招标人', project.owner || '【请填写】'],
    ['投标人', project.company || '【请填写：投标人全称】'],
    ['法定代表人或授权代表', '【请填写】'],
    ['投标日期', '【请填写：年 月 日】'],
  ];
  rows.forEach(([k, v]) => {
    out.push(new Paragraph({
      alignment: AlignmentType.CENTER, spacing: { line: 400, before: 40, after: 40 },
      children: [
        new TextRun({ text: k + '：', font: HEI, size: 28, bold: true }),
        new TextRun({ text: v, font: FONT, size: 28 }),
      ],
    }));
  });
  out.push(...BLANK(4));
  out.push(P('（正本／副本）', { align: AlignmentType.CENTER, font: HEI, size: 26 }));
  return out;
}

function tocPages() {
  return [
    P('目  录', { align: AlignmentType.CENTER, font: HEI, size: 36, bold: true, line: 420, after: 240 }),
    new TableOfContents('目录', { hyperlink: true, headingStyleRange: '1-3' }),
  ];
}

function headingOf(text, level) {
  const lv = Math.min(3, Math.max(1, Number(level) || 1));
  const heading = lv === 1 ? HeadingLevel.HEADING_1 : lv === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3;
  const size = lv === 1 ? 32 : lv === 2 ? 28 : 24;
  return new Paragraph({
    heading,
    spacing: { line: 400, before: lv === 1 ? 240 : 180, after: lv === 1 ? 160 : 120 },
    indent: lv === 1 ? undefined : { left: 0 },
    children: [new TextRun({ text, font: HEI, size, bold: true, color: '000000' })],
  });
}

function bodyParas(text) {
  const lines = String(text || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return [P('（本章内容尚未填写：可在工作台里用 AI 生成，或自行撰写后再下载）', { color: '999999', indent: { firstLine: 480 } })];
  return lines.map((s) => P(s, { indent: { firstLine: 480 }, after: 60, line: 360 }));
}

const PRICE1 = [
  { k: 'no', t: '序号', w: 8 }, { k: 'item', t: '项目内容', w: 30 }, { k: 'spec', t: '规格／要求', w: 30 },
  { k: 'amount', t: '金额（元）', w: 16 }, { k: 'note', t: '备注', w: 16 },
];
const PRICE2 = [
  { k: 'no', t: '序号', w: 8 }, { k: 'item', t: '费用名称', w: 26 }, { k: 'content', t: '内容说明', w: 34 },
  { k: 'amount', t: '金额（元）', w: 16 }, { k: 'note', t: '备注', w: 16 },
];
const IDX = [
  { k: 'no', t: '序号', w: 7 }, { k: 'clause', t: '招标文件条款原文', w: 55 },
  { k: 'page', t: '招标文件页码', w: 11 }, { k: 'where', t: '我方响应位置（页码）', w: 27 },
];
const DEV = [
  { k: 'no', t: '序号', w: 6 }, { k: 'clause', t: '招标文件条款原文', w: 44 },
  { k: 'page', t: '页码', w: 8 }, { k: 'response', t: '我方响应', w: 14 }, { k: 'dev', t: '偏离说明', w: 12 }, { k: 'note', t: '备注', w: 16 },
];

function chapterBlocks(c, project) {
  const out = [];
  if (c.type === 'cover') { out.push(...coverPages({ title: c.title }, project)); return out; }
  if (c.type === 'toc') { out.push(...tocPages()); return out; }
  out.push(headingOf((c.number ? c.number + ' ' : '') + c.title, c.level));
  const isTable = ['index', 'deviation', 'priceTable', 'priceTable2'].includes(c.type);
  // 分部标题（上传标书里的「资格审查部分 / 商务部分 / 技术部分」）本来就没有正文，不要加灰色占位句
  const isPart = c.noIdx && !String(c.number || '').trim();
  if (isPart) return out;
  if (!isTable || c.body) out.push(...bodyParas(c.body));
  if (c.type === 'priceTable') {
    const rows = (c.rows && c.rows.length) ? c.rows
      : Array.from({ length: 5 }, (_, i) => ({
        no: String(i + 1),
        item: i === 0 ? (project.name || '【请填写项目内容】') : '',
        spec: i === 0 ? '按招标文件要求' : '',
        amount: '',
        note: '',
      }));
    out.push(table(PRICE1, rows, { leftKeys: ['item', 'spec', 'note'] }));
    out.push(...BLANK(1));
    out.push(P('投标总价（人民币大写）：【请填写：大写金额】', { indent: { firstLine: 480 } }));
    out.push(P('投标总价（人民币小写）：【请填写：小写金额】元', { indent: { firstLine: 480 } }));
    out.push(P('注：本表报价为完成本项目全部内容的最终报价，已包含税费等一切费用。', { indent: { firstLine: 480 }, size: 21 }));
    return out;
  }
  if (c.type === 'priceTable2') {
    const rows2 = (c.rows && c.rows.length) ? c.rows
      : Array.from({ length: 6 }, (_, i) => ({ no: String(i + 1), item: '', content: '', amount: '', note: '' }));
    out.push(table(PRICE2, rows2, { leftKeys: ['item', 'content', 'note'] }));
    out.push(...BLANK(1));
    out.push(P('投标总价合计（人民币大写）：【请填写：大写金额】', { indent: { firstLine: 480 } }));
    out.push(P('投标总价合计（人民币小写）：【请填写：小写金额】元', { indent: { firstLine: 480 } }));
    out.push(P('注：价格构成应包含人工费、材料费、管理费、利润、税金等全部费用，并与开标一览表报价一致。', { indent: { firstLine: 480 }, size: 21 }));
    return out;
  }
  if (c.type === 'index') {
    if (!c.rows || !c.rows.length) {
      out.push(P('（尚未生成索引内容，请先完成招标文件分析后重新生成）', { color: '888888', indent: { firstLine: 480 } }));
    } else {
      out.push(P('说明：本表按招标文件条款逐条索引，便于评标委员会快速定位我方响应位置。', { size: 21, indent: { firstLine: 480 }, after: 120 }));
      out.push(table(IDX, c.rows, { leftKeys: ['clause'] }));
    }
    return out;
  }
  if (c.type === 'deviation') {
    if (!c.rows || !c.rows.length) {
      out.push(P('（尚未生成偏离表内容，请先完成招标文件分析后重新生成）', { color: '888888', indent: { firstLine: 480 } }));
    } else {
      out.push(table(DEV, c.rows, { leftKeys: ['clause', 'note'] }));
      out.push(...BLANK(1));
      out.push(P('我方郑重承诺：对上述招标文件条款全部响应，无任何偏离。', { indent: { firstLine: 480 } }));
      out.push(P('投标人（盖章）：______________　法定代表人或授权代表（签字）：______________', { size: 21, after: 60 }));
      out.push(P('日期：______年____月____日', { size: 21 }));
    }
    return out;
  }
  return out;
}

export function buildBodyBlocks(project, doc) {
  const rest = doc.chapters.filter((c) => c.type !== 'cover');
  const toc = rest.filter((c) => c.type === 'toc');
  const body = rest.filter((c) => c.type !== 'toc');
  const kids = [];
  toc.forEach((c) => kids.push(...chapterBlocks(c, project)));
  body.forEach((c, i) => {
    if (i > 0 || toc.length) kids.push(new Paragraph({ children: [new PageBreak()] }));
    kids.push(...chapterBlocks(c, project));
  });
  return kids;
}

export async function exportDraftDocx(project, doc, outPath) {
  const coverBlocks = coverPages(doc, project);
  const bodyBlocks = buildBodyBlocks(project, doc);
  const pageProps = { page: { size: A4, margin: MARGIN } };
  const blankFooter = new Footer({ children: [new Paragraph({ children: [new TextRun({ text: '', size: 18 })] })] });
  const numFooter = new Footer({
    children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({ text: '第 ', font: FONT, size: 18, color: '777777' }),
        new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 20, color: '777777' }),
        new TextRun({ text: ' 页', font: FONT, size: 18, color: '777777' }),
      ],
    })],
  });

  const docx = new Document({
    creator: '投标业务工作台',
    title: doc.title + ' - ' + (project.name || ''),
    description: '由投标业务工作台生成',
    styles: { default: { document: { run: { font: FONT, size: 24 } } } },
    features: { updateFields: true },
    sections: [
      { properties: { ...pageProps }, footers: { default: blankFooter }, children: coverBlocks },
      { properties: { ...pageProps, type: SectionType.NEXT_PAGE }, footers: { default: numFooter }, children: bodyBlocks },
    ],
  });
  const buf = await Packer.toBuffer(docx);
  fs.writeFileSync(outPath, buf);
  return outPath;
}
