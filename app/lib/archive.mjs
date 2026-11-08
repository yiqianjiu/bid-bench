// 模块6：项目关闭与归档
import fs from 'node:fs';
import path from 'node:path';
import { ARCHIVE_DIR, PROJECT_DIR, DATA_DIR } from './config.mjs';
import { nowIso, safeName } from './util.mjs';
import { loadAnalysis } from './analyze.mjs';
import { loadDraft } from './draft.mjs';
import { loadCheck } from './check.mjs';
import { loadSubmit } from './submit.mjs';

function copyDir(src, dst) {
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dst, { recursive: true });
  let n = 0;
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) n += copyDir(s, d);
    else if (ent.isFile()) { fs.copyFileSync(s, d); n++; }
  }
  return n;
}

// 归档摘要：把项目的重要信息落成一份可长期查阅的 JSON
export function buildArchiveSummary(project, db) {
  const analysis = loadAnalysis(project.id);
  const draft = loadDraft(project.id);
  const check = loadCheck(project.id);
  const submit = loadSubmit(project.id);

  const sec = (k) => {
    if (!analysis || !Array.isArray(analysis.sections)) return [];
    const s = analysis.sections.find((x) => x.key === k);
    return s ? (s.items || []).map((it) => it.text || (it.cells || []).filter(Boolean).join(' ')) : [];
  };

  return {
    project: {
      name: project.name, code: project.code, autoCode: project.autoCode,
      owner: project.owner, agency: project.agency, budget: project.budget,
      bidDeadline: project.bidDeadline, openTime: project.openTime,
      openPlace: project.openPlace, deposit: project.deposit,
      purchaseMethod: project.purchaseMethod, notes: project.notes,
      createdAt: project.createdAt
    },
    analysis: analysis ? {
      pageCount: analysis.pageCount, starCount: analysis.starCount,
      fatalCount: analysis.fatalCount, analysisAt: analysis.analysisAt,
      counts: (analysis.sections || []).map((s) => ({ key: s.key, title: s.title, n: (s.items || []).length })),
      score: sec('score'),
      fatal: sec('fatal').slice(0, 60),
      qualify: sec('qualify'),
      key: {
        frontTable: sec('frontTable').slice(0, 40),
        business: sec('business').slice(0, 40),
        tech: sec('tech').slice(0, 40)
      }
    } : null,
    draft: draft ? {
      mode: draft.mode,
      docs: Object.keys(draft.docs || {}).map((k) => ({
        key: k,
        chapters: (draft.docs[k].chapters || []).length,
        written: (draft.docs[k].chapters || []).filter((c) => c.body || (c.rows || []).length).length,
        source: draft.docs[k].source || 'auto'
      }))
    } : null,
    check: check ? { verdict: check.verdict, fatal: check.fatal, warn: check.warn, checkAt: check.checkAt } : null,
    submit: submit ? { total: submit.items.length, done: submit.items.filter((x) => x.done).length } : null,
    archivedAt: nowIso()
  };
}

// 执行归档：复制五类产物到 归档/<年>/<编号_项目名>/
export function archiveProject(project, db, opt = {}) {
  const year = String(project.createdAt || nowIso()).slice(0, 4);
  const folder = safeName(`${project.code || project.autoCode || '未编号'}_${project.name || ''}`, project.id);
  const dst = path.join(ARCHIVE_DIR, year, folder);
  fs.mkdirSync(dst, { recursive: true });

  const src = path.join(PROJECT_DIR, project.dir || '');
  let files = 0;
  for (const sub of ['01招标文件', '02分析', '03制作', '04核查', '05递交']) {
    files += copyDir(path.join(src, sub), path.join(dst, sub));
  }

  const summary = buildArchiveSummary(project, db);
  fs.writeFileSync(path.join(dst, '项目摘要.json'), JSON.stringify(summary, null, 2), 'utf8');
  files++;

  // 分析结果与制作稿单独留一份 JSON，方便以后复用
  const analysis = loadAnalysis(project.id);
  if (analysis) { fs.writeFileSync(path.join(dst, '02分析', '分析结果.json'), JSON.stringify(analysis, null, 2), 'utf8'); files++; }
  const draft = loadDraft(project.id);
  if (draft) { fs.writeFileSync(path.join(dst, '03制作', '制作稿.json'), JSON.stringify(draft, null, 2), 'utf8'); files++; }

  const note = opt.note || '';
  fs.writeFileSync(path.join(dst, '归档说明.txt'), [
    '项目名称：' + (project.name || ''),
    '招标编号：' + (project.code || ''),
    '内部编号：' + (project.autoCode || ''),
    '招标人：' + (project.owner || ''),
    '预算：' + (project.budget || ''),
    '投标截止：' + (project.bidDeadline || ''),
    '归档时间：' + nowIso(),
    '',
    note ? '关闭说明：' + note : '',
    '',
    '本文件夹由「投标业务工作台」自动归档，包含招标文件、分析结果、投标文件、核查报告、递交清单。'
  ].join('\r\n'), 'utf8');
  files++;

  return { dir: dst, relDir: path.relative(ARCHIVE_DIR, dst), files, summary };
}

export function listArchives() {
  const out = [];
  if (!fs.existsSync(ARCHIVE_DIR)) return out;
  for (const y of fs.readdirSync(ARCHIVE_DIR)) {
    const yd = path.join(ARCHIVE_DIR, y);
    if (!fs.statSync(yd).isDirectory()) continue;
    for (const f of fs.readdirSync(yd)) {
      const fd = path.join(yd, f);
      if (!fs.statSync(fd).isDirectory()) continue;
      let summary = null;
      try { summary = JSON.parse(fs.readFileSync(path.join(fd, '项目摘要.json'), 'utf8')); } catch {}
      out.push({
        year: y,
        folder: f,
        path: fd,
        name: summary && summary.project ? summary.project.name : f,
        code: summary && summary.project ? summary.project.code : '',
        owner: summary && summary.project ? summary.project.owner : '',
        budget: summary && summary.project ? summary.project.budget : '',
        bidDeadline: summary && summary.project ? summary.project.bidDeadline : '',
        archivedAt: summary ? summary.archivedAt : '',
        check: summary ? summary.check : null
      });
    }
  }
  return out.sort((a, b) => String(b.archivedAt).localeCompare(String(a.archivedAt)));
}
