/* 投标业务工作台 - 前端 */
const S = {
  health: null,
  settings: null,
  projects: [],
  cur: null,      // 当前项目详情
  tab: 'info',
  busy: '',
  archived: false
};

const TABS = [
  { key: 'info', name: '项目信息' },
  { key: 'tender', name: '招标文件' },
  { key: 'analysis', name: '招标分析' },
  { key: 'draft', name: '投标文件' },
  { key: 'check', name: '文件核查' },
  { key: 'submit', name: '递交归档' }
];

/* ---------- 小工具 ---------- */
const $ = (s, root) => (root || document).querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast on' + (isErr ? ' err' : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.className = 'toast'; }, isErr ? 6000 : 2800);
}

async function api(method, url, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const r = await fetch(url, opt);
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!r.ok) throw new Error((data && data.error) || ('请求失败 ' + r.status));
  return data;
}

function upload(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let d = null;
      try { d = JSON.parse(xhr.responseText); } catch { d = { error: xhr.responseText }; }
      if (xhr.status >= 200 && xhr.status < 300) resolve(d);
      else reject(new Error((d && d.error) || ('上传失败 ' + xhr.status)));
    };
    xhr.onerror = () => reject(new Error('上传中断，请重试'));
    const fd = new FormData();
    fd.append('file', file, file.name);
    xhr.send(fd);
  });
}

