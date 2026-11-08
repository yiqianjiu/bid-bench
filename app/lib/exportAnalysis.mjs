import fs from 'node:fs';
import path from 'node:path';
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType, PageBreak, Footer, PageNumber,
  TableLayoutType
} from 'docx';

const FONT = '宋体';

// A4（11906）去掉左右页边距各 1418 后的可用正文宽度
const PAGE_TEXT_WIDTH = 11906 - 1418 * 2;

function cellPara(text, opts) {
  const o = opts || {};
  return new Paragraph({
    spacing: { before: 20, after: 20 },
    alignment: o.center ? AlignmentType.CENTER : AlignmentType.LEFT,
    children: [new TextRun({ text: String(text == null ? '' : text), font: FONT, size: o.size || 20, bold: !!o.bold, color: o.color })]
  });
}

// 每一列给一个"权重"，按列的含义分配宽度，避免序号/页码这类短列占满、正文列被压窄
const COL_WEIGHT = {
  '序号': 7,
  '页码': 14,
  '分值': 10,
  '所属板块': 16,
  '审查因素': 22,
  '评分项': 24,
  '项目': 26,
  '条款内容': 58,
  '审查内容': 62,
  '评分标准': 62,
  '内容': 62
};

function weightOf(name) {
  const k = String(name == null ? '' : name).replace(/\s/g, '');
  if (COL_WEIGHT[k]) return COL_WEIGHT[k];
  // 兜底：名字里带"页码/序号/分值"的算窄列，其余算正文列
  if (/页码|序号|分值|编号/.test(k)) return 10;
  if (/内容|标准|要求|说明|条款|项目名称/.test(k)) return 60;
  return 30;
}

// 把权重换算成 dxa 列宽（Word 里最稳的单位），并保证每列不小于 640dxa 可读
function computeWidths(columns) {
  const ws = columns.map(weightOf);
  const total = ws.reduce((a, b) => a + b, 0);
  const minW = 640;
  let out = ws.map((w) => Math.max(minW, Math.round((w / total) * PAGE_TEXT_WIDTH)));
  // 修正四舍五入/最小宽度带来的误差：把差额加在"最宽的那一列"（正文列）上，
  // 既不动序号/页码这些窄列，也保证所有列宽之和正好等于正文宽度。
  const diff = PAGE_TEXT_WIDTH - out.reduce((a, b) => a + b, 0);
  if (diff) {
    let mi = 0;
    for (let i = 1; i < out.length; i++) if (out[i] > out[mi]) mi = i;
    out[mi] += diff;
  }
  return out;
}

function makeCell(text, widthDxa, opts) {
  const o = opts || {};
  return new TableCell({
    width: { size: widthDxa, type: WidthType.DXA },
    shading: o.fill ? { type: ShadingType.CLEAR, fill: o.fill } : undefined,
    margins: { top: 60, bottom: 60, left: 100, right: 100 },
    children: [cellPara(text, o)]
  });
}

function buildTable(columns, rows) {
  // columns: 表头数组；rows: [{cells:[], isStar, isFatal, confirmed}]
  const n = columns.length;
  const widths = computeWidths(columns);
  let widest = 0;
  for (let i = 1; i < n; i++) if (widths[i] > widths[widest]) widest = i;

  const header = new TableRow({
    tableHeader: true,
    children: columns.map((c, i) => makeCell(c, widths[i], { bold: true, center: true, fill: 'D9E2F3', size: 19 }))
  });

  const body = rows.map((r) => {
    const fill = r.isFatal ? 'FBE4E4' : r.isStar ? 'FFF6DA' : undefined;
    const cells = [];
    for (let i = 0; i < n; i++) {
      let v = r.cells ? (r.cells[i] || '') : '';
      // 标记加在最宽的那一列（正文列）开头：加在页码列上会把「【废标】第 32 页」挤成两行；
      // 正文里本来就带 ★ 的就不再重复加【★】
      if (i === widest && (r.isStar || r.isFatal)) {
        const already = r.isFatal ? /【废标】/.test(v) : /[★]/.test(v);
        if (!already) v = (r.isFatal ? '【废标】' : '【★】') + v;
      }
      cells.push(makeCell(v, widths[i], { fill, size: 18 }));
    }
    return new TableRow({ children: cells });
  });

  return new Table({
    // 关键：固定布局 + 明确列宽。只给百分比、不给 FIXED 时，Word 会按内容自动伸缩，
    // 正文列反而被压窄，出现"序号列很宽、内容列很窄"。
    layout: TableLayoutType.FIXED,
    width: { size: PAGE_TEXT_WIDTH, type: WidthType.DXA },
    columnWidths: widths,
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: '808080' },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: '808080' },
      left: { style: BorderStyle.SINGLE, size: 4, color: '808080' },
      right: { style: BorderStyle.SINGLE, size: 4, color: '808080' },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: 'B0B0B0' },
      insideVertical: { style: BorderStyle.SINGLE, size: 2, color: 'B0B0B0' }
    },
    rows: [header, ...body]
  });
}

