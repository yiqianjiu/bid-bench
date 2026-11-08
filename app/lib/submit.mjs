// 模块5：递交环节行动清单
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';
import { uid, nowIso } from './util.mjs';

export const SUBMIT_DIR = path.join(DATA_DIR, '递交');

export function ensureSubmitDirs() {
  fs.mkdirSync(SUBMIT_DIR, { recursive: true });
}

export function loadSubmit(pid) {
  const f = path.join(SUBMIT_DIR, pid + '.json');
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

export function saveSubmit(pid, s) {
  ensureSubmitDirs();
  fs.writeFileSync(path.join(SUBMIT_DIR, pid + '.json'), JSON.stringify(s, null, 2), 'utf8');
  return s;
}

// 五个阶段，与需求 2.5 一致
export const GROUPS = [
  { key: 'prep', title: '一、印刷准备', hint: '先把要求汇总成单页，随身带着' },
  { key: 'origin', title: '二、正本印刷', hint: '正本只有一份（或按招标文件份数），务必手工核对' },
  { key: 'copy', title: '三、副本印刷', hint: '用扫描件印副本，保证与正本完全一致' },
  { key: 'bind', title: '四、胶装与密封', hint: '硬纸封面、胶装、盖章、密封' },
  { key: 'digital', title: '五、电子版与递交', hint: 'U 盘/光盘、线上平台上传' }
];

function item(title, detail, opt = {}) {
  return {
    id: uid('s_'),
    title,
    detail: detail || '',
    group: opt.group || 'prep',
    done: false,
    auto: !!opt.auto,
    page: opt.page || null,
    source: opt.source || ''
  };
}

function pick(analysis, keys, re) {
  if (!analysis || !Array.isArray(analysis.sections)) return [];
  const out = [];
  for (const k of keys) {
    const sec = analysis.sections.find((x) => x.key === k);
    if (!sec) continue;
    for (const it of sec.items || []) {
      const text = it.text || (it.cells || []).filter(Boolean).join(' ');
      if (!text) continue;
      if (re && !re.test(text)) continue;
      out.push({ text, page: it.page, isStar: !!it.isStar });
    }
  }
  return out;
}

// 从招标分析结果里自动生成清单
export function buildChecklist(project, analysis) {
  const list = [];

  // ---- 一、印刷准备 ----
  list.push(item(
    '把印刷、签字盖章、密封要求单独整理成一页备用文件',
    '从招标文件里把所有格式要求汇总成一页 A4，打印出来放在手边，每完成一项打勾。',
    { group: 'prep', auto: false }
  ));

  const printReqs = pick(analysis, ['print'], null).slice(0, 12);
  for (const r of printReqs) {
    list.push(item(r.text, '来自招标文件原文' + (r.page ? `第 ${r.page} 页` : ''), { group: 'prep', auto: true, page: r.page, source: 'print' }));
  }

  const formatReqs = pick(analysis, ['format'], /纸|字体|字号|行距|页边距|装订|颜色|黑白|胶装|骑马钉/).slice(0, 10);
  for (const r of formatReqs) {
    list.push(item(r.text, '版面格式要求' + (r.page ? `，第 ${r.page} 页` : ''), { group: 'prep', auto: true, page: r.page, source: 'format' }));
  }

  // ---- 二、正本印刷 ----
  const copies = pick(analysis, ['frontTable'], /正本|副本|份数/).slice(0, 4);
  for (const c of copies) {
    list.push(item(c.text, '份数以招标文件前附表为准' + (c.page ? `，第 ${c.page} 页` : ''), { group: 'origin', auto: true, page: c.page, source: 'frontTable' }));
  }
  list.push(item('按招标文件要求的份数打印「正本」', '正本一般只有一份，必须用最终定稿的 Word 打印，不要用副本再复制。', { group: 'origin' }));
  list.push(item('封面除外的每一页都检查一遍', '重点看：有没有空白页、页码是否连续、表格有没有跨页断行、图片是否清晰。', { group: 'origin' }));
  list.push(item('看法人签字页：是本人签，还是可以盖法人章', '招标文件若要求「法定代表人签字」，必须本人手签；只有写「签字或盖章」时才能用法人章。', { group: 'origin' }));
  list.push(item('所有需要签字的地方都签完', '常见位置：投标函、法定代表人身份证明、授权委托书、各类声明函、偏离表、报价表。', { group: 'origin' }));
  list.push(item('所有需要盖章的地方都盖完（含骑缝章）', '公章、法人章、骑缝章要区分清楚；多页文件建议盖骑缝章防止抽换。', { group: 'origin' }));

  const signReqs = pick(analysis, ['sign'], null).slice(0, 10);
  for (const r of signReqs) {
    list.push(item(r.text, '签字盖章要求' + (r.page ? `，第 ${r.page} 页` : ''), { group: 'origin', auto: true, page: r.page, source: 'sign' }));
  }

  // ---- 三、副本印刷 ----
  list.push(item('把正本整本扫描成 PDF', '用扫描仪或手机扫描 App，300dpi，确保每一页都清楚、没有阴影和歪斜。', { group: 'copy' }));
  list.push(item('按招标文件要求的份数打印副本', '副本内容必须与正本完全一致，印完抽查第一页和最后一页。', { group: 'copy' }));
  list.push(item('在每本封面标注「正本」或「副本」', '标注位置和格式按招标文件要求来，一般写在封面右上角或项目名称下方。', { group: 'copy' }));

  // ---- 四、胶装与密封 ----
  list.push(item('加硬纸封面后胶装', '不要用订书机、不要用抽杆夹；胶装要平整，不能有掉页。', { group: 'bind' }));
  list.push(item('封面盖章', '按招标文件要求盖公章，有的还要求法定代表人签字。', { group: 'bind' }));
  list.push(item('按要求密封并加盖骑缝章', '密封袋/密封条上写项目名称、编号、投标人名称，封口处盖公章或骑缝章。', { group: 'bind' }));
  list.push(item('单独制作一个密封封面', '写上「项目名称 / 招标编号 / 投标人名称 / 在 XXXX 年 XX 月 XX 日 XX:XX 前不得启封」。', { group: 'bind' }));

  const sealReqs = pick(analysis, ['print', 'onsite'], /密封|封套|封口|骑缝|外包装/).slice(0, 8);
  for (const r of sealReqs) {
    list.push(item(r.text, '密封要求' + (r.page ? `，第 ${r.page} 页` : ''), { group: 'bind', auto: true, page: r.page, source: 'print' }));
  }

  // ---- 五、电子版与递交 ----
  list.push(item('删除 Word 文件里的个人信息', 'Word → 文件 → 信息 → 检查文档 → 检查个人信息，然后保存。', { group: 'digital' }));
  list.push(item('把电子版复制到 U 盘 / 光盘', 'U 盘要先格式化，只放这次投标的文件；光盘要能正常读取。', { group: 'digital' }));
  list.push(item('制作光盘/U 盘封面并密封盖章', '封面写项目名称、编号、投标人；装袋密封后封口盖章。', { group: 'digital' }));

  const onsite = pick(analysis, ['onsite'], null).slice(0, 10);
  for (const r of onsite) {
    list.push(item(r.text, '现场投递注意事项' + (r.page ? `，第 ${r.page} 页` : ''), { group: 'digital', auto: true, page: r.page, source: 'onsite' }));
  }

  list.push(item('授权代表随身携带的材料', '身份证原件、授权委托书原件、法定代表人身份证明、营业执照复印件（盖章）、投标保证金凭证。', { group: 'digital' }));
  list.push(item(
    project.bidDeadline ? `提前到达开标地点（投标截止：${String(project.bidDeadline).replace('T', ' ')}）` : '提前到达开标地点',
    project.openPlace ? `开标地点：${project.openPlace}` : '建议提前 1 小时到达，留出安检、找会议室的时间。',
    { group: 'digital' }
  ));
  list.push(item('递交后索取回执或拍照留证', '记录递交时间、接收人，必要时拍照留存。', { group: 'digital' }));

  return list;
}

export function ensureSubmit(project, analysis) {
  let s = loadSubmit(project.id);
  if (s && Array.isArray(s.items) && s.items.length) return s;
  s = {
    projectId: project.id,
    items: buildChecklist(project, analysis),
    builtAt: nowIso(),
    updatedAt: nowIso()
  };
  saveSubmit(project.id, s);
  return s;
}

export function rebuildSubmit(project, analysis) {
  const old = loadSubmit(project.id);
  const doneKeys = new Set(((old && old.items) || []).filter((x) => x.done).map((x) => x.title));
  const s = {
    projectId: project.id,
    items: buildChecklist(project, analysis).map((x) => ({ ...x, done: doneKeys.has(x.title) })),
    builtAt: nowIso(),
    updatedAt: nowIso()
  };
  saveSubmit(project.id, s);
  return s;
}
