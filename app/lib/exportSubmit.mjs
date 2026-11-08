// 模块5：递交行动清单导出 docx
import fs from 'node:fs';
import path from 'node:path';
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType, Footer, PageNumber
} from 'docx';
import { GROUPS } from './submit.mjs';

const FONT = '宋体';
const HEI = '黑体';

function p(text, o = {}) {
  return new Paragraph({
    alignment: o.center ? AlignmentType.CENTER : AlignmentType.LEFT,
    spacing: { before: o.before == null ? 60 : o.before, after: o.after == null ? 60 : o.after, line: o.line || 330 },
    indent: o.indent ? { firstLine: 480 } : undefined,
    children: [new TextRun({ text: String(text == null ? '' : text), font: o.font || FONT, size: o.size || 21, bold: !!o.bold, color: o.color || '000000' })]
  });
}

function h(text, level) {
  return new Paragraph({
    heading: level === 1 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2,
    spacing: { before: 260, after: 120 },
    children: [new TextRun({ text, font: HEI, size: level === 1 ? 30 : 26, bold: true, color: '000000' })]
  });
}

export function exportSubmitDocx(project, submit, outPath) {
  const blocks = [];
  blocks.push(p('投标文件递交行动清单', { center: true, size: 40, bold: true, font: HEI, before: 0, after: 200 }));
  blocks.push(p(project.name || '', { center: true, size: 28, bold: true, after: 80 }));
  blocks.push(p(`招标编号：${project.code || '—'}　招标人：${project.owner || '—'}`, { center: true, size: 21, after: 40 }));
  if (project.bidDeadline) {
    blocks.push(p(`投标截止：${String(project.bidDeadline).replace('T', ' ')}`, { center: true, size: 24, bold: true, color: 'C00000', after: 40 }));
  }
  if (project.openPlace) blocks.push(p(`开标地点：${project.openPlace}`, { center: true, size: 21, after: 120 }));

  blocks.push(p('使用方法：打印这份清单，每完成一项就在前面的方框里打勾。带「来自招标文件」的条目是工作台从招标文件中自动提取的，请以纸质招标文件原文为准。', { size: 20, color: '555555', after: 200 }));

  for (const g of GROUPS) {
    const list = submit.items.filter((x) => x.group === g.key);
    if (!list.length) continue;
    blocks.push(h(g.title, 1));
    if (g.hint) blocks.push(p(g.hint, { size: 20, color: '555555', after: 120 }));
    list.forEach((x, i) => {
      const mark = x.done ? '■' : '□';
      blocks.push(new Paragraph({
        spacing: { before: 100, after: x.detail ? 20 : 60, line: 330 },
        children: [
          new TextRun({ text: mark + ' ', font: FONT, size: 22, bold: true }),
          new TextRun({ text: `${i + 1}. ${x.title}`, font: FONT, size: 21, bold: true }),
          ...(x.auto ? [new TextRun({ text: '　[招标文件]', font: FONT, size: 17, color: '888888' })] : [])
        ]
      }));
      if (x.detail) {
        blocks.push(new Paragraph({
          spacing: { before: 0, after: 80, line: 320 },
          indent: { left: 480 },
          children: [new TextRun({ text: x.detail, font: FONT, size: 19, color: '666666' })]
        }));
      }
    });
  }

  blocks.push(h('最后确认（出发前逐条核对）', 1));
  const last = [
    '正本、副本份数够不够？封面「正本/副本」标注有没有？',
    '所有签字处都签了吗？法人签字页是按招标文件要求的方式签的吗？',
    '所有盖章处都盖了吗？骑缝章盖了吗？',
    '密封袋封口盖章了吗？密封封面写全项目名称、编号、投标人了吗？',
    '授权代表身份证、授权委托书原件带了吗？',
    'U 盘/光盘带着了吗？里面的文件能打开吗？',
    '投标保证金凭证带了吗？'
  ];
  last.forEach((t) => blocks.push(p('□ ' + t, { size: 21, indent: true, after: 80 })));

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