function fmtDate(iso) {
  const d = iso ? new Date(iso) : new Date();
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

export async function exportAnalysisDocx(project, analysis, outPath) {
  const starItems = [];
  const fatalItems = [];
  for (const sec of analysis.sections) {
    for (const it of sec.items) {
      const row = {
        text: sec.type === 'table' ? (it.cells || []).filter(Boolean).join(' ｜ ') : (it.text || ''),
        secTitle: sec.title,
        isStar: it.isStar, isFatal: it.isFatal,
        page: it.page
      };
      if (sec.key === 'fatal') fatalItems.push(row);
      else if (it.isStar) starItems.push(row);
    }
  }

  const children = [];

  // 封面
  children.push(new Paragraph({ spacing: { before: 2400 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: '关键信息清单', font: FONT, size: 56, bold: true })] }));
  children.push(new Paragraph({ spacing: { before: 200 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: '（招标文件分析结果）', font: FONT, size: 28 })] }));
  children.push(new Paragraph({ spacing: { before: 1200 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: project.name || '', font: FONT, size: 36, bold: true })] }));
  children.push(new Paragraph({ spacing: { before: 300 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: '招标编号：' + (project.code || '—'), font: FONT, size: 24 })] }));
  children.push(new Paragraph({ spacing: { before: 120 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: '内部编号：' + (project.autoCode || '—'), font: FONT, size: 24 })] }));
  children.push(new Paragraph({ spacing: { before: 120 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: '招标人：' + (project.owner || '—'), font: FONT, size: 24 })] }));
  children.push(new Paragraph({ spacing: { before: 120 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: '投标截止：' + (project.bidDeadline || '—'), font: FONT, size: 24 })] }));
  children.push(new Paragraph({ spacing: { before: 900 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: '生成时间：' + fmtDate(analysis.analysisAt), font: FONT, size: 22, color: '666666' })] }));
  children.push(new Paragraph({ spacing: { before: 100 }, alignment: AlignmentType.CENTER, children: [new TextRun({ text: '分析文件：' + (analysis.fileName || '') + '（共 ' + (analysis.pageCount || '?') + ' 页）', font: FONT, size: 20, color: '888888' })] }));
  children.push(new Paragraph({ children: [new PageBreak()] }));

  // 红线汇总
  children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 200, after: 160 }, children: [new TextRun({ text: '一、红线汇总（先看这里）', font: FONT, size: 32, bold: true })] }));
  const totalItems = analysis.sections.reduce((n, s) => n + s.items.length, 0);
  children.push(new Paragraph({
    spacing: { after: 200 },
    children: [new TextRun({
      text: '星号（★）条款 ' + ((analysis.starCount != null) ? analysis.starCount : starItems.length) + ' 条 ｜ 废标/无效投标项 ' + fatalItems.length + ' 条 ｜ 全部条款 ' + totalItems + ' 条 ｜ 分析页数 ' + (analysis.analyzedPages || analysis.pageCount) + ' 页' + (analysis.truncated ? '（文件超过 200 页，仅分析前 200 页）' : ''),
      font: FONT, size: 21, color: '444444'
    })]
  }));

  if (fatalItems.length) {
    children.push(new Paragraph({ spacing: { before: 240, after: 100 }, children: [new TextRun({ text: '1. 废标 / 无效投标项', font: FONT, size: 26, bold: true, color: 'C00000' })] }));
    children.push(buildTable(['条款内容', '所属板块', '页码'], fatalItems.map((r) => ({ cells: [r.text, r.secTitle, r.page ? '第 ' + r.page + ' 页' : '待核'], isFatal: true }))));
  }

  if (starItems.length) {
    children.push(new Paragraph({ spacing: { before: 300, after: 100 }, children: [new TextRun({ text: '2. 星号（★）条款（' + starItems.length + ' 条，与上方废标项重复的不再列出）', font: FONT, size: 26, bold: true, color: 'BF8F00' })] }));
    children.push(buildTable(['条款内容', '所属板块', '页码'], starItems.map((r) => ({ cells: [r.text, r.secTitle, r.page ? '第 ' + r.page + ' 页' : '待核'], isStar: true }))));
  }

  children.push(new Paragraph({ children: [new PageBreak()] }));

  // 13 板块
  children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 200, after: 160 }, children: [new TextRun({ text: '二、分类清单', font: FONT, size: 32, bold: true })] }));

  const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三'];
  analysis.sections.forEach((sec, idx) => {
    children.push(new Paragraph({
      spacing: { before: 260, after: 120 },
      children: [new TextRun({ text: (idx + 1) + '. ' + sec.title + '（' + sec.items.length + ' 条）', font: FONT, size: 27, bold: true, color: sec.key === 'fatal' ? 'C00000' : '1F3864' })]
    }));
    if (!sec.items.length) {
      children.push(new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: '本文件未提及。', font: FONT, size: 21, color: '888888' })] }));
      return;
    }
    if (sec.type === 'table') {
      const cols = [...(sec.columns || ['内容']), '页码'];
      const rows = sec.items.map((it) => ({ cells: [...(it.cells || [it.text]), it.page ? '第 ' + it.page + ' 页' : '待核'], isStar: it.isStar, isFatal: it.isFatal }));
      children.push(buildTable(cols, rows));
    } else {
      const rows = sec.items.map((it) => ({ cells: [it.text, it.page ? '第 ' + it.page + ' 页' : '待核'], isStar: it.isStar, isFatal: it.isFatal }));
      children.push(buildTable(['条款内容', '页码'], rows));
    }
  });

  const doc = new Document({
    styles: {
      default: {
        document: { run: { font: FONT, size: 21 } }
      }
    },
    sections: [{
      properties: {
        page: {
          size: { width: 11906, height: 16838 },
          margin: { top: 1440, bottom: 1440, left: 1418, right: 1418 }
        }
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ children: ['第 ', PageNumber.CURRENT, ' 页'], font: FONT, size: 18, color: '777777' })]
          })]
        })
      },
      children
    }]
  });

  const buf = await Packer.toBuffer(doc);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buf);
  return outPath;
}