function fmtSize(n) {
  if (!n) return '0';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function parseTime(s) {
  if (!s) return null;
  const t = Date.parse(String(s).replace(' ', 'T').replace(/年|月/g, '-').replace(/日/g, ''));
  return Number.isNaN(t) ? null : t;
}

function fmtLeft(deadline) {
  const t = parseTime(deadline);
  if (t == null) return { cls: 'c-gray', big: '未设置', sub: '截止时间' };
  const diff = t - Date.now();
  const days = Math.floor(diff / 86400000);
  const hours = Math.floor((diff % 86400000) / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  if (diff <= 0) return { cls: 'c-done', big: '已过截止时间', sub: deadline };
  let cls = 'c-gray';
  if (days <= 1) cls = 'c-red';
  else if (days <= 7) cls = 'c-amber';
  const big = days > 0 ? '剩 ' + days + ' 天' : '剩 ' + hours + ' 小时';
  const sub = days > 0 ? '还有 ' + days + ' 天 ' + hours + ' 小时' : hours + ' 小时 ' + mins + ' 分';
  let extra = '';
  if (days <= 7 && days >= 0) extra = 'z';
  return { cls, big, sub: sub + ' · 截止 ' + deadline, urgent: days <= 7 };
}

/* ---------- 侧边栏 ---------- */
function renderSidebar() {
  const list = $('#projectList');
  const rows = S.projects.filter((p) => (S.archived ? p.status === 'archived' : p.status !== 'archived'));
  if (!rows.length) {
    list.innerHTML = '<div class="muted" style="padding:10px;font-size:13px">' + (S.archived ? '还没有归档的项目' : '还没有项目，点上面「新建项目」开始') + '</div>';
    return;
  }
  list.innerHTML = rows.map((p) => {
    const left = fmtLeft(p.bidDeadline);
    const dotCls = left.cls === 'c-red' ? '#d1242f' : left.cls === 'c-amber' ? '#bf8700' : left.cls === 'c-done' ? '#8a9099' : '#1a7f37';
    return '<div class="pitem' + (S.cur && S.cur.id === p.id ? ' active' : '') + '" data-id="' + p.id + '">' +
      '<div class="pn" title="' + esc(p.name) + '">' + esc(p.name) + '</div>' +
      '<div class="pm"><span>' + esc(p.code || p.autoCode || '') + '</span>' +
      '<span><span class="dot" style="background:' + dotCls + '"></span>' +
      (left.cls === 'c-done' ? '已截止' : left.big === '未设置' ? '无截止' : left.big.replace('剩 ', '')) + '</span></div>' +
      '</div>';
  }).join('');
  list.querySelectorAll('.pitem').forEach((el) => {
    el.onclick = () => openProject(el.dataset.id);
  });
}

async function refreshProjects() {
  const d = await api('GET', '/api/projects' + (S.archived ? '?archived=1' : ''));
  S.projects = d.projects || [];
  renderSidebar();
}

/* ---------- 项目详情 ---------- */
function syncHash() {
  const h = S.cur ? '#/p/' + encodeURIComponent(S.cur.id) + '/' + S.tab : '#/';
  if (location.hash !== h) history.replaceState(null, '', h);
}

async function openProject(id, keepTab) {
  S.cur = null;
  if (!keepTab) S.tab = 'info';
  $('#main').innerHTML = '<div class="page"><div class="placeholder">正在打开项目…</div></div>';
  try {
    const d = await api('GET', '/api/projects/' + id);
    S.cur = d;
    renderProject();
    renderSidebar();
    syncHash();
  } catch (e) {
    $('#main').innerHTML = '<div class="page"><div class="placeholder">打不开这个项目：' + esc(e.message) + '</div></div>';
  }
}

function renderProject() {
  const p = S.cur;
  const left = fmtLeft(p.bidDeadline);
  const tenderFiles = p.files.filter((f) => f.stage === 'tender');
  const tabs = TABS.map((t) => {
    let badge = '';
    if (t.key === 'tender' && tenderFiles.length) badge = '<span class="badge">' + tenderFiles.length + '</span>';
    return '<div class="tab' + (S.tab === t.key ? ' active' : '') + '" data-tab="' + t.key + '">' + t.name + badge + '</div>';
  }).join('');

  const head =
    '<div class="page-head">' +
      '<div>' +
        '<div class="page-title">' + esc(p.name) + '</div>' +
        '<div class="page-sub">' +
          (p.code ? '招标编号 ' + esc(p.code) + ' · ' : '') +
          (p.autoCode ? '内部编号 ' + esc(p.autoCode) : '') +
          (p.status === 'archived' ? ' · <span class="tag">已归档</span>' : '') +
        '</div>' +
      '</div>' +
      '<div class="clock ' + left.cls + '"><div class="dl">' + (left.urgent ? '⚠ 临近截止' : '距投标截止') + '</div>' +
        '<div class="big">' + esc(left.big) + '</div><div class="dl">' + esc(left.sub) + '</div></div>' +
    '</div>';

  const body = S.tab === 'info' ? viewInfo()
    : S.tab === 'tender' ? viewTender()
    : S.tab === 'analysis' ? viewAnalysis()
    : S.tab === 'draft' ? viewDraft()
    : S.tab === 'check' ? viewCheck()
    : S.tab === 'submit' ? viewSubmit()
    : viewSoon();

  $('#main').innerHTML = '<div class="page">' + head + '<div class="tabs">' + tabs + '</div><div id="tabBody">' + body + '</div></div>';

  $('#main').querySelectorAll('.tab').forEach((el) => {
    el.onclick = () => { S.tab = el.dataset.tab; renderProject(); syncHash(); };
  });
  bindTabEvents();
}

function viewSoon() {
  return '<div class="placeholder">这个模块还在做。先把「项目信息」和「招标文件」用好，后面几块会陆续开放。</div>';
}

/* ---------- 页签：项目信息 ---------- */
const FIELD_DEFS = [
  ['name', '项目名称', 'text', 'full'],
  ['code', '招标编号', 'text'],
  ['autoCode', '内部编号', 'readonly'],
  ['owner', '招标单位（采购人）', 'text'],
  ['agency', '代理机构', 'text'],
  ['budget', '预算金额', 'text'],
  ['purchaseMethod', '采购方式', 'text'],
  ['packageNo', '包号', 'text'],
  ['bidDeadline', '投标截止时间', 'datetime'],
  ['openTime', '开标时间', 'datetime'],
  ['openPlace', '开标地点', 'text', 'full'],
  ['deposit', '投标保证金', 'text', 'full'],
  ['company', '需要的资质（概括）', 'text', 'full'],
  ['notes', '提醒 / 备注', 'textarea', 'full']
];

function viewInfo() {
  const p = S.cur;
  const fields = FIELD_DEFS.map(([k, label, type, full]) => {
    if (type === 'readonly') {
      return '<div class="field"><label>' + label + '</label><input value="' + esc(p[k] || '') + '" readonly></div>';
    }
    const hint = type === 'datetime' ? '<div class="hint">格式：2026-12-31 09:30</div>' : '';
    const input = type === 'textarea'
      ? '<textarea rows="3" data-k="' + k + '" placeholder="可留空">' + esc(p[k] || '') + '</textarea>'
      : '<input data-k="' + k + '" value="' + esc(p[k] || '') + '" placeholder="' + (type === 'datetime' ? '2026-12-31 09:30' : '可留空') + '">';
    return '<div class="field' + (full === 'full' ? ' full' : '') + '"><label>' + label + '</label>' + input + hint + '</div>';
  }).join('');

  const events = (S.cur.events || []).slice(0, 12).map((e) =>
    '<tr><td style="width:150px;color:#8a9099">' + esc(new Date(e.createdAt).toLocaleString('zh-CN')) + '</td><td>' + esc(e.message) + '</td></tr>'
  ).join('');

  return '<div class="card"><h3>项目基本信息</h3><div class="grid">' + fields + '</div>' +
    '<div class="row" style="margin-top:16px"><button class="btn primary" id="btnSaveInfo">保存修改</button>' +
    '<span class="muted" style="font-size:13px">信息可以随时改。资料不全没关系，先把知道的填上。</span></div></div>' +
    '<div class="card"><h3>最近操作</h3>' +
    (events ? '<table class="list">' + events + '</table>' : '<div class="muted">还没有操作记录</div>') + '</div>' +
    '<div class="card"><h3>危险操作</h3><div class="row"><button class="btn danger" id="btnDelete">删除这个项目</button>' +
    '<span class="muted" style="font-size:13px">会把 D 盘里这个项目的文件夹一并删掉，删了找不回来。</span></div></div>';
}

/* ---------- 页签：招标文件 ---------- */
function viewTender() {
  const files = S.cur.files.filter((f) => f.stage === 'tender');
  const rows = files.map((f) => {
    const ext = (f.originalName.split('.').pop() || '').toLowerCase();
    const kindTag = ext === 'pdf' ? '<span class="tag red">PDF</span>'
      : ext === 'docx' || ext === 'doc' ? '<span class="tag blue">Word</span>'
      : ext === 'zip' || ext === 'rar' ? '<span class="tag">压缩包</span>' : '<span class="tag">' + esc(ext) + '</span>';
    const status = f.extracted ? '<span class="tag green">已读取 ' + (f.pages || '?') + ' 页</span>'
      : '<span class="tag">未读取</span>';
    return '<tr><td>' + kindTag + '</td>' +
      '<td>' + esc(f.originalName) + (f.role === 'fromArchive' ? '<div class="hint muted" style="font-size:12px">来自压缩包</div>' : '') + '</td>' +
      '<td style="width:90px">' + fmtSize(f.size) + '</td>' +
      '<td style="width:130px">' + status + '</td>' +
      '<td style="width:200px;text-align:right">' +
        '<button class="btn" data-act="read" data-id="' + f.id + '" style="padding:5px 10px;font-size:13px">看内容</button> ' +
        '<button class="btn danger" data-act="del" data-id="' + f.id + '" style="padding:5px 10px;font-size:13px">删除</button>' +
      '</td></tr>';
  }).join('');

  return '<div class="card"><h3>上传招标文件</h3>' +
    '<div class="drop" id="drop">把 PDF / Word / 压缩包拖到这里，或点这里选择文件' +
      '<div class="hint muted" style="margin-top:8px;font-size:13px">支持 .pdf .docx .doc .zip .rar，单个文件最大 200MB</div>' +
      '<input type="file" id="fileInput" multiple accept=".pdf,.docx,.doc,.zip,.rar" style="display:none">' +
    '</div>' +
    '<div id="upProgress" class="muted" style="margin-top:10px;font-size:13px"></div>' +
    '</div>' +
    '<div class="card"><h3>已上传的招标文件</h3>' +
    (rows ? '<table class="list"><thead><tr><th>类型</th><th>文件名</th><th>大小</th><th>读取状态</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>'
      : '<div class="muted">还没有上传文件。</div>') +
    '</div>' +
    '<div class="card"><h3>用 AI 自动填项目信息</h3>' +
    '<p class="muted" style="margin-top:0;font-size:13px">让 AI 读一遍招标文件，把项目名称、编号、招标单位、预算、截止时间、开标信息、保证金等自动找出来。' +
    '找出来的内容会先给你看一遍，你确认了才写进项目。</p>' +
    '<button class="btn primary" id="btnExtract"' + (files.length ? '' : ' disabled') + '>开始自动识别</button>' +
    '<span id="extractMsg" class="muted" style="margin-left:12px;font-size:13px"></span>' +
    '</div>';
}


/* ================= 页签：招标分析 ================= */
S.an = null; // {projectId, data, loading, section, redOnly, running, task}

function anLoading() {
  return '<div class="placeholder"><span class="loading"></span> 正在读取分析结果…</div>';
}

async function loadAnalysisFor(pid) {
  const keepSec = S.an && S.an.projectId === pid ? S.an.section : 'format';
  const keepRed = S.an && S.an.projectId === pid ? S.an.redOnly : false;
  S.an = { projectId: pid, loading: true, section: keepSec, redOnly: keepRed };
  let d;
  try {
    d = await api('GET', '/api/projects/' + pid + '/analysis');
  } catch (e) {
    S.an = { projectId: pid, loading: false, error: e.message, section: keepSec, redOnly: keepRed };
    if (S.cur && S.cur.id === pid && S.tab === 'analysis') renderProject();
    return;
  }
  S.an = { projectId: pid, data: d, loading: false, section: keepSec, redOnly: keepRed, running: d.running || null, task: null };
  if (d.running && d.running.taskId) startAnalysisPolling(d.running.taskId);
  if (S.cur && S.cur.id === pid && S.tab === 'analysis') renderProject();
}

function stopAnalysisPolling() {
  if (S.an && S.an.timer) { clearInterval(S.an.timer); S.an.timer = null; }
}

function startAnalysisPolling(taskId) {
  if (S.an.timer) clearInterval(S.an.timer);
  S.an.taskId = taskId;
  S.an.timer = setInterval(async () => {
    let t;
    try { t = await api('GET', '/api/tasks/' + taskId); } catch { return; }
    if (!S.an || S.an.taskId !== taskId) { clearInterval(S.an.timer); return; }
    S.an.task = t;
    S.an.running = t.state === 'running' ? t : null;
    const box = $('#anProgress');
    if (box) box.innerHTML = progressHtml(t);
    if (t.state !== 'running') {
      clearInterval(S.an.timer);
      S.an.timer = null;
      if (t.state === 'failed') toast('分析失败：' + (t.error || ''), true);
      const pid = S.an.projectId;
      S.an = null;
      await loadAnalysisFor(pid);
    }
  }, 2000);
}

function progressHtml(t) {
  if (!t) return '';
  const pct = t.total ? Math.round((t.step / t.total) * 100) : 0;
  const running = t.state === 'running';
  return '<div class="an-progress">' +
    '<div class="row" style="justify-content:space-between;margin-bottom:6px">' +
      '<b>' + (running ? 'AI 正在分析招标文件' : t.state === 'done' ? '分析完成' : t.state === 'partial' ? '分析完成（有段落需重跑）' : '分析失败') + '</b>' +
      '<span class="muted" style="font-size:13px">' + esc(t.message || '') + '</span>' +
    '</div>' +
    '<div class="bar"><div class="bar-in" style="width:' + pct + '%"></div></div>' +
    (t.state === 'failed' && t.error ? '<div class="muted" style="font-size:13px;margin-top:8px;color:#b6242e">' + esc(t.error) + '</div>' : '') +
    '</div>';
}

function viewAnalysis() {
  const cur = S.cur;
  const an = S.an && S.an.projectId === cur.id ? S.an : null;
  if (!an) { loadAnalysisFor(cur.id); return anLoading(); }
  if (an.loading) return anLoading();
  if (an.error) return '<div class="placeholder">读取分析结果失败：' + esc(an.error) + '</div>';

  const d = an.data || {};
  const hasData = d.sections && d.sections.length;
  const tenderFiles = cur.files.filter((f) => f.stage === 'tender');

  if (!hasData) {
    if (an.running) {
      return '<div class="card"><h3>正在分析…</h3><div id="anProgress">' + progressHtml(an.task || an.running) + '</div>' +
        '<p class="muted" style="font-size:13px;margin-top:14px">第一次分析一份几十页的文件大约 3～5 分钟，请让这个页面开着，不要关。</p></div>';
    }
    if (!tenderFiles.length) {
      return '<div class="card"><h3>还没有招标文件</h3>' +
        '<p class="muted" style="font-size:13px;margin-top:0">请先到「招标文件」页签，把招标文件（PDF / Word / 压缩包）上传上来，再回来点「开始分析」。</p>' +
        '<button class="btn primary" id="btnGoTender">去上传招标文件</button></div>';
    }
    if (!S.health || !S.health.hasKey) {
      return '<div class="card"><h3>还没配置 AI</h3>' +
        '<p class="muted" style="font-size:13px;margin-top:0">分析招标文件需要用 DeepSeek。请点左下角「设置」，填入 API Key 后再回来。</p>' +
        '<button class="btn primary" id="btnGoSettings">去设置</button></div>';
    }
    return '<div class="card"><h3>开始分析招标文件</h3>' +
      '<p class="muted" style="font-size:13px;margin-top:0;max-width:640px">AI 会把招标文件从头读一遍，整理出 13 类关键信息：版面格式、印刷密封、现场投递、签字盖章、废标项、前附表、资格审查、符合性审查、评分表、商务条款、技术条款、交付成果、其他注意事项。' +
      '每一条都会标出原文页码，可以点「看原文」对照。</p>' +
      '<div class="row"><button class="btn primary" id="btnStartAnalysis">开始分析</button>' +
      '<span class="muted" style="font-size:13px">' + esc(tenderFiles[0].originalName) + '，约 3～5 分钟</span></div></div>';
  }

  // 有数据
  const stat = d.stat || {};
  const total = Object.values(stat).reduce((a, b) => a + b, 0);
  const sec = d.sections.find((s) => s.key === an.section) || d.sections[0];

  const groups = [{ name: '通用要求', items: d.sections.filter((s) => s.group === '通用要求') },
                  { name: '编制要求', items: d.sections.filter((s) => s.group === '编制要求') }];

  const nav = groups.map((g) =>
    '<div class="an-group">' + g.name + '</div>' +
    g.items.map((s) => {
      const star = s.items.filter((i) => i.isStar).length;
      const fatal = s.items.filter((i) => i.isFatal).length;
      // 红点只在"这一栏确实有一批红线"时出现，零星一两条不足以挂红点，否则左栏满屏是红的反而看不出重点
      const dot = fatal >= 3 ? '<span class="an-dot red"></span>' : (fatal > 0 || star > 0) ? '<span class="an-dot amber"></span>' : '';
      return '<div class="an-nav' + (s.key === sec.key ? ' active' : '') + '" data-sec="' + s.key + '">' +
        '<span>' + esc(s.title) + '</span><span class="an-cnt">' + s.items.length + dot + '</span></div>';
    }).join('')
  ).join('');

  const left = fmtLeft(cur.bidDeadline);
  const redline = d.starCount + d.fatalCount;

  const notice =
    '<div class="redline">' +
      '<div class="rl-items">' +
        '<span class="rl"><b>★ 星号条款</b><em>' + (d.starCount || 0) + '</em></span>' +
        '<span class="rl danger"><b>废标/无效投标</b><em>' + (d.fatalCount || 0) + '</em></span>' +
        '<span class="rl"><b>全部条款</b><em>' + total + '</em></span>' +
        '<span class="rl time ' + left.cls + '"><b>距投标截止</b><em>' + esc(left.big) + '</em></span>' +
      '</div>' +
      '<div class="rl-btns">' +
        '<button class="btn' + (an.redOnly ? ' primary' : '') + '" id="btnRedOnly">' + (an.redOnly ? '看全部分类' : '只看红线') + '</button>' +
        '<button class="btn" id="btnExportAn">导出 Word</button>' +
        '<button class="btn" id="btnReAnalyze">重新分析</button>' +
      '</div>' +
    '</div>';

  const progress = an.running ? '<div id="anProgress">' + progressHtml(an.task || an.running) + '</div>' : (an.task && an.task.state === 'partial' ? '' : '');

  let right = '';
  if (an.redOnly) {
    const starRows = [];
    const fatalRows = [];
    for (const s of d.sections) {
      for (const it of s.items) {
        if (s.key === 'fatal') fatalRows.push({ it, sec: s });
        else if (it.isStar) starRows.push({ it, sec: s });
      }
    }
    const mk = (title, rows, cls) => {
      if (!rows.length) return '';
      return '<div class="an-sec"><div class="an-sec-head"><b class="' + cls + '">' + title + '（' + rows.length + ' 条）</b></div>' +
        '<table class="an-table"><thead><tr><th style="width:56%">条款内容</th><th style="width:22%">所属板块</th><th style="width:10%">页码</th><th style="width:12%"></th></tr></thead><tbody>' +
        rows.map(({ it, sec }) =>
          '<tr class="' + (cls === 'txt-red' ? 'row-fatal' : 'row-star') + '">' +
          '<td>' + esc(it.cells ? it.cells[it.cells.length - 1] : it.text) + '</td>' +
          '<td class="muted" style="font-size:13px">' + esc(sec.title) + '</td>' +
          '<td>' + (it.page ? '第 ' + it.page + ' 页' : '<span class="muted">待核</span>') + '</td>' +
          '<td class="right">' + (it.page ? '<button class="btn tiny" data-look="' + it.page + '">看原文</button>' : '') + '</td>' +
          '</tr>').join('') +
        '</tbody></table></div>';
    };
    right = mk('废标 / 无效投标项', fatalRows, 'txt-red') + mk('星号（★）条款', starRows, 'txt-amber') ||
      '<div class="an-sec"><div class="muted">这份文件里没有识别到星号条款或废标项。建议你自己再翻一遍招标文件确认。</div></div>';
  } else {
    right = sectionHtml(sec, d);
  }

  const footer = '<div class="an-foot muted">分析时间：' + esc(fmtTime(d.analysisAt)) +
    ' ｜ 文件：' + esc(d.fileName || '') + '（' + (d.pageCount || '?') + ' 页' +
    (d.truncated ? '，只分析了前 ' + d.analyzedPages + ' 页' : '') + '）' +
    (d.failedSegments && d.failedSegments.length ? ' ｜ <span style="color:#b6242e">有 ' + d.failedSegments.length + ' 段需重跑</span>' : '') + '</div>';

  return notice + progress +
    '<div class="an-wrap"><div class="an-side">' + nav + '</div><div class="an-main">' + right + '</div></div>' + footer;
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

// 表格板块的列宽（不给的话「序号」「分值」会被撑得很宽，把评分标准挤成一条竖线）
const COL_W = {
  score: [56, 132, 64, 0],
  qualify: [56, 140, 0],
  conform: [56, 140, 0],
  frontTable: [190, 0]
};

function sectionHtml(sec, d) {
  const isTable = sec.type === 'table';
  const cols = isTable ? (sec.columns || ['内容']) : ['条款内容'];
  const w = isTable ? (COL_W[sec.key] || null) : null;
  const head = cols.map((c, i) => {
    if (w) return '<th' + (w[i] ? ' style="width:' + w[i] + 'px"' : '') + '>' + esc(c) + '</th>';
    return '<th' + (i === cols.length - 1 ? ' style="width:52%"' : '') + '>' + esc(c) + '</th>';
  }).join('');
  const confirmedCount = sec.items.filter((i) => i.confirmed).length;

  const rows = sec.items.map((it) => {
    const cls = (it.confirmed ? 'row-confirmed ' : '') + (it.isFatal ? 'row-fatal' : it.isStar ? 'row-star' : '');
    const ruleTag = it.source === 'rule-scan' ? '<span class="mk rule" title="关键词扫描命中，AI 未收录，按规则补入">关键词补入</span>' : '';
    const mark = (it.isFatal ? '<span class="mk fatal">废标</span>' : it.isStar ? '<span class="mk star">★</span>' : '') + ruleTag;
    const cells = isTable
      ? (it.cells || [it.text]).map((c) => '<td>' + esc(c) + '</td>').join('')
      : '<td>' + mark + esc(it.text) + '</td>';
    return '<tr class="' + cls + '" data-item="' + it.id + '">' +
      '<td class="ckcell"><input type="checkbox" data-confirm="' + it.id + '"' + (it.confirmed ? ' checked' : '') + '></td>' +
      cells +
      '<td class="pagecell">' + (it.page ? '<a href="#" data-look="' + it.page + '">第 ' + it.page + ' 页</a>' : '<span class="muted" title="' + esc(it.pageCheck || '') + '">待核</span>') + '</td>' +
      '<td class="opscell">' +
        '<button class="btn tiny" data-edit="' + it.id + '">改</button>' +
        '<button class="btn tiny danger" data-del="' + it.id + '">删</button>' +
      '</td></tr>';
  }).join('');

  const body = sec.items.length
    ? '<table class="an-table"><thead><tr><th style="width:34px"></th>' + head + '<th style="width:78px">页码</th><th style="width:104px">操作</th></tr></thead><tbody>' + rows + '</tbody></table>'
    : '<div class="an-empty">' + (isTable ? '这份招标文件里没有找到' + esc(sec.title) + '相关内容。' : '本文件未提及这一项。') + '<br><span class="muted">如果确实有，可以点下面「手动添加一条」自己补上。</span></div>';

  return '<div class="an-sec">' +
    '<div class="an-sec-head">' +
      '<div><b>' + esc(sec.title) + '</b><span class="muted" style="margin-left:10px;font-size:13px">' + sec.items.length + ' 条 · 已确认 ' + confirmedCount + ' 条' +
        (sec.key === 'fatal' && d && d.fatalScan ? ' · 关键词扫描命中 ' + d.fatalScan.strong + ' 条强候选' + (d.fatalScan.added ? '，补入 ' + d.fatalScan.added + ' 条' : '') : '') +
        '</span></div>' +
      '<div class="row">' +
        '<button class="btn tiny" id="btnAddItem">＋ 手动添加一条</button>' +
        (sec.items.length ? '<button class="btn tiny" id="btnConfirmAll">全部标为已确认</button>' : '') +
      '</div>' +
    '</div>' + body + '</div>';
}

/* ---- 分析页事件 ---- */
function bindAnalysisEvents() {
  const btnStart = $('#btnStartAnalysis');
  if (btnStart) btnStart.onclick = () => startAnalysis(false);
  const btnRe = $('#btnReAnalyze');
  if (btnRe) btnRe.onclick = () => confirmReanalyze();
  const btnExp = $('#btnExportAn');
  if (btnExp) btnExp.onclick = exportAnalysis;
  const btnRed = $('#btnRedOnly');
  if (btnRed) btnRed.onclick = () => { S.an.redOnly = !S.an.redOnly; renderProject(); };
  const btnGoTender = $('#btnGoTender');
  if (btnGoTender) btnGoTender.onclick = () => { S.tab = 'tender'; renderProject(); syncHash(); };
  const btnGoSet = $('#btnGoSettings');
  if (btnGoSet) btnGoSet.onclick = settingsDialog;

  $('#main').querySelectorAll('[data-sec]').forEach((el) => {
    el.onclick = () => { S.an.section = el.dataset.sec; S.an.redOnly = false; renderProject(); };
  });
  $('#main').querySelectorAll('[data-look]').forEach((el) => {
    el.onclick = (e) => { e.preventDefault(); showPage(Number(el.dataset.look)); };
  });
  $('#main').querySelectorAll('[data-confirm]').forEach((el) => {
    el.onchange = async () => {
      await saveItem({ op: 'confirm', item: { id: el.dataset.confirm, confirmed: el.checked } });
      renderProject();
    };
  });
  $('#main').querySelectorAll('[data-edit]').forEach((el) => {
    el.onclick = () => editItemDialog(el.dataset.edit);
  });
  $('#main').querySelectorAll('[data-del]').forEach((el) => {
    el.onclick = async () => {
      if (!confirm('确定删掉这一条吗？')) return;
      await saveItem({ op: 'delete', item: { id: el.dataset.del } });
      renderProject();
    };
  });
  const add = $('#btnAddItem');
  if (add) add.onclick = () => editItemDialog(null);
  const all = $('#btnConfirmAll');
  if (all) all.onclick = async () => {
    await saveItem({ op: 'confirm', item: { confirmed: true } });
    renderProject();
    toast('已全部标为已确认');
  };
}

async function saveItem(body) {
  const secKey = S.an.redOnly ? body.section || S.an.section : S.an.section;
  try {
    const r = await api('PUT', '/api/projects/' + S.cur.id + '/analysis/item', { section: body.section || secKey, op: body.op, item: body.item });
    if (S.an && S.an.data) {
      const s = S.an.data.sections.find((x) => x.key === (body.section || secKey));
      if (s && r.section) { s.items = r.section.items; }
      if (r.stat) S.an.data.stat = r.stat;
      if (r.starCount !== undefined) S.an.data.starCount = r.starCount;
      if (r.fatalCount !== undefined) S.an.data.fatalCount = r.fatalCount;
    }
    return true;
  } catch (e) { toast(e.message, true); return false; }
}

async function startAnalysis(force) {
  try {
    const r = await api('POST', '/api/projects/' + S.cur.id + '/analyze', { force: !!force });
    if (r.existing) { toast('已经有分析结果了'); return; }
    S.an = { projectId: S.cur.id, loading: false, section: 'format', redOnly: false, running: { taskId: r.taskId, message: '正在启动…', step: 0, total: 1 }, taskId: r.taskId };
    renderProject();
    startAnalysisPolling(r.taskId);
    toast('已开始分析，大约 3～5 分钟');
  } catch (e) { toast(e.message, true); }
}

function confirmReanalyze() {
  openModal('<h3>重新分析</h3><p>会重新读一遍招标文件，覆盖现在这份清单。' +
    '你手工改过的、加过的条目也会一起被替换掉（旧结果会自动备份一份）。</p>' +
    '<div class="modal-foot"><button class="btn" data-close>取消</button><button class="btn primary" id="okRe">确定重新分析</button></div>');
  $('#okRe').onclick = () => { closeModal(); startAnalysis(true); };
}

async function exportAnalysis() {
  const btn = $('#btnExportAn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="loading"></span> 生成中…'; }
  try {
    const r = await api('POST', '/api/projects/' + S.cur.id + '/analysis/export', {});
    toast('已生成：' + r.fileName);
    openModal('<h3>已生成 Word 文件</h3><p>文件已保存到项目文件夹里：</p>' +
      '<div class="card" style="background:#f7f9fc"><code style="font-size:13px">D:\\投标工作台\\' + esc(r.relPath.replace(/\//g, '\\')) + '</code></div>' +
      '<div class="modal-foot"><button class="btn" data-close>关闭</button>' +
      '<a class="btn primary" href="/api/download?path=' + encodeURIComponent(r.relPath) + '">下载这份 Word</a></div>');
  } catch (e) { toast(e.message, true); }
  finally { if (btn) { btn.disabled = false; btn.textContent = '导出 Word'; } }
}

function editItemDialog(itemId) {
  const sec = S.an.data.sections.find((s) => s.key === S.an.section);
  const isTable = sec.type === 'table';
  const cols = isTable ? (sec.columns || ['内容']) : ['条款内容'];
  const it = itemId ? sec.items.find((x) => x.id === itemId) : null;
  const vals = it ? (it.cells || [it.text]) : new Array(cols.length).fill('');

  const inputs = cols.map((c, i) =>
    '<div class="field full"><label>' + esc(c) + '</label><input data-cell="' + i + '" value="' + esc(vals[i] || '') + '"></div>'
  ).join('');

  openModal('<h3>' + (it ? '修改这一条' : '手动添加一条') + '</h3>' +
    '<p class="muted" style="margin-top:0;font-size:13px">所属板块：' + esc(sec.title) + '</p>' +
    '<div class="grid">' + inputs +
      '<div class="field"><label>页码</label><input id="eiPage" value="' + (it && it.page ? it.page : '') + '" placeholder="例如 18"></div>' +
      '<div class="field"><label>标记</label><div class="row" style="gap:16px;padding-top:8px">' +
        '<label class="inline"><input type="checkbox" id="eiStar"' + (it && it.isStar ? ' checked' : '') + '> 星号条款 ★</label>' +
        '<label class="inline"><input type="checkbox" id="eiFatal"' + (it && it.isFatal ? ' checked' : '') + '> 废标项</label>' +
      '</div></div>' +
    '</div>' +
    '<div class="modal-foot"><button class="btn" data-close>取消</button><button class="btn primary" id="okItem">保存</button></div>');

  $('#okItem').onclick = async () => {
    const cells = [];
    document.querySelectorAll('[data-cell]').forEach((el) => cells.push(el.value));
    const payload = {
      id: it ? it.id : undefined,
      cells: isTable ? cells : undefined,
      text: isTable ? undefined : cells[0],
      page: $('#eiPage').value.trim() ? Number($('#eiPage').value.trim()) || null : null,
      isStar: $('#eiStar').checked,
      isFatal: $('#eiFatal').checked
    };
    const ok = await saveItem({ op: 'upsert', item: payload });
    if (ok) { closeModal(); renderProject(); toast('已保存'); }
  };
}

function showPage(n) {
  const tender = S.cur.files.filter((f) => f.stage === 'tender');
  const f = tender.find((x) => /pdf$/i.test(x.originalName)) || tender[0];
  if (!f) { toast('找不到招标文件', true); return; }
  const isPdf = /pdf$/i.test(f.originalName);
  const html = '<h3>招标文件 第 ' + n + ' 页</h3>' +
    '<p class="muted" style="margin-top:0;font-size:13px">' + esc(f.originalName) + '</p>' +
    (isPdf
      ? '<div class="pageview"><img id="pvImg" src="/api/files/' + f.id + '/page/' + n + '" alt="第 ' + n + ' 页"></div>'
      : '<div class="placeholder">Word 文件不能按页显示图片。可以在「招标文件」页签点「看内容」看全文。</div>') +
    '<div class="modal-foot">' +
      (isPdf ? '<button class="btn" id="pvPrev">上一页</button><button class="btn" id="pvNext">下一页</button>' : '') +
      '<button class="btn" data-close>关闭</button></div>';
  openModal(html);
  let cur = n;
  const go = (d) => {
    cur += d;
    if (cur < 1) cur = 1;
    const img = $('#pvImg');
    if (img) img.src = '/api/files/' + f.id + '/page/' + cur;
    const h = $('#modal h3');
    if (h) h.textContent = '招标文件 第 ' + cur + ' 页';
  };
  if ($('#pvPrev')) $('#pvPrev').onclick = () => go(-1);
  if ($('#pvNext')) $('#pvNext').onclick = () => go(1);
}

/* ---------- 事件绑定 ---------- */
function bindTabEvents() {
  if (S.tab === 'check' && !S.ck) loadCheckFor(S.cur.id);
  if (S.tab === 'submit' && !S.sb) loadSubmitFor(S.cur.id);
  if (S.tab === 'info') {
    const save = $('#btnSaveInfo');
    if (save) save.onclick = saveInfo;
    const del = $('#btnDelete');
    if (del) del.onclick = deleteProject;
  }
  if (S.tab === 'analysis') bindAnalysisEvents();
  if (S.tab === 'draft') bindDraftEvents();
  if (S.tab === 'check') bindCheckEvents();
  if (S.tab === 'submit') bindSubmitEvents();
  if (S.tab === 'tender') {
    const drop = $('#drop');
    const input = $('#fileInput');
    if (drop && input) {
      drop.onclick = () => input.click();
      input.onchange = () => { doUpload(Array.from(input.files)); input.value = ''; };
      drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('hot'); };
      drop.ondragleave = () => drop.classList.remove('hot');
      drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('hot'); doUpload(Array.from(e.dataTransfer.files)); };
    }
    const ex = $('#btnExtract');
    if (ex) ex.onclick = startExtract;
    $('#main').querySelectorAll('[data-act]').forEach((btn) => {
      btn.onclick = () => {
        const id = btn.dataset.id;
        if (btn.dataset.act === 'del') removeFile(id);
        if (btn.dataset.act === 'read') showFileText(id);
      };
    });
  }
}

async function saveInfo() {
  const body = {};
  $('#tabBody').querySelectorAll('[data-k]').forEach((el) => { body[el.dataset.k] = el.value; });
  try {
    await api('POST', '/api/projects/' + S.cur.id, body);
    toast('已保存');
    await openProject(S.cur.id);
    await refreshProjects();
  } catch (e) { toast(e.message, true); }
}

function deleteProject() {
  openModal('<h3>删除项目</h3><p>确定要删除「' + esc(S.cur.name) + '」吗？D 盘对应的文件夹也会一起删掉，不能恢复。</p>' +
    '<div class="modal-foot"><button class="btn" data-close>取消</button><button class="btn danger" id="okDel">确定删除</button></div>');
  $('#okDel').onclick = async () => {
    try {
      await api('DELETE', '/api/projects/' + S.cur.id);
      closeModal();
      S.cur = null;
      await refreshProjects();
      $('#main').innerHTML = '<div class="empty"><h2>项目已删除</h2><p class="muted">可以在左边选别的项目，或新建一个。</p></div>';
      toast('已删除');
    } catch (e) { toast(e.message, true); }
  };
}

async function doUpload(files) {
  if (!files || !files.length) return;
  const prog = $('#upProgress');
  for (const f of files) {
    prog.innerHTML = '<span class="loading"></span> 正在上传 ' + esc(f.name) + ' …';
    try {
      await upload('/api/projects/' + S.cur.id + '/files?stage=tender&role=tenderFile', f, (r) => {
        prog.innerHTML = '<span class="loading"></span> 正在上传 ' + esc(f.name) + '（' + Math.round(r * 100) + '%）';
      });
      toast('已上传 ' + f.name);
    } catch (e) {
      toast(f.name + ' 上传失败：' + e.message, true);
    }
  }
  prog.textContent = '';
  await openProject(S.cur.id);
  await refreshProjects();
}

async function removeFile(id) {
  try {
    await api('POST', '/api/files/' + id + '/delete');
    toast('已删除文件');
    await openProject(S.cur.id);
  } catch (e) { toast(e.message, true); }
}

async function showFileText(id) {
  openModal('<h3>正在读取文件内容…</h3><div class="placeholder"><span class="loading"></span> 请稍等，PDF 需要逐页解析。</div>');
  try {
    const d = await api('GET', '/api/files/' + id + '/text');
    const f = S.cur.files.find((x) => x.id === id);
    const warn = d.scanned
      ? '<div class="card" style="background:#fdf6e3;border-color:#f2ddb0"><b>这份文件没有文字层，像是扫描件。</b><div class="muted" style="font-size:13px;margin-top:6px">可以点下面「用 AI 看图识别」让它读图；页数多时比较慢，建议一次不超过 20 页。</div></div>'
      : d.emptyPages && d.emptyPages.length
        ? '<div class="card" style="background:#fdf6e3;border-color:#f2ddb0"><b>有 ' + d.emptyPages.length + ' 页没有读到文字</b><div class="muted" style="font-size:13px">页码：' + d.emptyPages.slice(0, 40).join('、') + (d.emptyPages.length > 40 ? ' …' : '') + '</div></div>'
        : '';
    const pages = d.pages.map((p) =>
      '<div class="card" style="margin-bottom:10px"><div class="row" style="justify-content:space-between;margin-bottom:8px">' +
      '<b>第 ' + p.page + ' 页</b>' + (p.source === 'vision' ? '<span class="tag blue">AI 读图</span>' : '') + '</div>' +
      '<div style="white-space:pre-wrap;font-size:13px;max-height:360px;overflow:auto;color:#3a4048">' + (p.text ? esc(p.text) : '<span class="muted">（这一页没有文字）</span>') + '</div></div>'
    ).join('');

    openModal('<h3>' + esc(f ? f.originalName : '文件内容') + '</h3>' +
      '<div class="row" style="margin-bottom:12px"><span class="tag">' + d.pageCount + ' 页</span><span class="tag">' + d.chars + ' 字</span>' +
      (d.kind ? '<span class="tag">' + esc(d.kind.toUpperCase()) + '</span>' : '') + '<span class="spacer"></span>' +
      '<button class="btn" id="btnOcr">用 AI 看图识别（前 10 页）</button></div>' + warn + pages +
      '<div class="modal-foot"><button class="btn" data-close>关闭</button></div>');

    const ocrBtn = $('#btnOcr');
    if (ocrBtn) {
      ocrBtn.onclick = async () => {
        const pages = [];
        for (let i = 1; i <= Math.min(10, d.pageCount); i++) pages.push(i);
        ocrBtn.disabled = true;
        ocrBtn.innerHTML = '<span class="loading"></span> 识别中，可能要两三分钟…';
        try {
          const r = await api('POST', '/api/files/' + id + '/ocr', { pages });
          toast('识别完成，共 ' + r.results.filter((x) => x.chars).length + ' 页有内容');
          closeModal();
          showFileText(id);
        } catch (e) {
          toast(e.message, true);
          ocrBtn.disabled = false;
          ocrBtn.textContent = '用 AI 看图识别（前 10 页）';
        }
      };
    }
  } catch (e) {
    openModal('<h3>读不出来</h3><p class="muted">' + esc(e.message) + '</p><div class="modal-foot"><button class="btn" data-close>关闭</button></div>');
  }
}

/* ---------- AI 识别基本信息 ---------- */
const META_LABEL = {
  code: '招标编号', name: '项目名称', owner: '招标单位', agency: '代理机构', budget: '预算金额',
  bidDeadline: '投标截止时间', openTime: '开标时间', openPlace: '开标地点', deposit: '投标保证金',
  purchaseMethod: '采购方式', packageNo: '包号', company: '需要的资质', notes: '提醒'
};

async function startExtract() {
  const msg = $('#extractMsg');
  const btn = $('#btnExtract');
  btn.disabled = true;
  btn.innerHTML = '<span class="loading"></span> 正在读文件，请稍等…';
  msg.textContent = '第一次读一份几十页的文件，大约要 1～3 分钟。';
  try {
    const r = await api('POST', '/api/projects/' + S.cur.id + '/extract-meta', {});
    showMetaResult(r);
  } catch (e) {
    toast(e.message, true);
    msg.textContent = e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '开始自动识别';
  }
}

function showMetaResult(r) {
  const m = r.meta || {};
  const ev = {};
  (m.evidence || []).forEach((x) => { if (x && x.field) ev[x.field] = x; });
  const keys = ['name', 'code', 'owner', 'agency', 'budget', 'purchaseMethod', 'packageNo', 'bidDeadline', 'openTime', 'openPlace', 'deposit', 'company', 'notes'];
  const rows = keys.map((k) => {
    const cur = (S.cur[k] || '').trim();
    const val = (m[k] || '').trim();
    const same = cur && val && cur.replace(/\s/g, '') === val.replace(/\s/g, '');
    const e = ev[k];
    const hint = e && e.page ? '<div class="hint muted" style="font-size:12px">第 ' + e.page + ' 页' + (e.quote ? '：' + esc(String(e.quote).slice(0, 60)) : '') + '</div>' : '';
    return '<div class="field full" style="margin-bottom:10px">' +
      '<label>' + META_LABEL[k] +
        (cur && !same ? ' <span class="tag" style="font-size:11px">原来：' + esc(cur) + '</span>' : '') +
        (same ? ' <span class="tag green" style="font-size:11px">一致</span>' : '') +
      '</label>' +
      '<input data-mk="' + k + '" value="' + esc(val) + '" placeholder="文件里没找到，可留空">' + hint + '</div>';
  }).join('');

  openModal('<h3>AI 从招标文件里找到这些信息</h3>' +
    '<p class="muted" style="margin-top:0;font-size:13px">来源：' + esc(r.fileName || '') +
      '（' + (r.stats ? r.stats.pages + ' 页 / ' + r.stats.chars + ' 字' : '') + '）' +
      (r.visionPages && r.visionPages.length ? '，其中 ' + r.visionPages.length + ' 页是看图识别的' : '') +
      '。请逐条核对，不对的地方直接改，确认后再写入项目。</p>' +
    '<div class="grid">' + rows + '</div>' +
    '<div class="modal-foot"><button class="btn" data-close>取消</button>' +
    '<button class="btn primary" id="okMeta">确认，写入项目</button></div>');

  $('#okMeta').onclick = async () => {
    const body = {};
    document.querySelectorAll('[data-mk]').forEach((el) => {
      const k = el.dataset.mk;
      if (k === 'notes' && !el.value.trim() && !(S.cur[k] || '').trim()) { body[k] = ''; return; }
      body[k] = el.value;
    });
    try {
      await api('POST', '/api/projects/' + S.cur.id, body);
      closeModal();
      toast('已写入项目信息');
      await openProject(S.cur.id);
      await refreshProjects();
    } catch (e) { toast(e.message, true); }
  };
}

/* ---------- 弹窗 ---------- */
function openModal(html) {
  $('#modal').innerHTML = html;
  $('#modalMask').classList.add('on');
  $('#modal').querySelectorAll('[data-close]').forEach((b) => { b.onclick = closeModal; });
}
function closeModal() { $('#modalMask').classList.remove('on'); $('#modal').innerHTML = ''; }
$('#modalMask') && ($('#modalMask').onclick = (e) => { if (e.target.id === 'modalMask') closeModal(); });

/* ---------- 新建项目 ---------- */
function newProjectDialog() {
  openModal('<h3>新建项目</h3>' +
    '<p class="muted" style="margin-top:0;font-size:13px">先填几项知道的就行，剩下的可以建好以后用 AI 从招标文件里自动识别。</p>' +
    '<div class="grid">' +
      '<div class="field full"><label>项目名称</label><input id="npName" placeholder="例如：XX 区政务云平台运维服务项目"></div>' +
      '<div class="field"><label>招标编号</label><input id="npCode" placeholder="文件封面上的编号，不知道可留空"></div>' +
      '<div class="field"><label>投标截止时间</label><input id="npDeadline" placeholder="2026-12-31 09:30"><div class="hint">格式：年-月-日 时:分</div></div>' +
      '<div class="field"><label>招标单位</label><input id="npOwner" placeholder="可留空"></div>' +
      '<div class="field"><label>预算金额</label><input id="npBudget" placeholder="可留空"></div>' +
    '</div>' +
    '<div class="modal-foot"><button class="btn" data-close>取消</button><button class="btn primary" id="okNew">创建</button></div>');
  $('#okNew').onclick = async () => {
    const name = $('#npName').value.trim();
    if (!name) { toast('请填项目名称', true); return; }
    try {
      const r = await api('POST', '/api/projects', {
        name, code: $('#npCode').value.trim(), bidDeadline: $('#npDeadline').value.trim(),
        owner: $('#npOwner').value.trim(), budget: $('#npBudget').value.trim()
      });
      closeModal();
      await refreshProjects();
      await openProject(r.id);
      S.tab = 'tender';
      renderProject();
      toast('项目已创建，把招标文件传上来吧');
    } catch (e) { toast(e.message, true); }
  };
}

/* ---------- 设置 ---------- */
async function settingsDialog() {
  const s = S.settings || (await api('GET', '/api/settings'));
  openModal('<h3>设置</h3><div class="grid">' +
    '<div class="field full"><label>DeepSeek API Key</label>' +
      '<input id="stKey" placeholder="' + (s.hasKey ? '已填写（' + esc(s.deepseekApiKeyMasked) + '），要换就粘贴新的' : 'sk-...') + '">' +
      '<div class="hint">不填也能用工作台的整理和归档功能，只是没有 AI 识别与分析。</div></div>' +
    '<div class="field"><label>模型</label><input id="stModel" value="' + esc(s.deepseekModel || 'deepseek-flash') + '"></div>' +
    '<div class="field"><label>投标单位名称</label><input id="stCompany" value="' + esc(s.company || '') + '" placeholder="用于标书封面，可留空"></div>' +
    '<div class="field full"><label>数据位置</label><input value="D:\\投标工作台" readonly></div>' +
    '</div><div class="modal-foot"><button class="btn" data-close>取消</button><button class="btn primary" id="okSet">保存</button></div>');
  $('#okSet').onclick = async () => {
    const body = { deepseekModel: $('#stModel').value.trim(), company: $('#stCompany').value.trim() };
    const k = $('#stKey').value.trim();
    if (k) body.deepseekApiKey = k;
    try {
      await api('POST', '/api/settings', body);
      S.settings = await api('GET', '/api/settings');
      closeModal();
      toast('设置已保存');
      loadHealth();
    } catch (e) { toast(e.message, true); }
  };
}

/* ================= 页签：投标文件制作（模块3） ================= */
S.df = null; // {projectId, draft, loading, doc, openChapter, taskId, timer, hasAnalysis, apiReady}

const DOC_LIST = [
  { key: 'price', title: '价格文件', desc: '开标一览表、价格构成表。报价由你自己填。' },
  { key: 'biz', title: '商务技术文件', desc: '商务与技术条款响应的主体，含索引表和偏离表。' },
  { key: 'qual', title: '资格证明文件', desc: '营业执照、资质、业绩、人员等证明材料的索引与说明。' }
];

const TYPE_TAG = {
  cover: '<span class="tag">封面</span>',
  toc: '<span class="tag">目录</span>',
  index: '<span class="tag blue">索引表</span>',
  deviation: '<span class="tag blue">偏离表</span>',
  priceTable: '<span class="tag blue">表格</span>',
  priceTable2: '<span class="tag blue">表格</span>',
  normal: ''
};

function dfLoading() { return '<div class="placeholder"><span class="loading"></span> 正在读取投标文件…</div>'; }

async function loadDraftFor(pid) {
  const keepDoc = S.df && S.df.projectId === pid ? S.df.doc : null;
  const keepOpen = S.df && S.df.projectId === pid ? S.df.openChapter : null;
  S.df = { projectId: pid, loading: true, doc: keepDoc, openChapter: keepOpen, hasAnalysis: !!((S.an && S.an.data) || null) };
  let d;
  try { d = await api('GET', '/api/projects/' + pid + '/draft'); }
  catch (e) {
    S.df = { projectId: pid, loading: false, error: e.message };
    if (S.cur && S.cur.id === pid && S.tab === 'draft') renderProject();
    return;
  }
  const firstKey = d.draft.mode === 'merged' ? 'merged' : 'price';
  S.df = {
    projectId: pid, loading: false, draft: d.draft, hasAnalysis: d.hasAnalysis, apiReady: d.apiReady,
    doc: keepDoc && d.draft.docs[keepDoc] && (d.draft.mode !== 'merged' || keepDoc === 'merged') ? keepDoc : (d.draft.docs[firstKey] ? firstKey : Object.keys(d.draft.docs)[0]),
    openChapter: keepOpen, redOnly: false
  };
  if (S.cur && S.cur.id === pid && S.tab === 'draft') renderProject();
}

function viewDraft() {
  const cur = S.cur;
  const st = S.df && S.df.projectId === cur.id ? S.df : null;
  if (!st) { loadDraftFor(cur.id); return dfLoading(); }
  if (st.loading) return dfLoading();
  if (st.error) return '<div class="placeholder">读取失败：' + esc(st.error) + '</div>';

  const d = st.draft;
  const keys = d.mode === 'merged'
    ? (d.docs.merged ? ['merged'] : [])
    : ['price', 'biz', 'qual'].filter((k) => d.docs[k]);
  const cur0 = d.docs[st.doc] && keys.includes(st.doc) ? d.docs[st.doc] : d.docs[keys[0]];

  /* 顶部：模式 + 总提示 */
  const modeText = d.mode === 'merged' ? '合并成一份投标文件' : '分三份独立编制（价格 / 商务技术 / 资格证明）';
  const head = '<div class="df-top">' +
    '<div class="df-mode"><b>编制方式：</b>' + esc(modeText) +
      '<button class="btn tiny" id="btnChangeMode">改成' + (d.mode === 'merged' ? '分三份' : '合并一份') + '</button></div>' +
    '<div class="df-hint muted">' + (st.hasAnalysis
      ? '索引表、偏离表会自动按招标分析结果填好，你只需要补「我方响应位置」的页码。'
      : '还没做招标分析，索引表和偏离表会是空的。建议先回「招标分析」页签做一次分析。') + '</div>' +
    '</div>';

  /* 左：文件清单 */
  const left = '<div class="df-docs">' + keys.map((k) => {
    const doc = d.docs[k];
    const bodyCh = (doc.chapters || []).filter((c) => c.type === 'normal');
    const done = bodyCh.filter((c) => c.body && c.body.trim()).length;
    return '<div class="df-doc' + (k === st.doc ? ' active' : '') + '" data-doc="' + k + '">' +
      '<div class="df-doc-t">' + esc(doc.title) + '</div>' +
      '<div class="df-doc-s">' + (doc.built ? '已生成框架 · ' + done + '/' + bodyCh.length + ' 章有内容' : '还没生成框架') + '</div>' +
    '</div>';
  }).join('') + '</div>';

  /* 右：当前文件的章节 */
  let right = '';
  if (!cur0.built) {
    right = '<div class="card"><h3>' + esc(cur0.title) + '</h3>' +
      '<p class="muted" style="margin-top:0;font-size:13px;max-width:680px">第一步是生成框架：AI 会按招标文件的要求，把这份文件该有哪些章节列出来（封面、目录、各级标题、索引表、偏离表），你可以在后面增删改。' +
      '框架里不带正文，正文要逐章生成或者由你自己上传。</p>' +
      (st.apiReady ? '<button class="btn primary" id="btnOutline">生成框架</button>'
        : '<button class="btn primary" id="btnGoSettings2">先去设置 API Key</button>') +
      '<span id="dfMsg" class="muted" style="margin-left:12px;font-size:13px"></span></div>';
  } else {
    const rows = cur0.chapters.map((c, i) => {
      const isOpen = st.openChapter === c.id;
      const chars = c.body ? c.body.length : 0;
      const srcTag = c.source === 'ai' ? '<span class="tag green">AI 写</span>' : c.source === 'upload' ? '<span class="tag blue">你上传的</span>' : c.source === 'manual' ? '<span class="tag">手写</span>' : '';
      const needRow = c.type === 'index' || c.type === 'deviation';
      const cnt = needRow ? ((c.rows || []).length + ' 条') : (chars ? chars + ' 字' : '空');
      const actions = c.type === 'normal'
        ? '<button class="btn tiny" data-ch="' + c.id + '" data-go="open">' + (chars ? '查看/编辑' : '手写') + '</button>' +
          '<button class="btn tiny" data-ch="' + c.id + '" data-go="write">' + (chars ? '重写' : 'AI 写正文') + '</button>' +
          (chars ? '<button class="btn tiny" data-ch="' + c.id + '" data-go="expand">扩写</button>' : '')
        : (needRow ? '<button class="btn tiny" data-ch="' + c.id + '" data-go="table">查看/编辑</button>' : '');
      const lv = Number(c.level) || 1;
      const pad = lv >= 3 ? 52 : lv === 2 ? 26 : 0;
      // 上传的标书按 Word 里原本的编号显示（1、5.1…）；分部标题（资格审查部分等）本来没编号就不加序号。
      // 自动生成的框架没有原编号，才退回用数组下标编号。
      const useOrig = !!c.noIdx;
      const origNo = String(c.number == null ? '' : c.number);
      const isCoverToc = c.type === 'cover' || c.type === 'toc';
      const numTxt = isCoverToc ? ''
        : useOrig ? (origNo ? origNo + ' ' : '')
        : (i + 1) + '. ';
      const titleCls = useOrig && !origNo ? ' df-ch-t-part' : '';
      const typeTag = TYPE_TAG[c.type] || '';
      const typeTagText = typeTag.replace(/<[^>]+>/g, '');
      const main = '<div class="df-ch-main" data-ch="' + c.id + '" data-go="open" style="padding-left:' + pad + 'px">' +
        '<div class="df-ch-t' + titleCls + '">' + esc(numTxt + c.title) + ' ' + (typeTagText && typeTagText !== c.title ? typeTag : '') + ' ' + srcTag + '</div>' +
        '<div class="df-ch-s">' + esc(c.hint || '') + '</div></div>' +
        '<div class="df-ch-n">' + cnt + '</div>' +
        '<div class="df-ch-a">' + actions +
          '<button class="btn tiny" data-ch="' + c.id + '" data-go="rename">改名</button>' +
          '<button class="btn tiny danger" data-ch="' + c.id + '" data-go="del">删</button></div>';
      const panel = isOpen ? chapterPanel(cur0, c) : '';
      return '<div class="df-ch' + (isOpen ? ' open' : '') + '">' + main + panel + '</div>';
    }).join('');

    right = '<div class="df-head">' +
      '<div><b>' + esc(cur0.title) + '</b> <span class="muted" style="font-size:13px">共 ' + cur0.chapters.length + ' 章</span></div>' +
      '<div class="row" style="gap:8px">' +
        '<button class="btn" id="btnAddCh">＋加一章</button>' +
        '<button class="btn" id="btnRefreshTables">刷新索引/偏离表</button>' +
        '<button class="btn" id="btnImport">上传我写的 Word</button>' +
        (cur0.source === 'upload' ? '<button class="btn" id="btnRestoreOutline">恢复自动框架</button>' : '') +
        '<button class="btn primary" id="btnExportDraft">下载 Word</button>' +
        '<button class="btn" id="btnReOutline">重新生成框架</button>' +
      '</div></div>' +
      '<input type="file" id="impInput" accept=".docx,.doc" style="display:none">' +
      '<div class="df-msg muted" id="dfMsg"></div>' +
      '<div class="df-chs">' + rows + '</div>';
  }

  return head + '<div class="df-wrap">' + left + '<div class="df-main">' + right + '</div></div>';
}

function chapterPanel(doc, c) {
  if (c.type === 'index' || c.type === 'deviation') {
    const head = c.type === 'index'
      ? ['序号', '招标文件条款原文', '页码', '我方响应位置']
      : ['序号', '招标文件条款原文', '页码', '我方响应', '偏离说明', '备注'];
    const colKey = c.type === 'index' ? ['no', 'clause', 'page', 'where'] : ['no', 'clause', 'page', 'response', 'dev', 'note'];
    const needRows = c.type === 'index';
    const colW = c.type === 'index' ? [44, 0, 62, 118] : [44, 0, 58, 92, 88, 104];
    const rows = (c.rows || []).map((r, i) =>
      '<tr>' + colKey.map((k) => {
        const wide = colW[colKey.indexOf(k)] === 0;
        const tag = (needRows && wide)
          ? '<textarea data-row="' + i + '" data-c="' + k + '" rows="' + Math.min(6, Math.max(2, Math.ceil(String(r[k] || '').length / 52))) + '">' + esc(r[k] || '') + '</textarea>'
          : '<input data-row="' + i + '" data-c="' + k + '" value="' + esc(r[k] || '') + '"' + (k === 'no' ? ' readonly style="text-align:center"' : '') + '>';
        return '<td>' + tag + '</td>';
      }).join('') + '</tr>'
    ).join('');
    const cols = '<colgroup>' + colW.map((w) => '<col' + (w ? ' style="width:' + w + 'px"' : '') + '>').join('') + '</colgroup>';
    return '<div class="df-panel"><div class="df-panel-h"><b>' + esc(c.title) + '</b>' +
      '<span class="muted" style="font-size:12px">按招标分析结果自动填好，你可以直接改。改完点「保存这张表」。</span></div>' +
      (c.rows && c.rows.length
        ? '<div class="df-tblwrap"><table class="df-tbl">' + cols + '<thead><tr>' + head.map((h) => '<th>' + h + '</th>').join('') + '</tr></thead><tbody>' + rows + '</tbody></table></div>'
        : '<div class="muted" style="padding:10px 0">还没有内容。点上面的「刷新索引/偏离表」按招标分析结果自动填。</div>') +
      '<div class="row" style="margin-top:10px"><button class="btn primary" data-save="' + c.id + '">保存这张表</button>' +
      '<button class="btn" data-close-ch="' + c.id + '">收起</button></div></div>';
  }
  const srcHint = c.source === 'upload' ? '<span class="tag blue">来自你上传的 Word</span>' : c.source === 'ai' ? '<span class="tag green">AI 生成</span>' : c.source === 'manual' ? '<span class="tag">手工填写</span>' : '';
  return '<div class="df-panel"><div class="df-panel-h"><b>' + esc(c.title) + '</b>' + srcHint +
    '<span class="muted" style="font-size:12px">' + (c.body ? c.body.length + ' 字' : '还没有内容') + '</span></div>' +
    '<textarea class="df-editor" data-body="' + c.id + '" rows="16" placeholder="可以直接在这里写、改，或者点上面的「AI 写正文」让 AI 先写一版">' + esc(c.body || '') + '</textarea>' +
    '<div class="row" style="margin-top:10px"><button class="btn primary" data-savebody="' + c.id + '">保存正文</button>' +
    '<button class="btn" data-ch="' + c.id + '" data-go="write">AI 写一版</button>' +
    '<button class="btn" data-ch="' + c.id + '" data-go="expand">在现有内容上扩写</button>' +
    '<button class="btn" data-close-ch="' + c.id + '">收起</button></div></div>';
}

/* ---------- 模块3 事件 ---------- */
function dfSetMsg(t) { const el = $('#dfMsg'); if (el) el.textContent = t; }

async function dfPatch(url, body, method) {
  return api(method || 'POST', url, body || {});
}

function bindDraftEvents() {
  const st = S.df;
  if (!st || !st.draft) return;
  const d = st.draft;

  const modeBtn = $('#btnChangeMode');
  if (modeBtn) modeBtn.onclick = () => {
    const target = d.mode === 'merged' ? 'split' : 'merged';
    openModal('<h3>改编制方式</h3><p>' + (target === 'merged'
      ? '把所有内容合并成一份《投标文件》。已经写好的章节内容会保留，但章节结构会按合并版重新套一遍。'
      : '拆成价格文件、商务技术文件、资格证明文件三份。已经写好的章节内容会保留。') + '</p>' +
      '<div class="modal-foot"><button class="btn" data-close>取消</button><button class="btn primary" id="okMode">确定</button></div>');
    $('#okMode').onclick = async () => {
      try { await dfPatch('/api/projects/' + S.cur.id + '/draft/mode', { mode: target }); closeModal(); S.df = null; renderProject(); toast('已切换'); }
      catch (e) { toast(e.message, true); }
    };
  };

  const goS = $('#btnGoSettings2');
  if (goS) goS.onclick = settingsDialog;

  const btnOutline = $('#btnOutline');
  if (btnOutline) btnOutline.onclick = () => startOutline(st.doc, false);

  const btnRe = $('#btnReOutline');
  if (btnRe) btnRe.onclick = () => startOutline(st.doc, true);

  /* 文件切换 */
  document.querySelectorAll('.df-doc').forEach((el) => {
    el.onclick = () => { S.df.doc = el.dataset.doc; S.df.openChapter = null; renderProject(); };
  });

  /* 章节操作 */
  document.querySelectorAll('[data-ch]').forEach((el) => {
    el.onclick = (ev) => {
      ev.stopPropagation();
      const cid = el.dataset.ch;
      const go = el.dataset.go;
      const ch = (d.docs[st.doc].chapters || []).find((x) => x.id === cid);
      if (!ch) return;
      if (go === 'open' || go === 'table') { S.df.openChapter = S.df.openChapter === cid ? null : cid; renderProject(); return; }
      if (go === 'write') { startChapter(cid, 'first', ch.body); return; }
      if (go === 'expand') { startChapter(cid, 'expand', ch.body); return; }
      if (go === 'rename') {
        openModal('<h3>改章节名</h3><div class="field full"><label>章节标题</label><input id="rnTitle" value="' + esc(ch.title) + '"></div>' +
          '<div class="modal-foot"><button class="btn" data-close>取消</button><button class="btn primary" id="okRn">保存</button></div>');
        $('#okRn').onclick = async () => {
          try {
            await api('PUT', '/api/projects/' + S.cur.id + '/draft/' + st.doc + '/chapter/' + cid, { title: $('#rnTitle').value });
            closeModal(); await reloadDraft(); toast('已改名');
          } catch (e) { toast(e.message, true); }
        };
        return;
      }
      if (go === 'del') {
        openModal('<h3>删除这一章</h3><p>确定删掉「' + esc(ch.title) + '」吗？里面的内容会一起没有。</p>' +
          '<div class="modal-foot"><button class="btn" data-close>取消</button><button class="btn danger" id="okDelCh">确定删除</button></div>');
        $('#okDelCh').onclick = async () => {
          try { await dfPatch('/api/projects/' + S.cur.id + '/draft/' + st.doc + '/chapter/' + cid + '/delete'); closeModal(); await reloadDraft(); toast('已删除'); }
          catch (e) { toast(e.message, true); }
        };
      }
    };
  });

  document.querySelectorAll('[data-close-ch]').forEach((el) => {
    el.onclick = () => { S.df.openChapter = null; renderProject(); };
  });

  /* 保存正文 */
  document.querySelectorAll('[data-savebody]').forEach((el) => {
    el.onclick = async () => {
      const cid = el.dataset.savebody;
      const ta = $('[data-body="' + cid + '"]');
      try {
        await api('PUT', '/api/projects/' + S.cur.id + '/draft/' + st.doc + '/chapter/' + cid, { body: ta.value });
        toast('已保存');
        await reloadDraft();
      } catch (e) { toast(e.message, true); }
    };
  });

  /* 保存索引/偏离表 */
  document.querySelectorAll('[data-save]').forEach((el) => {
    el.onclick = async () => {
      const cid = el.dataset.save;
      const ch = (d.docs[st.doc].chapters || []).find((x) => x.id === cid);
      const rows = (ch.rows || []).map((r) => ({ ...r }));
      document.querySelectorAll('[data-row]').forEach((inp) => {
        const i = Number(inp.dataset.row);
        if (rows[i]) rows[i][inp.dataset.c] = inp.value;
      });
      try {
        await api('PUT', '/api/projects/' + S.cur.id + '/draft/' + st.doc + '/chapter/' + cid, { rows });
        toast('已保存这张表');
        await reloadDraft();
      } catch (e) { toast(e.message, true); }
    };
  });

  /* 加一章 */
  const addBtn = $('#btnAddCh');
  if (addBtn) addBtn.onclick = () => {
    openModal('<h3>加一章</h3><div class="field full"><label>章节标题</label><input id="addTitle" placeholder="例如：项目实施方案"></div>' +
      '<div class="modal-foot"><button class="btn" data-close>取消</button><button class="btn primary" id="okAdd">添加</button></div>');
    $('#okAdd').onclick = async () => {
      const title = $('#addTitle').value.trim();
      if (!title) { toast('请填章节标题', true); return; }
      try { await dfPatch('/api/projects/' + S.cur.id + '/draft/' + st.doc + '/chapter', { title }); closeModal(); await reloadDraft(); toast('已添加'); }
      catch (e) { toast(e.message, true); }
    };
  };

  /* 刷新索引表/偏离表 */
  const rt = $('#btnRefreshTables');
  if (rt) rt.onclick = async () => {
    rt.disabled = true; rt.innerHTML = '<span class="loading"></span> 生成中…';
    try {
      const r = await dfPatch('/api/projects/' + S.cur.id + '/draft/' + st.doc + '/refresh-tables');
      toast('已填好 ' + r.updated + ' 张表');
      await reloadDraft();
    } catch (e) { toast(e.message, true); if (rt) { rt.disabled = false; rt.textContent = '刷新索引/偏离表'; } }
  };

  /* 上传我写的 Word */
  const imp = $('#btnImport');
  const impIn = $('#impInput');
  if (imp && impIn) {
    imp.onclick = () => impIn.click();
    impIn.onchange = async () => {
      const f = impIn.files[0];
      if (!f) return;
      impIn.value = '';
      dfSetMsg('正在读取 ' + f.name + '…');
      try {
        const r = await upload('/api/projects/' + S.cur.id + '/draft/' + st.doc + '/import', f);
        const list = (r.titles || []).slice(0, 12).map((t) => esc((t.number ? t.number + ' ' : '') + t.title)).join('、');
        const deepNote = r.skippedDeep ? '三级及更深的 ' + r.skippedDeep + ' 个小标题已并入上一级章节正文。' : '';
        openModal('<h3>已按你上传的标书替换</h3><p>文件：' + esc(f.name) + '</p>' +
          '<p>现在这份文件完全按你上传的章节与顺序排列，只列一级、二级标题，共 <b>' + r.chapters + '</b> 章，序号用你 Word 里的原编号（之前的自动框架已备份，可以一键恢复）。</p>' +
          (deepNote ? '<p class="muted" style="font-size:13px">' + deepNote + '</p>' : '') +
          (list ? '<p class="muted" style="font-size:13px">前几章：' + list + (r.titles.length > 12 ? ' 等' : '') + '</p>' : '') +
          '<div class="modal-foot"><button class="btn primary" data-close>好</button></div>');
        $('#dfMsg').textContent = '';
        await reloadDraft();
      } catch (e) { dfSetMsg(''); toast(e.message, true); }
    };
  }

  /* 恢复自动框架 */
  const rs = $('#btnRestoreOutline');
  if (rs) rs.onclick = () => {
    openModal('<h3>恢复成自动生成的框架</h3><p>你上传的章节结构和内容会被替换回原来的自动框架。上传的原文件仍保留在项目文件夹里。</p>' +
      '<div class="modal-foot"><button class="btn" data-close>取消</button><button class="btn primary" id="okRestore">确定恢复</button></div>');
    $('#okRestore').onclick = async () => {
      closeModal();
      try {
        const r = await dfPatch('/api/projects/' + S.cur.id + '/draft/' + st.doc + '/restore-outline');
        toast('已恢复，共 ' + r.chapters + ' 章');
        st.openChapter = '';
        await reloadDraft();
      } catch (e) { toast(e.message, true); }
    };
  };

  /* 导出 */
  const ex = $('#btnExportDraft');
  if (ex) ex.onclick = async () => {
    ex.disabled = true; ex.innerHTML = '<span class="loading"></span> 生成中…';
    try {
      const r = await dfPatch('/api/projects/' + S.cur.id + '/draft/' + st.doc + '/export');
      openModal('<h3>Word 已生成</h3><p>已保存到项目文件夹：</p>' +
        '<div class="card" style="background:#f7f9fc"><code style="font-size:13px">D:\\投标工作台\\' + esc(r.relPath.replace(/\//g, '\\')) + '</code></div>' +
        '<p class="muted" style="font-size:13px">打开 Word 后：按 F9 或右键目录选「更新域」可以刷新目录页码；正文页码从第二页开始编，封面不显示页码。</p>' +
        '<div class="modal-foot"><button class="btn" data-close>关闭</button>' +
        '<a class="btn primary" href="/api/download?path=' + encodeURIComponent(r.relPath) + '">下载这份 Word</a></div>');
    } catch (e) { toast(e.message, true); }
    finally { if (ex) { ex.disabled = false; ex.textContent = '下载 Word'; } }
  };
}

async function reloadDraft() {
  try {
    const r = await api('GET', '/api/projects/' + S.cur.id + '/draft');
    if (!S.df) return;
    S.df.draft = r.draft; S.df.hasAnalysis = r.hasAnalysis; S.df.apiReady = r.apiReady; S.df.loading = false;
    renderProject();
  } catch (e) { toast(e.message, true); }
}

function dfPoll(taskId) {
  if (S.df && S.df.timer) clearInterval(S.df.timer);
  S.df.taskId = taskId;
  S.df.timer = setInterval(async () => {
    let t;
    try { t = await api('GET', '/api/draft-tasks/' + taskId); } catch { return; }
    if (!S.df || S.df.taskId !== taskId) { clearInterval(S.df.timer); return; }
    dfSetMsg(t.message || '正在处理…');
    if (t.state !== 'running') {
      clearInterval(S.df.timer);
      S.df.timer = null;
      if (t.state === 'error') toast('失败：' + t.message, true);
      else toast(t.message || '完成');
      await reloadDraft();
    }
  }, 2000);
}

async function startOutline(docKey, force) {
  try {
    const r = await dfPatch('/api/projects/' + S.cur.id + '/draft/' + docKey + '/outline', { force: !!force });
    toast('已开始设计框架，大约 1～2 分钟');
    renderProject();
    dfPoll(r.taskId);
  } catch (e) { toast(e.message, true); }
}

async function startChapter(cid, mode, curBody) {
  if (mode === 'first' && curBody && curBody.trim()) {
    openModal('<h3>要重写这一章吗？</h3><p>这一章已经有内容了，重新让 AI 写会把它覆盖掉。' +
      '如果只是想让内容更丰满，建议点「扩写」，AI 会在现有内容基础上补充。</p>' +
      '<div class="modal-foot"><button class="btn" data-close>取消</button><button class="btn primary" id="okReW">确定重写</button></div>');
    $('#okReW').onclick = async () => { closeModal(); await doStartChapter(cid, 'first'); };
    return;
  }
  await doStartChapter(cid, mode);
}

async function doStartChapter(cid, mode) {
  try {
    const r = await dfPatch('/api/projects/' + S.cur.id + '/draft/' + S.df.doc + '/chapter/' + cid, { mode });
    if (S.df) S.df.openChapter = cid;
    toast('AI 正在写这一章，大约 1～3 分钟');
    renderProject();
    dfPoll(r.taskId);
  } catch (e) { toast(e.message, true); }
}

/* ================= 模块4：文件核查 ================= */
S.ck = null;

function ckLoading() {
  return '<div class="page"><div class="placeholder">正在读取核查信息…</div></div>';
}

async function loadCheckFor(pid) {
  if (S.ck && S.ck.projectId === pid && S.ck.loading) return;
  S.ck = { projectId: pid, loading: true, sources: [], selected: new Set(), data: null, hasAnalysis: false, folds: new Set() };
  try {
    const r = await api('GET', '/api/projects/' + pid + '/check');
    const src = r.sources || [];
    // 默认只勾「最终版」：上传过 Word 的以你上传的原件为准，自动生成的草稿默认不勾
    const defaults = src.filter((s) => s.final).map((s) => s.id);
    S.ck = {
      projectId: pid,
      loading: false,
      data: r.check,
      sources: src,
      hasAnalysis: r.hasAnalysis,
      apiReady: r.apiReady,
      selected: new Set(defaults.length ? defaults : src.map((s) => s.id)),
      folds: new Set(),
      taskId: null,
      timer: null,
      running: false,
      msg: ''
    };
    renderProject();
  } catch (e) {
    toast(e.message, true);
    S.ck = null;
    renderProject();
  }
}

const CK_LEVEL = {
  fatal: { t: '必须改', cls: 'lv-fatal' },
  warn: { t: '建议核对', cls: 'lv-warn' },
  ok: { t: '通过', cls: 'lv-ok' }
};

const CK_S = { 2: { t: '完全响应', cls: 'lv-ok' }, 1: { t: '部分响应', cls: 'lv-warn' }, 0: { t: '未响应', cls: 'lv-fatal' } };

function ckReqBlock(d, key) {
  const r = d.req;
  if (!r || !r.stat) {
    if (d.reqError) return '<div class="ck-sec"><div class="ck-sec-h">招标文件要求逐条对照</div><div class="ck-err">' + esc(d.reqError) + '</div></div>';
    return '';
  }
  const st = r.stat;
  const items = r.items || [];
  const need = items.filter((x) => x.s !== 2);
  const fatalRisk = items.filter((x) => (x.fatal || x.fatalByRule || x.star) && x.s < 2);
  const chips = '<div class="ck-chips">' +
    '<span class="chip chip-ok">完全响应 ' + st.ok + '</span>' +
    '<span class="chip chip-warn">部分响应 ' + st.partial + '</span>' +
    '<span class="chip chip-bad">未响应 ' + st.missing + '</span>' +
    '<span class="chip chip-plain">共 ' + st.total + ' 条</span>' +
    (fatalRisk.length ? '<span class="chip chip-bad">废标/★条款未完全响应 ' + fatalRisk.length + '</span>' : '') +
    (r.overview ? '<span class="ck-ov">' + esc(r.overview) + '</span>' : '') +
  '</div>';

  if (!need.length) {
    return ckFold(key, '招标文件要求逐条对照', chips, '<div class="ck-more muted">' + st.total + ' 条要求全部能在投标文件里找到对应内容。</div>');
  }

  const rowHtml = (x) => {
    const s2 = CK_S[x.s] || CK_S[1];
    const mark = (x.fatal ? '<span class="mk fatal">废标</span>' : '') + (x.star ? '<span class="mk star">★</span>' : '') + (x.fatalByRule && !x.fatal ? '<span class="mk rule">条款含废标后果</span>' : '');
    return '<tr class="req-s' + x.s + '">' +
      '<td class="num">' + x.n + '</td>' +
      '<td><span class="lv ' + s2.cls + '">' + s2.t + '</span></td>' +
      '<td><div class="req-t">' + mark + esc(x.text) + '</div>' +
        '<div class="ck-pg">' + esc(x.secTitle) + (x.page ? ' · 招标第 ' + x.page + ' 页' : '') + '</div></td>' +
      '<td class="ck-d">' + esc(x.note || '') + (x.evidence ? '<div class="req-ev">已出现：' + esc(x.evidence) + '</div>' : '') + '</td>' +
    '</tr>';
  };

  const tbl = (list) => '<table class="ck-tbl req-tbl"><thead><tr><th style="width:52px">序号</th><th style="width:86px">结论</th><th>招标文件要求原文</th><th style="width:30%">差在哪儿 / 怎么补</th></tr></thead><tbody>' +
    list.map(rowHtml).join('') + '</tbody></table>';

  const body = '<div class="ck-flt"><button class="btn tiny active" data-rf="need">只看要改的 ' + need.length + '</button>' +
      '<button class="btn tiny" data-rf="s0">只看未响应 ' + st.missing + '</button>' +
      (fatalRisk.length ? '<button class="btn tiny" data-rf="fatal">只看废标/★未完全响应 ' + fatalRisk.length + '</button>' : '') +
      '<button class="btn tiny" data-rf="all">全部 ' + st.total + '</button></div>' +
    (st.omittedPages ? '<div class="ck-note">这份投标文件较长，另有 ' + st.omittedPages + ' 页没放进本次核对范围，涉及这些页的判断请人工确认。</div>' : '') +
    '<div data-rfbox="need">' + tbl(need) + '</div>' +
    '<div data-rfbox="s0" hidden>' + tbl(items.filter((x) => x.s === 0)) + '</div>' +
    '<div data-rfbox="fatal" hidden>' + tbl(fatalRisk) + '</div>' +
    '<div data-rfbox="all" hidden>' + tbl(items) + '</div>' +
    '<div class="ck-more muted">判断依据是投标文件的实际内容：只有明确写了对应内容、材料或表述才算完全响应；只写「满足」而没有具体内容、或属于装订密封现场递交等电子文件看不出的事项，都按部分响应列出来，提请你在递交时人工确认。</div>';
  return ckFold(key, '招标文件要求逐条对照', chips, body);
}

function ckFold(key, title, summary, body) {
  const open = !!(S.ck && S.ck.folds && S.ck.folds.has(key));
  return '<div class="ck-sec" data-fold-zone="' + esc(key) + '">' +
    '<div class="ck-sec-h"><span class="ck-sec-t">' + title + '</span>' +
      '<span class="ck-sec-s">' + summary + '</span>' +
      '<button class="btn tiny ck-fold-btn" data-fold="' + esc(key) + '">' + (open ? '收起' : '展开') + '</button>' +
    '</div>' +
    '<div class="ck-sec-body"' + (open ? '' : ' hidden') + '>' + body + '</div>' +
  '</div>';
}

function ckDocCard(d) {
  if (d.error) {
    return '<div class="ck-doc"><div class="ck-doc-h"><b>' + esc(d.name) + '</b><span class="tag tag-red">没能检查</span></div>' +
      '<div class="ck-err">' + esc(d.error) + '</div></div>';
  }
  const rows = (d.checks || []).map((c) => {
    const lv = CK_LEVEL[c.level] || CK_LEVEL.warn;
    return '<tr class="row-' + (c.level === 'ok' ? 'ok' : c.level) + '">' +
      '<td><span class="lv ' + lv.cls + '">' + lv.t + '</span></td>' +
      '<td><div class="ck-t">' + esc(c.title) + '</div>' +
        (c.pages && c.pages.length ? '<div class="ck-pg">第 ' + c.pages.slice(0, 12).join('、') + (c.pages.length > 12 ? ' 等' : '') + ' 页</div>' : '') +
      '</td>' +
      '<td class="ck-d">' + esc(c.detail || '') + '</td>' +
      '<td class="ck-s">' + esc(c.suggest || '') + '</td>' +
    '</tr>';
  }).join('');
  const fmt = (d.checks || []).reduce((a, c) => { a[c.level] = (a[c.level] || 0) + 1; return a; }, {});
  const fmtSummary = '<span class="chip chip-plain">共 ' + (d.checks || []).length + ' 项</span>' +
    (fmt.ok ? '<span class="chip chip-ok">通过 ' + fmt.ok + '</span>' : '') +
    (fmt.fatal ? '<span class="chip chip-bad">必须改 ' + fmt.fatal + '</span>' : '') +
    (fmt.warn ? '<span class="chip chip-warn">建议核对 ' + fmt.warn + '</span>' : '');
  return '<div class="ck-doc">' +
    '<div class="ck-doc-h"><b>' + esc(d.name) + '</b>' +
      '<span class="muted">共 ' + d.pages + ' 页 · ' + fmtSize(d.size) + '</span>' +
      (d.fatal ? '<span class="tag tag-red">必须改 ' + d.fatal + '</span>' : '') +
      (d.warn ? '<span class="tag tag-amber">待核对 ' + d.warn + '</span>' : '') +
      (!d.fatal && !d.warn ? '<span class="tag tag-green">全部通过</span>' : '') +
    '</div>' +
    ckFold('fmt:' + d.id, '格式与要素检查', fmtSummary,
      '<table class="ck-tbl"><thead><tr><th style="width:74px">结论</th><th style="width:30%">检查项</th><th>具体情况</th><th style="width:24%">怎么改</th></tr></thead><tbody>' +
      rows + '</tbody></table>') +
    ckReqBlock(d, 'req:' + d.id) +
  '</div>';
}

function ckScoreCard(sc) {
  if (!sc) return '';
  if (sc.error) return '<div class="ck-score"><h4 style="padding:12px 14px;margin:0">模拟评标</h4><div class="ck-err">' + esc(sc.error) + '</div></div>';
  const pct = sc.full ? Math.round((sc.total / sc.full) * 100) : 0;
  const rows = sc.items.map((x) => {
    const p = x.max ? (x.got || 0) / x.max : 0;
    return '<tr><td><b>' + esc(x.name) + '</b></td><td class="num">' + x.max + '</td>' +
      '<td class="num"><b class="' + (p >= 0.85 ? 'c-green' : p >= 0.6 ? 'c-amber' : 'c-red') + '">' + (x.got == null ? '—' : x.got) + '</b></td>' +
      '<td class="ck-d">' + esc(x.reason) + '</td></tr>';
  }).join('');

  const detail = (it) => {
    const bd = (it.breakdown || []).length
      ? '<table class="ck-tbl"><thead><tr><th style="width:26%">得分点要求</th><th style="width:18%">需要的证明材料</th><th style="width:44%">投标文件里 / 判断说明</th><th class="num" style="width:56px">得分</th></tr></thead><tbody>' +
        it.breakdown.map((b) => '<tr class="' + (b.judge === '不得分' ? 'row-fatal' : b.judge === '部分得分' ? 'row-warn' : '') + '">' +
          '<td>' + esc(b.point) + '</td><td class="ck-s">' + esc(b.need) + '</td>' +
          '<td class="ck-d">' + (b.found ? '<span class="tag tag-green">有</span> ' : '<span class="tag tag-red">没有</span> ') +
            esc(b.evidence || '') + (b.page ? '<div class="ck-pg">投标第 ' + b.page + ' 页</div>' : '') +
            (b.note ? '<div class="ck-s">' + esc(b.note) + '</div>' : '') + '</td>' +
          '<td class="num">' + (b.score == null ? '' : b.score) + '</td></tr>').join('') +
        '</tbody></table>'
      : '';
    const lost = (it.lost || []).length
      ? '<div class="ck-sub">失分点与怎么补</div><table class="ck-tbl"><thead><tr><th style="width:24%">失分点</th><th style="width:24%">缺什么</th><th>具体怎么补</th><th class="num" style="width:56px">加分</th></tr></thead><tbody>' +
        it.lost.map((l) => '<tr class="row-warn"><td>' + esc(l.point) + '</td><td class="ck-s">' + esc(l.why) + '</td><td class="ck-d">' + esc(l.fix) + '</td><td class="num">' + (l.gain ? '+' + l.gain : '') + '</td></tr>').join('') +
        '</tbody></table>'
      : '';
    const risk = (it.risk || []).length ? '<div class="ck-risk"><b>评委可能质疑</b>' + it.risk.map((x) => '<div>· ' + esc(x) + '</div>').join('') + '</div>' : '';
    const imp = it.improve ? '<div class="ck-imp">' + esc(it.improve) + '</div>' : '';
    return bd + lost + risk + imp;
  };

  const items = sc.items.map((it, idx) => {
    const p = it.max ? (it.got || 0) / it.max : 0;
    const lostCount = (it.lost || []).length;
    return '<details class="ck-sc-it"' + (idx === 0 ? ' open' : '') + '>' +
      '<summary><b>' + esc(it.name) + '</b>' +
        '<span class="sc-num"><b class="' + (p >= 0.85 ? 'c-green' : p >= 0.6 ? 'c-amber' : 'c-red') + '">' + (it.got == null ? '—' : it.got) + '</b> / ' + it.max + ' 分</span>' +
        (lostCount ? '<span class="tag tag-amber">' + lostCount + ' 个失分点</span>' : '<span class="tag tag-green">无明显失分</span>') +
      '</summary><div class="ck-sc-body">' + detail(it) + '</div></details>';
  }).join('');

  const tips = (sc.tips || []).length
    ? '<div class="ck-tips"><b>提分优先级（按可加分从多到少）</b><ol>' + sc.tips.map((t) =>
        '<li>' + (t.item ? '<span class="tip-item">' + esc(t.item) + '</span>' : '') + esc(t.point || t) +
        (t.fix ? '——' + esc(t.fix) : '') + (t.gain ? '<span class="tag tag-green">+' + t.gain + '</span>' : '') + '</li>').join('') + '</ol></div>'
    : '';

  return '<div class="ck-score">' +
    '<div class="ck-score-h"><h4>二、模拟评标（按评分项逐项拆解）</h4>' +
      '<div class="ck-total">预估 <b class="' + (pct >= 80 ? 'c-green' : pct >= 60 ? 'c-amber' : 'c-red') + '">' + sc.total + '</b> / ' + sc.full + ' 分（' + pct + '%）</div>' +
    '</div>' +
    '<div class="ck-score-body">' +
      (sc.omittedPages ? '<div class="ck-note">投标文件较长，有 ' + sc.omittedPages + ' 页没放进本次评标范围，涉及页码的得分点请人工确认。</div>' : '') +
      '<table class="ck-tbl"><thead><tr><th>评分项</th><th class="num" style="width:56px">满分</th><th class="num" style="width:64px">预估</th><th style="width:44%">得分理由</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<div class="ck-sub" style="margin-top:16px">逐项拆解（点开看每个得分点、证据原句和补法）</div>' +
      items +
    '</div>' + tips +
  '</div>';
}

function viewCheck() {
  const ck = S.ck && S.ck.projectId === S.cur.id ? S.ck : null;
  if (!ck) { loadCheckFor(S.cur.id); return ckLoading(); }
  if (ck.loading) return ckLoading();

  const head = '<div class="ck-top">' +
    '<div class="ck-stat">' +
      '<div class="ck-num">' + (ck.data ? ck.data.fatal : '—') + '<span>必须改</span></div>' +
      '<div class="ck-num amber">' + (ck.data ? ck.data.warn : '—') + '<span>建议核对</span></div>' +
      (ck.data && ck.data.reqTotal ? '<div class="ck-num gray">' + ck.data.reqTotal + '<span>条要求逐条对照</span></div>' : '') +
      (ck.data && ck.data.docs.some((d) => d.req && d.req.stat && d.req.stat.riskyFatal > 0)
        ? '<div class="ck-num amber">' + ck.data.docs.reduce((n, d) => n + ((d.req && d.req.stat && d.req.stat.riskyFatal) || 0), 0) + '<span>废标条款未完全响应</span></div>' : '') +
      '<div class="ck-num gray">' + (ck.data ? ck.data.docs.length : ck.sources.length) + '<span>份文件</span></div>' +
    '</div>' +
    '<div class="ck-btns">' +
      (ck.data ? '<button class="btn" id="btnFoldAll">全部展开</button>' : '') +
      '<button class="btn primary" id="btnRunCheck">' + (ck.data ? '重新核查' : '开始核查') + '</button>' +
      (ck.data ? '<button class="btn" id="btnExportCheck">导出核查报告 Word</button>' : '') +
    '</div>' +
  '</div>';

  if (ck.running) {
    return head + '<div class="card"><div class="ck-run"><span class="loading"></span> <span id="ckMsg">' + esc(ck.msg || '正在核查…') + '</span></div>' +
      '<p class="muted" style="font-size:13px;margin:10px 0 0">核查要用 Word 把每份文件转成 PDF 再逐页读，再让 AI 逐条对照招标要求并逐项模拟评标。' + (ck.hasAnalysis ? '一份大概 2～5 分钟，招标要求越多越久，请耐心等它跑完。' : '一份大约 30 秒～1 分钟。') + '</p></div>';
  }

  const finals = ck.sources.filter((s) => s.final);
  const others = ck.sources.filter((s) => !s.final);
  const srcItem = (s) => '<label class="ck-src-i"><input type="checkbox" data-src="' + esc(s.id) + '"' + (ck.selected.has(s.id) ? ' checked' : '') + '>' +
    '<span class="ck-src-n">' + esc(s.name) + '</span>' +
    (s.origin === 'upload' ? '<span class="tag tag-green">' + esc(s.label || '你上传的最终版') + '</span>'
      : s.origin === 'export' ? '<span class="tag tag-gray">' + esc(s.label || '工作台生成') + '</span>' : '') +
    '<span class="muted">' + fmtSize(s.size) + '</span></label>';
  const srcBox = '<div class="card ck-src">' +
    '<div class="ck-src-h"><b>可以核查的文件</b><span class="muted">默认只勾最终要投的那份：上传过 Word 的以你上传的原件为准，工作台自动生成的草稿不默认核查</span></div>' +
    (ck.sources.length ? '<div class="ck-src-list">' + finals.map(srcItem).join('') + '</div>'
      : '<div class="muted" style="padding:8px 0">还没有可核查的文件。请先到「投标文件」把做好的标书下载成 Word 放回 03制作 文件夹，或直接上传到项目的「04核查」文件夹。</div>') +
    (others.length ? '<details class="ck-src-more"><summary>其他文件（自动生成的草稿 / 历史版本，默认不核查）' + others.length + ' 份</summary>' +
      '<div class="ck-src-list">' + others.map(srcItem).join('') + '</div></details>' : '') +
    (ck.hasAnalysis ? '<div class="ck-note ok">已做招标分析：会把招标文件的每一项要求逐条拿去和投标文件比对，并按评分表逐项拆解模拟打分。印刷、密封、现场递交这几类电子文件看不出的要求会单独标成「部分响应」，提醒你递交时人工确认。</div>' : '<div class="ck-note">还没做招标分析，只能查格式类问题（空白页、页码、封面、占位符）。要做逐条响应比对和模拟评标，请先到「招标分析」跑一次。</div>') +
  '</div>';

  if (!ck.data) {
    return head + srcBox +
      '<div class="placeholder" style="padding:36px 0">' +
        '<div style="font-size:15px;margin-bottom:8px">还没有核查结果</div>' +
        '<div class="muted">勾选上面的文件，点「开始核查」，工作台会逐页检查并给出问题清单。</div>' +
      '</div>';
  }

  const docs = ck.data.docs.map(ckDocCard).join('');
  const sc = (ck.data.docs.find((d) => d.score) || {}).score;
  return head + srcBox +
    '<div class="ck-time muted">上次核查：' + esc(new Date(ck.data.checkAt).toLocaleString('zh-CN')) + '</div>' +
    docs + ckScoreCard(sc);
}

function bindCheckEvents() {
  const run = $('#btnRunCheck');
  if (run) run.onclick = async () => {
    const ids = Array.from(document.querySelectorAll('[data-src]')).filter((x) => x.checked).map((x) => x.dataset.src);
    if (!ids.length) { toast('请先勾选要核查的文件', true); return; }
    try {
      const r = await api('POST', '/api/projects/' + S.cur.id + '/check', { ids });
      if (S.ck) { S.ck.running = true; S.ck.msg = r.message || '正在核查…'; }
      renderProject();
      ckPoll(r.id);
    } catch (e) { toast(e.message, true); }
  };
  const ex = $('#btnExportCheck');
  if (ex) ex.onclick = async () => {
    ex.disabled = true; ex.textContent = '生成中…';
    try {
      const r = await api('POST', '/api/projects/' + S.cur.id + '/check/export');
      openModal('<h3>核查报告已生成</h3><p>已保存到：</p>' +
        '<div class="card" style="background:#f7f9fc"><code style="font-size:13px">D:\\投标工作台\\' + esc(r.relPath.replace(/\//g, '\\')) + '</code></div>' +
        '<div class="modal-foot"><button class="btn" data-close>关闭</button>' +
        '<a class="btn primary" href="/api/download?path=' + encodeURIComponent(r.relPath) + '">下载这份 Word</a></div>');
    } catch (e) { toast(e.message, true); }
    finally { ex.disabled = false; ex.textContent = '导出核查报告 Word'; }
  };
  document.querySelectorAll('[data-fold]').forEach((btn) => {
    btn.onclick = () => {
      const key = btn.dataset.fold;
      const zone = document.querySelector('[data-fold-zone="' + key.replace(/"/g, '\\"') + '"]');
      if (!zone) return;
      const body = zone.querySelector('.ck-sec-body');
      const willOpen = body.hidden;
      body.hidden = !willOpen;
      btn.textContent = willOpen ? '收起' : '展开';
      if (S.ck && S.ck.folds) { if (willOpen) S.ck.folds.add(key); else S.ck.folds.delete(key); }
    };
  });
  const fa = $('#btnFoldAll');
  if (fa) fa.onclick = () => {
    const zones = Array.from(document.querySelectorAll('[data-fold-zone]'));
    const anyClosed = zones.some((z) => z.querySelector('.ck-sec-body').hidden);
    zones.forEach((z) => {
      const body = z.querySelector('.ck-sec-body');
      const btn = z.querySelector('[data-fold]');
      body.hidden = !anyClosed;
      if (btn) btn.textContent = anyClosed ? '收起' : '展开';
      const key = btn && btn.dataset.fold;
      if (key && S.ck && S.ck.folds) { if (anyClosed) S.ck.folds.add(key); else S.ck.folds.delete(key); }
    });
    fa.textContent = anyClosed ? '全部收起' : '全部展开';
  };
  document.querySelectorAll('[data-rf]').forEach((el) => {
    el.onclick = () => {
      const key = el.dataset.rf;
      document.querySelectorAll('[data-rf]').forEach((b) => b.classList.toggle('active', b === el));
      document.querySelectorAll('[data-rfbox]').forEach((b) => { b.hidden = b.dataset.rfbox !== key; });
    };
  });
  document.querySelectorAll('[data-src]').forEach((el) => {
    el.onchange = () => {
      if (!S.ck) return;
      if (el.checked) S.ck.selected.add(el.dataset.src);
      else S.ck.selected.delete(el.dataset.src);
    };
  });
}

function ckPoll(taskId) {
  if (S.ck && S.ck.timer) clearInterval(S.ck.timer);
  if (S.ck) S.ck.taskId = taskId;
  S.ck.timer = setInterval(async () => {
    let t;
    try { t = await api('GET', '/api/check-tasks/' + taskId); t = t.task || t; } catch { return; }
    if (!S.ck || S.ck.taskId !== taskId) { clearInterval(S.ck.timer); return; }
    const m = $('#ckMsg');
    if (m) m.textContent = t.message || '正在核查…';
    if (t.state !== 'running') {
      clearInterval(S.ck.timer);
      S.ck.timer = null;
      S.ck.running = false;
      if (t.state === 'error') toast('核查失败：' + t.message, true);
      else toast(t.message || '核查完成');
      await loadCheckFor(S.cur.id);
    }
  }, 2000);
}

/* ================= 模块5：递交归档 ================= */
S.sb = null;

async function loadSubmitFor(pid) {
  if (S.sb && S.sb.projectId === pid && S.sb.loading) return;
  S.sb = { projectId: pid, loading: true, data: { items: [] }, groups: [] };
  try {
    const r = await api('GET', '/api/projects/' + pid + '/submit');
    S.sb = { projectId: pid, loading: false, data: r.submit, groups: r.groups, openGroup: 'prep' };
    renderProject();
  } catch (e) { toast(e.message, true); S.sb = null; renderProject(); }
}

function viewSubmit() {
  const sb = S.sb && S.sb.projectId === S.cur.id ? S.sb : null;
  if (!sb) { loadSubmitFor(S.cur.id); return ckLoading(); }
  if (sb.loading) return ckLoading();
  const items = sb.data.items || [];
  const done = items.filter((x) => x.done).length;
  const pct = items.length ? Math.round((done / items.length) * 100) : 0;

  let html = '<div class="sb-top">' +
    '<div class="sb-prog"><div class="bar"><div class="bar-in" style="width:' + pct + '%"></div></div>' +
    '<div class="sb-prog-t">已完成 <b>' + done + '</b> / ' + items.length + ' 项（' + pct + '%）</div></div>' +
    '<div class="sb-btns">' +
      '<button class="btn" id="btnSbAdd">+ 加一条</button>' +
      '<button class="btn" id="btnSbRebuild">重新生成清单</button>' +
      '<button class="btn" id="btnSbExport">导出 Word 清单</button>' +
      '<button class="btn primary" id="btnClose">关闭项目并归档</button>' +
    '</div>' +
  '</div>';

  if (!items.length) {
    html += '<div class="placeholder">还没有清单。点「重新生成清单」，工作台会从招标分析结果里自动整理出印刷、签字盖章、密封、递交各步骤。</div>';
    return html;
  }

  for (const g of sb.groups) {
    const list = items.filter((x) => x.group === g.key);
    if (!list.length) continue;
    const gdone = list.filter((x) => x.done).length;
    html += '<div class="sb-group">' +
      '<div class="sb-g-h"><b>' + esc(g.title) + '</b><span class="muted">' + gdone + '/' + list.length + '</span></div>' +
      (g.hint ? '<div class="sb-g-hint">' + esc(g.hint) + '</div>' : '') +
      '<div class="sb-items">' +
      list.map((x) => '<div class="sb-i' + (x.done ? ' done' : '') + '" data-id="' + x.id + '">' +
        '<div class="sb-ck' + (x.done ? ' on' : '') + '" data-toggle="' + x.id + '">' + (x.done ? '✓' : '') + '</div>' +
        '<div class="sb-txt"><div class="sb-t">' + esc(x.title) +
          (x.auto ? '<span class="tag tag-blue">招标文件</span>' : '') +
          (x.page ? '<span class="muted" style="font-size:12px"> 第 ' + x.page + ' 页</span>' : '') +
        '</div>' +
        (x.detail ? '<div class="sb-d">' + esc(x.detail) + '</div>' : '') + '</div>' +
        '<button class="btn tiny" data-edit="' + x.id + '">改</button>' +
        '<button class="btn tiny danger" data-del="' + x.id + '">删</button>' +
      '</div>').join('') +
      '</div></div>';
  }
  return html;
}

function bindSubmitEvents() {
  const sb = S.sb;
  if (!sb) return;
  const post = async (body) => {
    const r = await api('PUT', '/api/projects/' + S.cur.id + '/submit/item', body);
    sb.data = r.submit;
    renderProject();
  };
  document.querySelectorAll('[data-toggle]').forEach((el) => {
    el.onclick = async () => {
      const id = el.dataset.toggle;
      const it = sb.data.items.find((x) => x.id === id);
      try { await post({ op: 'toggle', id, done: !(it && it.done) }); } catch (e) { toast(e.message, true); }
    };
  });
  document.querySelectorAll('[data-del]').forEach((el) => {
    el.onclick = async (ev) => {
      ev.stopPropagation();
      try { await post({ op: 'delete', id: el.dataset.del }); } catch (e) { toast(e.message, true); }
    };
  });
  document.querySelectorAll('[data-edit]').forEach((el) => {
    el.onclick = (ev) => {
      ev.stopPropagation();
      const it = sb.data.items.find((x) => x.id === el.dataset.edit);
      if (!it) return;
      openModal('<h3>修改这一条</h3><div class="grid">' +
        '<div class="field full"><label>要做的事</label><input id="sbT" value="' + esc(it.title) + '"></div>' +
        '<div class="field full"><label>说明（可留空）</label><textarea id="sbD" rows="3">' + esc(it.detail || '') + '</textarea></div>' +
        '</div><div class="modal-foot"><button class="btn" data-close>取消</button><button class="btn primary" id="sbOK">保存</button></div>');
      $('#sbOK').onclick = async () => {
        try {
          await post({ op: 'upsert', item: { id: it.id, title: $('#sbT').value.trim(), detail: $('#sbD').value.trim(), group: it.group } });
          closeModal();
        } catch (e) { toast(e.message, true); }
      };
    };
  });
  const add = $('#btnSbAdd');
  if (add) add.onclick = () => {
    openModal('<h3>加一条要做的事</h3><div class="grid">' +
      '<div class="field full"><label>要做的事</label><input id="sbT" placeholder="例如：去公司盖骑缝章"></div>' +
      '<div class="field full"><label>说明（可留空）</label><textarea id="sbD" rows="3" placeholder="可留空"></textarea></div>' +
      '<div class="field full"><label>放在哪一步</label><select id="sbG">' +
        sb.groups.map((g) => '<option value="' + g.key + '">' + esc(g.title) + '</option>').join('') + '</select></div>' +
      '</div><div class="modal-foot"><button class="btn" data-close>取消</button><button class="btn primary" id="sbOK">加上</button></div>');
    $('#sbOK').onclick = async () => {
      try {
        await post({ op: 'upsert', item: { title: $('#sbT').value.trim() || '新事项', detail: $('#sbD').value.trim(), group: $('#sbG').value } });
        closeModal();
      } catch (e) { toast(e.message, true); }
    };
  };
  const rb = $('#btnSbRebuild');
  if (rb) rb.onclick = async () => {
    const done = sb.data.items.filter((x) => x.done).length;
    openModal('<h3>重新生成清单</h3><p>会按最新的招标分析结果重排整份清单。' +
      (done ? '<br>你已经勾掉的 <b>' + done + '</b> 项，只要标题没变，勾选状态会保留。' : '') +
      '<br>你自己手动加的条目会丢掉。</p>' +
      '<div class="modal-foot"><button class="btn" data-close>取消</button><button class="btn primary" id="okRb">重新生成</button></div>');
    $('#okRb').onclick = async () => {
      try {
        const r = await api('POST', '/api/projects/' + S.cur.id + '/submit/rebuild');
        sb.data = r.submit;
        closeModal();
        renderProject();
        toast('清单已重新生成');
      } catch (e) { toast(e.message, true); }
    };
  };
  const ex = $('#btnSbExport');
  if (ex) ex.onclick = async () => {
    ex.disabled = true; ex.textContent = '生成中…';
    try {
      const r = await api('POST', '/api/projects/' + S.cur.id + '/submit/export');
      openModal('<h3>行动清单已生成</h3><p>已保存到：</p>' +
        '<div class="card" style="background:#f7f9fc"><code style="font-size:13px">D:\\投标工作台\\' + esc(r.relPath.replace(/\//g, '\\')) + '</code></div>' +
        '<p class="muted" style="font-size:13px">建议打印一份带在身上，每完成一项打一个勾。</p>' +
        '<div class="modal-foot"><button class="btn" data-close>关闭</button>' +
        '<a class="btn primary" href="/api/download?path=' + encodeURIComponent(r.relPath) + '">下载这份 Word</a></div>');
    } catch (e) { toast(e.message, true); }
    finally { ex.disabled = false; ex.textContent = '导出 Word 清单'; }
  };
  const cl = $('#btnClose');
  if (cl) cl.onclick = () => { closeProjectDialog(); };
}

function closeProjectDialog() {
  const sb = S.sb;
  const done = sb.data.items.filter((x) => x.done).length;
  const all = sb.data.items.length;
  openModal('<h3>关闭项目并归档</h3>' +
    '<p>关闭后，这个项目会从「我的项目」移到「已归档」，同时把招标文件、分析结果、投标文件、核查报告、递交清单整套复制到：</p>' +
    '<div class="card" style="background:#f7f9fc"><code style="font-size:13px">D:\\投标工作台\\归档\\' + new Date().getFullYear() + '\\&lt;招标编号_项目名&gt;\\</code></div>' +
    '<p class="muted" style="font-size:13px">归档后还能打开查看、也能重新打开继续编辑，不会删掉任何东西。</p>' +
    (done < all ? '<p class="warn-text">递交清单还有 ' + (all - done) + ' 项没勾，确认已经递交了吗？</p>' : '') +
    '<div class="grid"><div class="field full"><label>关闭说明（可留空，会写进归档文件夹）</label>' +
    '<textarea id="clNote" rows="2" placeholder="例如：已中标 / 未中标，报价 32 万"></textarea></div></div>' +
    '<div class="modal-foot"><button class="btn" data-close>取消</button><button class="btn primary" id="okClose">关闭并归档</button></div>');
  $('#okClose').onclick = async () => {
    const btn = $('#okClose');
    btn.disabled = true; btn.textContent = '归档中…';
    try {
      const r = await api('POST', '/api/projects/' + S.cur.id + '/close', { note: $('#clNote').value.trim() });
      closeModal();
      await refreshProjects();
      openModal('<h3>已归档</h3><p>项目已关闭，全部资料已归档到：</p>' +
        '<div class="card" style="background:#f7f9fc"><code style="font-size:13px">' + esc(r.dir) + '</code></div>' +
        '<p class="muted" style="font-size:13px">共 ' + r.files + ' 个文件。以后要在别的标书里复用，直接去这个文件夹找。</p>' +
        '<div class="modal-foot"><button class="btn primary" data-close>知道了</button></div>');
      S.tab = 'info';
      await openProject(S.cur.id, true);
    } catch (e) {
      btn.disabled = false; btn.textContent = '关闭并归档';
      toast(e.message, true);
    }
  };
}

/* ================= 模块6：归档列表 ================= */
async function renderArchiveList() {
  let d;
  try { d = await api('GET', '/api/archives'); } catch (e) {
    $('#main').innerHTML = '<div class="page"><div class="placeholder">读取归档失败：' + esc(e.message) + '</div></div>';
    return;
  }
  const list = d.archives || [];
  const head = '<div class="page-head"><div><div class="page-title">已归档的项目</div>' +
    '<div class="page-sub">关闭的项目都在这里，资料存在 D 盘，随时可以打开文件夹查看</div></div></div>';
  const body = !list.length
    ? '<div class="placeholder">还没有归档的项目。在「递交归档」页点「关闭项目并归档」就会出现在这里。</div>'
    : '<div class="arch-list">' + list.map((a) =>
        '<div class="arch-i"><div class="arch-h"><b>' + esc(a.name) + '</b>' +
          (a.check && a.check.verdict === 'red' ? '<span class="tag tag-red">核查有问题</span>' : '') +
          (a.check && a.check.verdict === 'green' ? '<span class="tag tag-green">全部通过</span>' : '') +
        '</div>' +
        '<div class="arch-m">' + esc(a.code || '') + (a.owner ? ' · ' + esc(a.owner) : '') + (a.budget ? ' · 预算 ' + esc(a.budget) : '') + '</div>' +
        '<div class="arch-p">' + esc(a.path) + '</div>' +
        '<div class="arch-a"><span class="muted">归档于 ' + esc(String(a.archivedAt).slice(0, 10)) + '</span>' +
        '<button class="btn tiny" data-reveal="' + esc(a.path) + '">打开文件夹</button></div></div>').join('') + '</div>';
  $('#main').innerHTML = '<div class="page">' + head + body + '</div>';
  document.querySelectorAll('[data-reveal]').forEach((b) => {
    b.onclick = async () => {
      try { await api('POST', '/api/reveal', { path: b.dataset.reveal }); }
      catch (e) { toast(e.message, true); }
    };
  });
}

/* ---------- 启动 ---------- */
async function loadHealth() {
  try {
    S.health = await api('GET', '/api/health');
    $('#companyHint').textContent = S.health.hasKey ? (S.health.company || '本地版 · AI 已连接') : '本地版 · 未配置 AI';
  } catch (e) {
    $('#companyHint').textContent = '连接不上后台服务';
  }
}

async function boot() {
  $('#btnNew').onclick = newProjectDialog;
  $('#btnSettings').onclick = settingsDialog;
  $('#btnArchived').onclick = async () => {
    S.archived = !S.archived;
    $('#btnArchived').textContent = S.archived ? '返回项目列表' : '查看已归档';
    await refreshProjects();
    if (S.archived) {
      try { await renderArchiveList(); } catch (e) { toast(e.message, true); }
    } else {
      await refreshProjects();
    }
  };
  await loadHealth();
  try { await refreshProjects(); } catch (e) { toast('读取项目列表失败：' + e.message, true); }
  // 支持刷新后回到原项目
  const m = /^#\/p\/([^/]+)(?:\/([a-z]+))?/.exec(location.hash || '');
  if (m) {
    S.tab = m[2] || 'info';
    try { await openProject(decodeURIComponent(m[1]), true); } catch (e) {}
  }
  window.addEventListener('hashchange', () => {
    const mm = /^#\/p\/([^/]+)(?:\/([a-z]+))?/.exec(location.hash || '');
    if (mm && (!S.cur || S.cur.id !== decodeURIComponent(mm[1]))) openProject(decodeURIComponent(mm[1]), true);
  });
  // 每分钟刷新倒计时
  setInterval(() => { if (S.cur) renderSidebar(); }, 60000);
}

boot();