// 模块6：项目关闭与归档
import fs from 'node:fs';
import path from 'node:path';
import { ARCHIVE_DIR, PROJECT_DIR, DATA_DIR } from './config.mjs';
import { nowIso, safeName } from './util.mjs';
import { loadAnalysis } from './analyze.mjs';
import { loadDraft } from './draft.mjs';
import { loadCheck } from './check.mjs';
import { loadSubmit } from './submit.mjs';
import { loadProfiles } from './profile.mjs';
import { saveProjectKnowledge, keywordsOf } from './knowledge.mjs';

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


// v1.1.0：归档时把本项目的重要技术/商务内容沉淀进本地知识库
export function buildKnowledgePayload(project, db) {
  const draft = loadDraft(project.id);
  const profiles = loadProfiles(project.id);
  const payload = { profiles: {}, chapters: { tech: [], biz: [] }, history: [], keywords: [] };
  ['tech', 'biz'].forEach((k) => { if (profiles[k]) payload.profiles[k] = profiles[k]; });
  if (draft) {
    // 以「当前正在用的那套章节」为准：上传过 Word 就是上传定稿，否则是自动框架
    const mode = draft.mode === 'split' ? 'biz' : 'merged';
    const doc = (draft.docs || {})[mode] || (draft.docs || {}).merged || (draft.docs || {}).biz;
    if (doc) {
      const chs = (doc.chapters || []).filter((c) => c && (c.role === 'tech' || c.role === 'biz'));
      chs.forEach((c) => {
        const body = String(c.body || '').trim();
        if (!body) return;
        payload.chapters[c.role].push({
          title: c.title, role: c.role, number: c.number || '', level: c.level || 1,
          body: body.length > 20000 ? body.slice(0, 20000) : body,
          source: c.source || '', updatedAt: c.updatedAt || ''
        });
      });
      // 生成历史：记下哪一章 AI 写过、写了几次、最终是否保留
      const log = Array.isArray(doc.genLog) ? doc.genLog : [];
      const byChapter = {};
      log.forEach((x) => { const k = x.chapterId || x.title; byChapter[k] = byChapter[k] || { title: x.title, role: x.role, times: 0, chars: 0 }; byChapter[k].times++; byChapter[k].chars = x.chars || byChapter[k].chars; });
      const cur = {};
      (doc.chapters || []).forEach((c) => { cur[c.id] = c; });
      payload.history = Object.keys(byChapter).map((k) => ({
        chapterId: k, title: byChapter[k].title, role: byChapter[k].role,
        aiTimes: byChapter[k].times, chars: byChapter[k].chars,
        kept: !!(cur[k] && String(cur[k].body || '').trim())
      }));
    }
  }
  payload.keywords = keywordsOf(project, profiles);
  return payload;
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

  // v1.1.0：把本次投标的重要技术/商务内容沉淀进本地专家知识库（失败不影响归档）
  let knowledge = null;
  try {
    const payload = buildKnowledgePayload(project, db);
    knowledge = saveProjectKnowledge(project, payload);
    files += 1;
  } catch (e) {
    knowledge = { error: String(e && e.message || e) };
  }

  return { dir: dst, relDir: path.relative(ARCHIVE_DIR, dst), files, summary, knowledge };
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
