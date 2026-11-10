/* 投标业务工作台 - 前端 */
const S = {
  health: null,
  settings: null,
  projects: [],
  cur: null,      // 当前项目详情
  tab: 'info',
  busy: '',
  archived: false,
  projKw: '',      // v1.1.3：侧栏项目查找关键词
  archKw: ''       // v1.1.3：归档页查找关键词
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
// 数据根目录（来自 /api/health 的 root），用于界面上显示文件保存位置；不写死盘符
function rootPath() {
  const r = (S.health && S.health.root) || '';
  return String(r).replace(/[\\/]+$/, '');
}

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
/* v1.1.3：项目查找 —— 匹配名称、招标编号、招标人、内部编号、代理机构 */
function projMatch(p, kw) {
  if (!kw) return true;
  const s = [p.name, p.code, p.owner, p.autoCode, p.agency].map((x) => String(x || '')).join(' ').toLowerCase();
  return s.includes(kw);
}

/* v1.1.3：按投标截止日期由近到远排（没填截止的排最后） */
function deadlineTs(v) {
  const s = String(v || '').replace('T', ' ').replace(/\//g, '-').trim();
  if (!s) return 0;
  const d = new Date(s.replace(' ', 'T'));
  return isNaN(d.getTime()) ? 0 : d.getTime();
}
function sortByDeadline(list) {
  return list.slice().sort((x, y) => {
    const a = deadlineTs(x.bidDeadline), b = deadlineTs(y.bidDeadline);
    if (!a && !b) return String(x.name || '').localeCompare(String(y.name || ''));
    if (!a) return 1;
    if (!b) return -1;
    return a - b;
  });
}

function renderSidebar() {
  const list = $('#projectList');
  const kw = String((S.projKw || '')).trim().toLowerCase();
  const all = S.projects.filter((p) => (S.archived ? p.status === 'archived' : p.status !== 'archived'));
  const rows = sortByDeadline(all).filter((p) => projMatch(p, kw));
  if (!rows.length) {
    list.innerHTML = '<div class="muted" style="padding:10px;font-size:13px">' +
      (kw ? '没有匹配「' + esc(S.projKw) + '」的项目' : (S.archived ? '还没有归档的项目' : '还没有项目，点上面「新建项目」开始')) + '</div>';
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

/* v1.1.4：默认启动页（首页） */
function renderHome() {
  const projs = (S.projects || []).filter((x) => x.status !== 'archived');
  const recent = projs.slice(0, 4);
  const cards = recent.map((x) => {
    const left = fmtLeft(x.bidDeadline);
    const dotCls = left.cls === 'c-red' ? '#d1242f' : left.cls === 'c-amber' ? '#bf8700' : left.cls === 'c-done' ? '#8a9099' : '#1a7f37';
    return '<div class="home-proj" data-pid="' + x.id + '">' +
      '<div class="hp-name">' + esc(x.name) + '</div>' +
      '<div class="hp-meta">' + esc(x.code || x.autoCode || '') +
        '<span><span class="dot" style="background:' + dotCls + '"></span>' +
        (left.cls === 'c-done' ? '已截止' : left.big === '未设置' ? '无截止' : left.big.replace('剩 ', '剩 ')) + '</span></div>' +
      '</div>';
  }).join('');

  $('#main').innerHTML = '<div class="page home">' +
    '<div class="home-hero">' +
      '<div class="home-title">投标业务工作台</div>' +
      '<div class="home-sub">从招标文件到递交归档，一条线走完。</div>' +
      '<div class="home-acts">' +
        '<button class="home-act primary" id="homeNew"><div class="ha-ico">＋</div>' +
          '<div class="ha-t">新建项目</div><div class="ha-d">从招标文件开始，走完整流程：分析 → 编制 → 核查 → 递交 → 归档</div></button>' +
        '<button class="home-act" id="homeBackfill"><div class="ha-ico">⇪</div>' +
          '<div class="ha-t">项目补录</div><div class="ha-d">投完的老项目，传招标文件和投标文件，自动分析并归档进知识库</div></button>' +
      '</div>' +
    '</div>' +
    (recent.length ? '<div class="home-recent"><div class="home-recent-h">最近的 ' + recent.length + ' 个项目</div>' +
      '<div class="home-projs">' + cards + '</div></div>' : '') +
    '<div class="home-tip muted">所有资料都存在本地 ' + esc(rootPath()) + ' 目录里，不联网也能打开（只有 AI 分析需要联网）。</div>' +
    '</div>';

  const b1 = $('#homeNew');
  if (b1) b1.onclick = newProjectDialog;
  const b2 = $('#homeBackfill');
  if (b2) b2.onclick = backfillDialog;
  document.querySelectorAll('.home-proj').forEach((el) => {
    el.onclick = () => openProject(el.dataset.pid);
  });
}

/* v1.1.4：回到默认启动页（关闭归档 / 点「关闭页面」都走这里，不删任何数据） */
function goHome() {
  // v1.1.5：只清「当前页面」的状态，不动正在跑的任务（进度在左侧任务条里继续显示）
  S.cur = null;
  S.tab = 'info';
  S.df = null;
  S.an = null;
  S.ck = null;
  S.sb = null;
  history.replaceState(null, '', '#/');
  renderHome();
  renderSidebar();
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
      '<div class="page-head-r">' +
        '<div class="clock ' + left.cls + '"><div class="dl">' + (left.urgent ? '⚠ 临近截止' : '距投标截止') + '</div>' +
          '<div class="big">' + esc(left.big) + '</div><div class="dl">' + esc(left.sub) + '</div></div>' +
        '<button class="btn tiny page-close" id="btnClosePage" title="关掉这个项目页面，回到首页（不会删任何数据）">✕ 关闭页面</button>' +
      '</div>' +
    '</div>';

  const body = S.tab === 'info' ? viewInfo()
    : S.tab === 'tender' ? viewTender()
    : S.tab === 'analysis' ? viewAnalysis()
    : S.tab === 'draft' ? viewDraft()
    : S.tab === 'check' ? viewCheck()
    : S.tab === 'submit' ? viewSubmit()
    : viewSoon();

  const roBanner = p.status === 'archived'
    ? '<div class="ro-banner">🔒 本项目已于 ' + esc(String(p.closedAt || '').replace('T', ' ').slice(0, 16)) + ' 关闭归档，现在只能查看。' +
      (p.closedBy === 'abandon' ? '（放弃投标' + (p.abandonReason ? '：' + esc(p.abandonReason) : '') + '）' : '') +
      ' 要修改请点［重新打开］。' +
      '<button class="btn tiny" data-ro-reopen="' + esc(p.id) + '">重新打开</button></div>'
    : '';
  $('#main').innerHTML = '<div class="page">' + head + roBanner + '<div class="tabs">' + tabs + '</div><div id="tabBody">' + body + '</div></div>';
  const roBtn = $('#main').querySelector('[data-ro-reopen]');
  if (roBtn) roBtn.onclick = () => reopenProject(roBtn.dataset.roReopen);
  const closePg = $('#btnClosePage');
  if (closePg) closePg.onclick = goHome;


  $('#main').querySelectorAll('.tab').forEach((el) => {
    el.onclick = () => { S.tab = el.dataset.tab; renderProject(); syncHash(); };
  });
  bindTabEvents();
}

function viewSoon() {
  return '<div class="placeholder">这个模块还在做。先把「项目信息」和「招标文件」用好，后面几块会陆续开放。</div>';
}


/* ---------- v1.1.2 独立编制：开一个独立窗口 ---------- */
function openIndep(cid, docKey) {
  if (!S.cur) return;
  const w = 1360;
  const h = 900;
  const left = Math.max(0, Math.round((screen.availWidth - w) / 2));
  const top = Math.max(0, Math.round((screen.availHeight - h) / 2));
  const url = '/indep.html?p=' + encodeURIComponent(S.cur.id) + '&d=' + encodeURIComponent(docKey) + '&c=' + encodeURIComponent(cid);
  const win = window.open(url, 'twb-indep-' + cid,
    'width=' + w + ',height=' + h + ',left=' + left + ',top=' + top + ',resizable=yes,scrollbars=yes');
  if (!win) {
    toast('浏览器拦了新窗口，请允许弹出窗口，或者按住 Ctrl 再点一次', true);
    return;
  }
  win.focus();
  // 独立窗口里可能写回正文 / 导出 Word，关掉后刷新一下当前页
  const timer = setInterval(() => {
    if (win.closed) {
      clearInterval(timer);
      reloadDraft().catch(() => {});
    }
  }, 1200);
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
  const ro = p.status === 'archived';
  const fields = FIELD_DEFS.map(([k, label, type, full]) => {
    if (type === 'readonly') {
      return '<div class="field"><label>' + label + '</label><input value="' + esc(p[k] || '') + '" readonly></div>';
    }
    const hint = type === 'datetime' ? '<div class="hint">格式：2026-12-31 09:30</div>' : '';
    const input = type === 'textarea'
      ? '<textarea rows="3" data-k="' + k + '"' + (ro ? ' readonly' : '') + ' placeholder="可留空">' + esc(p[k] || '') + '</textarea>'
      : '<input data-k="' + k + '"' + (ro ? ' readonly' : '') + ' value="' + esc(p[k] || '') + '" placeholder="' + (type === 'datetime' ? '2026-12-31 09:30' : '可留空') + '">';
    return '<div class="field' + (full === 'full' ? ' full' : '') + '"><label>' + label + '</label>' + input + hint + '</div>';
  }).join('');

  const events = (S.cur.events || []).slice(0, 12).map((e) =>
    '<tr><td style="width:150px;color:#8a9099">' + esc(new Date(e.createdAt).toLocaleString('zh-CN')) + '</td><td>' + esc(e.message) + '</td></tr>'
  ).join('');

  return '<div class="card"><h3>项目基本信息</h3><div class="grid">' + fields + '</div>' +
    '<div class="row" style="margin-top:16px">' +
    (ro
      ? '<span class="muted" style="font-size:13px">项目已关闭归档，信息只能查看。要改请点上面的「重新打开」。</span>'
      : '<button class="btn primary" id="btnSaveInfo">保存修改</button>' +
        '<span class="muted" style="font-size:13px">信息可以随时改。资料不全没关系，先把知道的填上。</span>') +
    '</div></div>' +
    '<div class="card"><h3>最近操作</h3>' +
    (events ? '<table class="list">' + events + '</table>' : '<div class="muted">还没有操作记录</div>') + '</div>' +
    '<div class="card" id="procCard"><h3>过程记录</h3><div class="muted">正在读取…</div></div>' +
    (ro ? '' : '<div class="card"><h3>危险操作</h3><div class="row"><button class="btn danger" id="btnDelete">删除这个项目</button>' +
    '<span class="muted" style="font-size:13px">会把 D 盘里这个项目的文件夹一并删掉，删了找不回来。</span></div></div>');
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
    '<div id="extractErr" style="margin-top:12px"></div>' +
    '</div>';
}


/* ================= 页签：招标分析 ================= */
S.an = null; // {projectId, data, loading, section, redOnly, running, task}
S.anFail = null; // 上一次分析失败的任务（用于在页面上给出「安装识别工具」的引导）

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
      S.anFail = t.state === 'failed' ? Object.assign({ projectId: pid }, t) : null;
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
    const af = S.anFail && S.anFail.projectId === cur.id ? S.anFail : null;
    if (af) {
      const noTool = af.errorCode === 'NO_OCR_TOOL';
      const ocrEmpty = af.errorCode === 'OCR_EMPTY';
      return '<div class="card"><h3>这份招标文件没能自动读出来</h3>' +
        '<p class="muted" style="margin-top:0;font-size:13px;max-width:660px">' + esc(af.error || '') + '</p>' +
        (noTool ? '<div class="ocr-guide" id="ocrGuide"><div class="og-t">这台电脑还没有装文字识别工具</div>' +
          '<div class="og-p">扫描件是图片，没有文字识别工具就读不出里面的字。装一个就能自动识别，以后所有扫描件都能读。大约几十 MB，只装一次。</div>' +
          '<div class="row"><button class="btn primary" id="btnInstallOcr">安装识别工具</button>' +
          '<span class="muted" id="ocrInstallMsg" style="font-size:13px"></span></div></div>' : '') +
        (ocrEmpty ? '<div class="ocr-guide"><div class="og-t">这台电脑的识别工具也没读出来</div>' +
          '<div class="og-p">可能是扫描件太模糊、倾斜，或者整页是手写/表格。可以换一份更清楚的扫描件重传，或者到「招标文件」页签点「看内容」挑页手动识别。</div></div>' : '') +
        '<div class="row" style="margin-top:14px"><button class="btn" id="btnRetryAnalysis">再试一次</button>' +
        '<button class="btn" id="btnGoTender2">去招标文件页看看</button></div></div>';
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

/* ---- v1.1.4：装完识别工具自动重读 ---- */
async function installOcrFromPage(btn, msgEl) {
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="loading"></span> 正在安装…'; }
  const say = (t) => { if (msgEl) msgEl.textContent = t; };
  say('正在下载安装包，大约几十 MB，请保持联网…');
  try {
    const r = await api('POST', '/api/ocr/install', {});
    if (!r.ok) throw new Error(r.error || '安装失败');
    say('装好了，正在重新识别…');
    if (btn) { btn.textContent = '装好了'; btn.disabled = true; }
    S.anFail = null;
    setTimeout(() => startAnalysis(true), 800);
  } catch (e) {
    say('安装失败：' + e.message + '（也可以手动装一个 Tesseract-OCR，装完回来再试一次）');
    if (btn) { btn.disabled = false; btn.textContent = '重新安装'; }
  }
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
  const btnGoTender2 = $('#btnGoTender2');
  if (btnGoTender2) btnGoTender2.onclick = () => { S.tab = 'tender'; renderProject(); syncHash(); };
  const btnRetry = $('#btnRetryAnalysis');
  if (btnRetry) btnRetry.onclick = () => { S.anFail = null; startAnalysis(true); };
  const btnInsOcr = $('#btnInstallOcr');
  if (btnInsOcr) btnInsOcr.onclick = () => installOcrFromPage(btnInsOcr, $('#ocrInstallMsg'));

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
      '<div class="card" style="background:#f7f9fc"><code style="font-size:13px">' + esc(rootPath() + '\\' + r.relPath.replace(/\//g, '\\')) + '</code></div>' +
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
    loadProcessCard();
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

async function loadProcessCard() {
  const box = $('#procCard');
  if (!box || !S.cur) return;
  try {
    const d = await api('GET', '/api/projects/' + S.cur.id + '/process');
    const list = (d.entries || []).slice(-40).reverse();
    box.innerHTML = '<h3>过程记录 <span class="muted" style="font-size:12px;font-weight:400">（关闭归档时会一起进归档文件夹的 06过程记录）</span></h3>' +
      '<div class="row" style="margin-bottom:10px"><button class="btn tiny" id="btnAddProc">记一笔</button></div>' +
      (list.length
        ? '<table class="list">' + list.map((e) =>
            '<tr><td style="width:150px;color:#8a9099;white-space:nowrap">' + esc(String(e.at || '').replace('T', ' ').slice(0, 16)) + '</td>' +
            '<td><b>' + esc(e.title) + '</b>' + (e.detail ? '<div class="muted" style="font-size:12px;white-space:pre-wrap">' + esc(String(e.detail).slice(0, 400)) + '</div>' : '') + '</td></tr>'
          ).join('') + '</table>'
        : '<div class="muted">还没有记录。上传招标文件、做分析、写标书这些动作会自动记在这里，也可以自己补一笔。</div>');
    const b = $('#btnAddProc');
    if (b) b.onclick = addProcessNote;
  } catch (e) {
    box.innerHTML = '<h3>过程记录</h3><div class="muted">读取失败：' + esc(e.message) + '</div>';
  }
}

function addProcessNote() {
  openModal('<h3>记一笔过程</h3>' +
    '<div class="grid"><div class="field full"><label>做了什么</label><input id="pcTitle" placeholder="例如：和甲方确认了交付时间"></div>' +
    '<div class="field full"><label>细节（可留空）</label><textarea id="pcDetail" rows="3"></textarea></div></div>' +
    '<div class="modal-foot"><button class="btn" data-close>取消</button><button class="btn primary" id="okProc">保存</button></div>');
  $('#okProc').onclick = async () => {
    const title = $('#pcTitle').value.trim();
    if (!title) { toast('写一句做了什么', true); return; }
    try {
      await api('POST', '/api/projects/' + S.cur.id + '/process', { kind: 'note', title, detail: $('#pcDetail').value.trim() });
      closeModal(); toast('已记录'); loadProcessCard();
    } catch (e) { toast(e.message, true); }
  };
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
    msg.innerHTML = '';
    const box = $('#extractErr');
    if (box) box.innerHTML = /识别文字失败|扫描件|OCR/.test(e.message) ? ocrErrorCard(e.message) : '<span style="color:#b6242e">' + esc(e.message) + '</span>';
    const bi = $('#btnInstallOcr2');
    if (bi) bi.onclick = () => installOcrFromPage(bi, $('#ocrInstallMsg2'));
  } finally {
    btn.disabled = false;
    btn.textContent = '开始自动识别';
  }
}

function ocrErrorCard(errText) {
  return '<div class="ocr-guide" id="ocrGuide"><div class="og-t">这份文件读不出文字</div>' +
    '<div class="og-p">' + esc(errText || '') + '</div>' +
    '<div class="og-p">如果是扫描件（整页是图片），装一个文字识别工具就能自动读。大约几十 MB，只装一次。</div>' +
    '<div class="row"><button class="btn primary" id="btnInstallOcr2">安装识别工具</button>' +
    '<span class="muted" id="ocrInstallMsg2" style="font-size:13px"></span></div></div>';
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
// v1.1.5：弹窗可以「锁死」——正在跑任务时，点遮罩、按 Esc、点取消都关不掉，
// 只能走显式的二次确认，避免用户一失手就把正在跑的任务界面弄丢。
let MODAL_LOCK = false;

function openModal(html, opt) {
  const o = opt || {};
  $('#modal').innerHTML = html;
  $('#modalMask').classList.add('on');
  MODAL_LOCK = !!o.lock;
  $('#modalMask').classList.toggle('locked', MODAL_LOCK);
  $('#modal').querySelectorAll('[data-close]').forEach((b) => {
    b.onclick = () => { if (MODAL_LOCK) { toast('任务正在跑，先等它跑完（或者点「停止任务」）', true); return; } closeModal(); };
  });
  return $('#modal');
}
function closeModal(force) {
  if (MODAL_LOCK && !force) { toast('任务正在跑，先等它跑完（或者点「停止任务」）', true); return; }
  MODAL_LOCK = false;
  $('#modalMask').classList.remove('on');
  $('#modalMask').classList.remove('locked');
  $('#modal').innerHTML = '';
}
function setModalLock(on) {
  MODAL_LOCK = !!on;
  $('#modalMask').classList.toggle('locked', MODAL_LOCK);
}
$('#modalMask') && ($('#modalMask').onclick = (e) => { if (e.target.id === 'modalMask') closeModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#modalMask').classList.contains('on')) return;
  closeModal();
});

/* ---------- v1.1.5：全局任务中心（切页面、回首页都不丢进度） ---------- */
const TASK_KIND_URL = {
  analysis: (id) => '/api/tasks/' + id,
  check: (id) => '/api/check-tasks/' + id,
  draft: (id) => '/api/draft-tasks/' + id,
  backfill: (id) => '/api/backfill/' + id,
  cards: (id) => '/api/card-tasks/' + id
};
const TASK_KIND_PAGE = { analysis: 'analysis', check: 'check', draft: 'draft', backfill: '', cards: '' };

let TASKS = { list: [], timer: null };

async function pollActiveTasks() {
  let d;
  try { d = await api('GET', '/api/tasks/active'); } catch { return; }
  const list = (d && d.tasks) || [];
  const before = TASKS.list.map((t) => t.kind + ':' + t.id).join(',');
  const after = list.map((t) => t.kind + ':' + t.id).join(',');
  TASKS.list = list;
  renderTaskBar();
  // 任务跑完了：如果当前就在这个项目的对应页面，刷新一下把结果显示出来
  if (before !== after) {
    list.forEach((t) => { /* 仍在跑的不用管 */ });
    if (S.cur && S.tab) {
      const mine = list.find((t) => t.projectId === S.cur.id && TASK_KIND_PAGE[t.kind] === S.tab);
      if (!mine) resyncCurrentPage();
    }
  }
}

// 任务状态变了就重新拉一次当前页数据（分析/核查/编制各有自己的加载函数）
function resyncCurrentPage() {
  if (!S.cur) return;
  if (S.tab === 'analysis') { S.an = null; loadAnalysisFor(S.cur.id); }
  else if (S.tab === 'draft') { S.df = null; loadDraftFor(S.cur.id); }
  else if (S.tab === 'check') { S.ck = null; loadCheckFor(S.cur.id); }
}

function renderTaskBar() {
  const box = $('#taskBar');
  if (!box) return;
  const list = TASKS.list || [];
  if (!list.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
  box.style.display = 'block';
  box.innerHTML = '<div class="task-bar-h"><span class="spin"></span>' + list.length + ' 个任务正在跑（点一下去看）</div>' + list.map((t) => {
    const pct = t.total ? Math.min(99, Math.round(((t.step || 0) / t.total) * 100)) : 30;
    return '<div class="task-item" data-taskkind="' + esc(t.kind) + '" data-taskproj="' + esc(t.projectId || '') + '">' +
      '<div class="task-top"><span class="task-kind">' + esc(t.kindLabel || '任务') + '</span>' +
      '<span class="task-proj">' + esc(t.projectName || '') + '</span></div>' +
      '<div class="task-bar-in"><i style="width:' + pct + '%"></i></div>' +
      '<div class="task-msg">' + esc(t.message || '正在处理…') + '</div>' +
      '</div>';
  }).join('');
  box.querySelectorAll('.task-item').forEach((el) => {
    el.onclick = () => {
      const pid = el.dataset.taskproj;
      if (pid) openProject(pid);
    };
  });
}

function startTaskPolling() {
  if (TASKS.timer) return;
  pollActiveTasks();
  TASKS.timer = setInterval(pollActiveTasks, 4000);
}

/* ---------- v1.1.5：心跳 + 关掉网页自动关服务 ---------- */
function clientId() {
  try {
    let id = localStorage.getItem('twb_client_id');
    if (!id) { id = 'c_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); localStorage.setItem('twb_client_id', id); }
    return id;
  } catch { return 'c_' + Math.random().toString(36).slice(2, 10); }
}

function startHeartbeat() {
  const cid = clientId();
  const beat = () => {
    try { fetch('/api/heartbeat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: cid }), keepalive: true }); } catch {}
  };
  beat();
  setInterval(beat, 15000);
  window.addEventListener('pagehide', () => {
    try {
      const b = new Blob([JSON.stringify({ clientId: cid })], { type: 'application/json' });
      if (navigator.sendBeacon) navigator.sendBeacon('/api/client-leave', b);
    } catch {}
  });
  // 关标签页时如果还有任务在跑，给个提示（浏览器允许的话）
  window.addEventListener('beforeunload', (e) => {
    if ((TASKS.list || []).length) { e.preventDefault(); e.returnValue = ''; return ''; }
  });
}

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
    '<label class="chk-row"><input type="checkbox" id="npBackfill"> <span>这是<b>补录项目</b>（已经投完/早已过截止，只是补建个档）</span></label>' +
    '<div class="hint" style="margin:-6px 0 8px 26px">补录项目不受「投标截止前不能关闭归档」的限制，建好就能直接归档。</div>' +
    '<div class="modal-foot"><button class="btn" data-close>取消</button><button class="btn primary" id="okNew">创建</button></div>');
  $('#okNew').onclick = async () => {
    const name = $('#npName').value.trim();
    if (!name) { toast('请填项目名称', true); return; }
    try {
      const r = await api('POST', '/api/projects', {
        name, code: $('#npCode').value.trim(), bidDeadline: $('#npDeadline').value.trim(),
        owner: $('#npOwner').value.trim(), budget: $('#npBudget').value.trim(),
        isBackfill: $('#npBackfill').checked
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

/* ---------- v1.1.4 项目补录：传两份文件，自动分析并归档 ---------- */
let BF = null;

function bfFilesHtml(list, kind) {
  if (!list || !list.length) {
    return '<div class="bf-none">还没有文件</div>';
  }
  return list.map((f, i) => '<div class="bf-file">' +
    '<span class="bf-fname">' + esc(f.name) + '</span>' +
    '<span class="bf-fsize">' + fmtSize(f.size) + '</span>' +
    '<span class="bf-fok">✓</span>' +
    '<button class="bf-fdel" data-bfdel="' + kind + '" data-i="' + i + '">移除</button>' +
    '</div>').join('');
}

function bfRenderDrop(zoneId, kind, multi) {
  const box = $('#' + zoneId);
  if (!box) return;
  const list = kind === 'tender' ? (BF.tender ? [BF.tender] : []) : BF.bids;
  box.classList.toggle('has', list.length > 0);
  const tip = $('#' + zoneId + 'Tip');
  if (tip) tip.innerHTML = bfFilesHtml(list, kind);
  box.querySelectorAll('[data-bfdel]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      const i = Number(b.dataset.i);
      if (kind === 'tender') BF.tender = null; else BF.bids.splice(i, 1);
      bfRenderDrop(zoneId, kind, multi);
      bfRefreshBtn();
    };
  });
}

function bfRefreshBtn() {
  const b = $('#bfGo');
  if (!b) return;
  const ok = !!(BF && BF.tender && BF.bids.length);
  b.disabled = !ok || !!BF.busy;
  b.textContent = BF && BF.busy ? '正在分析并归档…' : '分析并归档';
}

function bfBindDrop(zoneId, kind, multi) {
  const box = $('#' + zoneId);
  if (!box) return;
  const input = $('#' + zoneId + 'Input');
  box.onclick = () => { if (BF && !BF.busy) input.click(); };
  input.onchange = () => { if (input.files && input.files.length) bfAddFiles(kind, Array.prototype.slice.call(input.files)); input.value = ''; };
  box.ondragover = (e) => { e.preventDefault(); box.classList.add('hot'); };
  box.ondragleave = () => box.classList.remove('hot');
  box.ondrop = (e) => {
    e.preventDefault();
    box.classList.remove('hot');
    if (!BF || BF.busy) return;
    const fs2 = Array.prototype.slice.call(e.dataTransfer.files || []);
    if (fs2.length) bfAddFiles(kind, fs2);
  };
}

async function bfAddFiles(kind, files) {
  if (!BF || BF.busy) return;
  const zoneId = kind === 'tender' ? 'bfTender' : 'bfBid';
  for (const f of files) {
    const stage = kind === 'tender' ? 'tender' : 'draft';
    const role = kind === 'tender' ? 'tenderFile' : 'uploaded';
    try {
      const r = await upload('/api/projects/' + BF.projectId + '/files?stage=' + stage + '&role=' + role, f);
      const saved = (r.files || [])[0];
      if (!saved || saved.error) { toast((saved && saved.error) || '上传失败', true); continue; }
      const item = { id: saved.id, name: saved.name || f.name, size: saved.size || f.size };
      if (kind === 'tender') BF.tender = item; else BF.bids.push(item);
    } catch (e) { toast('上传失败：' + e.message, true); }
  }
  bfRenderDrop(zoneId, kind, kind !== 'tender');
  bfRefreshBtn();
}

async function backfillDialog() {
  let proj = null;
  try {
    proj = await api('POST', '/api/projects', {
      name: '补录项目 ' + new Date().toLocaleDateString('zh-CN'),
      isBackfill: true
    });
  } catch (e) { toast('建补录项目失败：' + e.message, true); return; }
  BF = { projectId: proj.id, dir: proj.dir, tender: null, bids: [], busy: false, taskId: '' };

  openModal('<h3>项目补录</h3>' +
    '<p class="muted" style="margin-top:0;font-size:13px">已经投完的老项目，把两份文件拖进来就行。工作台会自动读文件、分析、整理章节，然后归档进知识库。</p>' +
    '<div class="bf-grid">' +
      '<div class="bf-col">' +
        '<div class="bf-label">招标文件<span class="bf-req">必传 1 份</span></div>' +
        '<div class="drop bf-drop" id="bfTender">' +
          '<div class="bf-ico">📄</div>' +
          '<div class="bf-h">把招标文件拖到这里</div>' +
          '<div class="bf-p">或点一下选择文件（pdf / doc / docx 都行）</div>' +
          '<div class="bf-tip" id="bfTenderTip"></div>' +
          '<input type="file" id="bfTenderInput" accept=".pdf,.doc,.docx" style="display:none">' +
        '</div>' +
      '</div>' +
      '<div class="bf-col">' +
        '<div class="bf-label">投标文件<span class="bf-req">几份都行</span></div>' +
        '<div class="drop bf-drop" id="bfBid">' +
          '<div class="bf-ico">📑</div>' +
          '<div class="bf-h">把投标文件拖到这里</div>' +
          '<div class="bf-p">PDF / Word 都行，一份、两份、三份都可以，后台自动分辨是哪一份</div>' +
          '<div class="bf-tip" id="bfBidTip"></div>' +
          '<input type="file" id="bfBidInput" accept=".pdf,.doc,.docx" multiple style="display:none">' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="bf-progress" id="bfProg" style="display:none">' +
      '<div class="bf-bar"><i id="bfBar"></i></div>' +
      '<div class="bf-msg" id="bfMsg">正在准备…</div>' +
      '<div class="bf-sub">正在分析中，分析完成后关闭并归档。中途不要关这个窗口。</div>' +
    '</div>' +
    '<div class="modal-foot"><button class="btn" data-close id="bfCancel">取消</button>' +
    '<button class="btn primary" id="bfGo" disabled>分析并归档</button></div>');

  bfRenderDrop('bfTender', 'tender', false);
  bfRenderDrop('bfBid', 'bid', true);
  bfBindDrop('bfTender', 'tender', false);
  bfBindDrop('bfBid', 'bid', true);
  bfRefreshBtn();

  const cancel = $('#bfCancel');
  if (cancel) cancel.onclick = async () => {
    // v1.1.5：任务在跑时取消按钮锁死，只能二次确认停止
    if (BF && BF.busy) { confirmStopBackfill(); return; }
    const hasFile = BF && (BF.tender || BF.bids.length);
    closeModal(true);
    if (!hasFile && BF && BF.projectId) { try { await api('DELETE', '/api/projects/' + BF.projectId); } catch {} }
    BF = null;
    if (!hasFile) return;
    await refreshProjects();
    renderHome();
  };

  $('#bfGo').onclick = () => bfRun();
}

async function bfRun() {
  if (!BF || BF.busy) return;
  BF.busy = true;
  bfRefreshBtn();
  $('#bfTender').classList.add('disabled');
  $('#bfBid').classList.add('disabled');
  $('#bfProg').style.display = 'block';
  setModalLock(true);   // v1.1.5：任务跑起来以后，这个弹窗关不掉了
  const cancelBtn = $('#bfCancel');
  if (cancelBtn) cancelBtn.textContent = '停止任务';
  let taskId = '';
  try {
    const r = await api('POST', '/api/backfill', {
      projectId: BF.projectId,
      tenderFileId: BF.tender.id,
      bidFileIds: BF.bids.map((x) => x.id)
    });
    taskId = r.taskId;
    BF.taskId = taskId;
  } catch (e) {
    toast('启动失败：' + e.message, true);
    BF.busy = false;
    bfRefreshBtn();
    setModalLock(false);
    $('#bfProg').style.display = 'none';
    $('#bfTender').classList.remove('disabled');
    $('#bfBid').classList.remove('disabled');
    return;
  }
  const steps = 6;
  const tick = async () => {
    if (!BF || BF.taskId !== taskId) return;
    let t = null;
    try { t = await api('GET', '/api/backfill/' + taskId); } catch (e) { t = null; }
    if (!t) { setTimeout(tick, 2000); return; }
    const pct = Math.max(8, Math.min(96, Math.round(((t.step || 0) + 0.6) / steps * 100)));
    const bar = $('#bfBar');
    if (bar) bar.style.width = pct + '%';
    const msg = $('#bfMsg');
    if (msg) msg.textContent = t.message || '正在处理…';
    if (t.state === 'done') {
      if (bar) bar.style.width = '100%';
      if (msg) msg.textContent = '已归档完成';
      BF.busy = false;
      setModalLock(false);
      const res = t.result || {};
      closeModal(true);
      BF = null;
      goHome();
      await refreshProjects();
      showBackfillDone(res);
      return;
    }
    if (t.state === 'failed') {
      BF.busy = false;
      setModalLock(false);
      bfRefreshBtn();
      // v1.1.5：补录失败，后台已经把这个补录项目删掉了，这里只负责把原因说清楚
      const res = t.result || {};
      closeModal(true);
      BF = null;
      goHome();
      await refreshProjects();
      showBackfillFailed(t, res);
      return;
    }
    setTimeout(tick, 1500);
  };
  setTimeout(tick, 800);
}

// v1.1.5：补录任务在跑时点「停止任务」——二次确认后才真的停
function confirmStopBackfill() {
  openModal('<h3>要停止这个补录任务吗？</h3>' +
    '<p class="muted" style="margin-top:0">任务还在跑。停止以后这次补录就作废了，已经上传的文件和刚建的补录项目会被删掉。</p>' +
    '<div class="modal-foot"><button class="btn" id="bfKeep">继续跑（推荐）</button>' +
    '<button class="btn danger" id="bfStop">确定停止</button></div>', { lock: false });
  $('#bfKeep').onclick = () => { closeModal(true); backfillDialogAgain(); };
  $('#bfStop').onclick = async () => {
    const pid = BF && BF.projectId;
    BF = null;
    closeModal(true);
    if (pid) { try { await api('DELETE', '/api/projects/' + pid); } catch {} }
    toast('已停止，补录项目已删除');
    goHome();
    await refreshProjects();
  };
}

// 从「继续跑」回来：把补录弹窗按原样重画（任务本身还在后台跑）
function backfillDialogAgain() {
  if (!BF) { backfillDialog(); return; }
  const st = BF;
  openModal('<h3>项目补录</h3>' +
    '<p class="muted" style="margin-top:0;font-size:13px">任务还在后台跑，进度会接着显示。</p>' +
    '<div class="bf-progress" id="bfProg" style="display:block">' +
      '<div class="bf-bar"><i id="bfBar" style="width:20%"></i></div>' +
      '<div class="bf-msg" id="bfMsg">正在处理…</div>' +
      '<div class="bf-sub">中途不要关这个窗口。要停就点下面的「停止任务」。</div>' +
    '</div>' +
    '<div class="modal-foot"><button class="btn" data-close id="bfCancel">停止任务</button>' +
    '<button class="btn primary" id="bfGo" disabled>分析并归档</button></div>', { lock: true });
  const c = $('#bfCancel');
  if (c) c.onclick = () => confirmStopBackfill();
  const g = $('#bfGo');
  if (g) g.onclick = () => bfRun();
  const t0 = { step: 0 };
  const steps = 6;
  const tick = async () => {
    if (!BF || BF !== st) return;
    let t = null;
    try { t = await api('GET', '/api/backfill/' + st.taskId); } catch { t = null; }
    if (!t) { setTimeout(tick, 2000); return; }
    const pct = Math.max(8, Math.min(96, Math.round(((t.step || 0) + 0.6) / steps * 100)));
    const bar = $('#bfBar');
    if (bar) bar.style.width = pct + '%';
    const msg = $('#bfMsg');
    if (msg) msg.textContent = t.message || '正在处理…';
    if (t.state === 'done' || t.state === 'failed') { st.busy = false; return; }
    setTimeout(tick, 1500);
  };
  setTimeout(tick, 600);
}

// v1.1.5：补录失败弹窗——说清原因，并告诉用户补录项目已经删掉了
function showBackfillFailed(t, res) {
  const why = (t && (t.error || t.message)) || '未知错误';
  const tips = [];
  if (/PDF/i.test(why)) tips.push('这份 PDF 可能是扫描件或加密文件，读不出文字。可以先用 Word 另存一份 PDF 再试，或者直接在项目里手工补录。');
  if (/识别|OCR|图片/i.test(why)) tips.push('这台电脑的文字识别工具可能没装好，可以到「设置」里点「安装识别工具」再试一次。');
  if (/Key|额度|401|403|超时/i.test(why)) tips.push('可能是 DeepSeek API Key 没填或额度用完了，可以到「设置」里检查一下。');
  openModal('<h3>补录没成功</h3>' +
    '<div class="bf-warn" style="margin-top:0">原因：' + esc(why) + '</div>' +
    '<p class="muted" style="margin:12px 0 0">刚才为补录临时建的那个项目已经自动删掉了，项目列表里不会留半成品。</p>' +
    (tips.length ? '<ul class="muted" style="margin:10px 0 0;padding-left:20px;font-size:13px">' + tips.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '') +
    '<div class="modal-foot"><button class="btn" data-close>知道了</button>' +
    '<button class="btn primary" id="bfRetry">重新补录</button></div>');
  const b = $('#bfRetry');
  if (b) b.onclick = () => { closeModal(true); backfillDialog(); };
}

function showBackfillDone(res) {
  const kn = res.knowledge;
  const imp = (res.imports || []).filter((x) => x.chapters);
  const bad = (res.imports || []).filter((x) => x.error);
  const meta = res.meta || {};
  openModal('<h3>补录完成</h3>' +
    '<div class="bf-done">' +
      (meta.name ? '<div class="bf-done-row"><b>项目名称</b>' + esc(meta.name) + '</div>' : '') +
      (meta.code ? '<div class="bf-done-row"><b>招标编号</b>' + esc(meta.code) + '</div>' : '') +
      '<div class="bf-done-row"><b>归档位置</b>' + esc(res.relDir || '') + '</div>' +
      '<div class="bf-done-row"><b>文件数</b>' + (res.files || 0) + ' 个</div>' +
      (kn ? '<div class="bf-done-row"><b>知识库沉淀</b>技术 ' + (kn.tech || 0) + ' 章 / 商务 ' + (kn.biz || 0) + ' 章</div>' : '') +
      (imp.length ? '<div class="bf-done-row"><b>整理到</b>' + imp.map((x) => esc(x.file) + '（' + x.chapters + ' 章）').join('、') + '</div>' : '') +
    '</div>' +
    (bad.length ? '<div class="bf-warn">有 ' + bad.length + ' 份文件没整理成章节：' + bad.map((x) => esc(x.file) + '（' + esc(x.error) + '）').join('；') + '。文件本身已经存进归档文件夹了。</div>' : '') +
    (res.metaErr ? '<div class="bf-warn">基本信息没识别出来：' + esc(res.metaErr) + '。可以在项目里手动填。</div>' : '') +
    (res.analysisErr ? '<div class="bf-warn">招标文件分析没做完：' + esc(res.analysisErr) + '。文件已归档，可以重新打开项目补做。</div>' : '') +
    '<div class="modal-foot"><button class="btn primary" data-close>知道了</button></div>');
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
    '<div class="field full"><label>数据位置</label><input value="' + esc(rootPath()) + '" readonly></div>' +
    '<div class="field full"><label>版本</label><input id="stVersion" value="' + esc((S.health && S.health.version) || '') + '" readonly><div class="hint">程序升级后这里会跟着变。</div></div>' +
    '<div class="field full"><label>关闭网页时</label>' +
      '<div class="ocr-box"><div class="ocr-row">' +
        '<input type="checkbox" id="stAutoExit"' + (s.autoExitOnClose !== false ? ' checked' : '') + ' style="width:16px;height:16px">' +
        '<span class="ocr-txt">关掉网页后自动关掉后台服务（如果还有任务在跑，会等任务跑完再关，最长等 30 分钟）</span>' +
      '</div><div class="ocr-sub">关掉这一项，后台服务就一直开着，需要手动点「关闭工作台」才会退出。</div></div></div>' +
    '<div class="field full"><label>文字识别（读扫描件用）</label>' +
      '<div class="ocr-box" id="ocrBox"><span class="loading"></span> 正在检查…</div>' +
      '<div class="hint">招标文件、投标文件如果是扫描件（图片），需要文字识别才能读出内容。工作台会先自动判断这台电脑有没有可用的识别工具。</div></div>' +
    '</div><div class="modal-foot"><button class="btn" data-close>取消</button><button class="btn primary" id="okSet">保存</button></div>');
  bindOcrBox();
  $('#okSet').onclick = async () => {
    const body = { deepseekModel: $('#stModel').value.trim(), company: $('#stCompany').value.trim() };
    const ax = $('#stAutoExit');
    if (ax) body.autoExitOnClose = !!ax.checked;
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

// v1.1.4：设置页里的「文字识别」状态与一键安装
async function bindOcrBox() {
  const box = $('#ocrBox');
  if (!box) return;
  const paint = (d) => {
    if (!box.isConnected) return;
    const ok = d.available;
    box.innerHTML = '<div class="ocr-row"><span class="ocr-dot ' + (ok ? 'ok' : 'no') + '"></span>' +
      '<span class="ocr-txt">' + esc(d.hint || '') + '</span></div>' +
      (ok ? '' : '<button class="btn tiny" id="ocrInstall">安装识别工具</button>') +
      '<div class="ocr-sub">' +
        'Windows 自带：' + (d.winrt && d.winrt.ok ? '可用（' + esc((d.winrt.langs || []).join('、')) + '）' : '不可用') +
        ' · Tesseract：' + (d.tesseract && d.tesseract.ok ? '已装' : '未装') +
      '</div>';
    const btn = $('#ocrInstall');
    if (btn) btn.onclick = async () => {
      btn.disabled = true;
      btn.innerHTML = '<span class="loading"></span> 正在下载安装，可能要几分钟…';
      try {
        const r = await api('POST', '/api/ocr/install', {});
        toast('识别工具装好了');
        const s2 = await api('GET', '/api/ocr/status');
        paint(s2);
        if (!r || !r.ok) toast('装完了但没检测到，可以重启工作台再试', true);
      } catch (e) {
        toast('安装失败：' + e.message, true);
        if (btn.isConnected) { btn.disabled = false; btn.textContent = '重试安装'; }
      }
    };
  };
  try { paint(await api('GET', '/api/ocr/status')); }
  catch (e) { box.textContent = '检查失败：' + e.message; }
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

// v1.1.0：章节性质标签（重要技术=蓝、重要商务=紫、其它不显示），点一下循环切换
const ROLE_TAG = {
  tech: '<span class="tag role-tech" data-rolebtn="1">重要技术</span>',
  biz: '<span class="tag role-biz" data-rolebtn="1">重要商务</span>'
};
const ROLE_NEXT = { tech: 'biz', biz: '', '': 'tech' };
const ROLE_NAME = { tech: '重要技术', biz: '重要商务', '': '不标注' };

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
    openChapter: keepOpen, redOnly: false, running: d.running || null, taskId: null, timer: null
  };
  // v1.1.5：切回页面时把还在跑的写稿任务接上
  if (d.running && d.running.taskId && !S.df.timer) dfPoll(d.running.taskId, true);
  // v1.1.0：把项目级专家画像一并读进来，章节面板才能显示「已确认 / 还没确认」
  if (!S.pf || S.pf.projectId !== pid) { try { await loadProfilesFor(pid); } catch {} }
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

  /* 章节性质汇总条（v1.1.0） */
  const normalCh = (cur0.chapters || []).filter((c) => c.type === 'normal');
  // v1.1.3：没生成框架、也没上传 Word 之前，框架里的章节还不算数 —— 统计必须是 0，别让用户以为已经标好了
  const builtNow = !!cur0.built;
  const nTech = builtNow ? normalCh.filter((c) => c.role === 'tech').length : 0;
  const nBiz = builtNow ? normalCh.filter((c) => c.role === 'biz').length : 0;
  const roleBar = normalCh.length || !builtNow
    ? '<div class="df-rolebar-sum">' +
        '<span class="muted">章节性质：</span>' +
        '<span class="tag role-tech">重要技术 ' + nTech + ' 章</span>' +
        '<span class="tag role-biz">重要商务 ' + nBiz + ' 章</span>' +
        '<span class="muted" style="font-size:12px">' + (builtNow
          ? '蓝/紫标签的章节，AI 会用「技术专家 / 商务专家」模式写；标错了点一下标签就能改（技术 → 商务 → 不标注）。鼠标移到章节行右侧会出现「＋ 重要」。'
          : '还没生成框架、也还没上传 Word，所以现在是 0 章。生成框架或上传 Word 之后，工作台会按章节标题自动判断哪些属于重要技术、哪些属于重要商务，你也可以点「AI 复核章节性质」让 AI 再判一遍。') +
        '</span>' +
      '</div>'
    : '';

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
    // v1.1.3：两条路都留着 —— 可以让 AI 生成框架，也可以直接把自己写好的 Word 传上来读章节
    right = '<div class="card"><h3>' + esc(cur0.title) + '</h3>' +
      '<p class="muted" style="margin-top:0;font-size:13px;max-width:700px">这一步有两条路，任选一条（也可以先传 Word，之后再让 AI 补章节）：</p>' +
      '<div class="df-start">' +
        '<div class="df-start-i">' +
          '<div class="df-start-h">① 让 AI 生成框架</div>' +
          '<div class="df-start-d">AI 按招标文件的要求，把这份文件该有哪些章节列出来（封面、目录、各级标题、索引表、偏离表），你可以在后面增删改。框架里不带正文。</div>' +
          (st.apiReady ? '<button class="btn primary" id="btnOutline">生成框架</button>'
            : '<button class="btn primary" id="btnGoSettings2">先去设置 API Key</button>') +
        '</div>' +
        '<div class="df-start-i">' +
          '<div class="df-start-h">② 上传我自己写的 Word</div>' +
          '<div class="df-start-d">直接把你写好的标书传上来，工作台按你 Word 里的标题层级读章节，完全按你的章节和顺序排列（只列一级、二级标题），编号也用你原来的。' +
          (cur.status === 'archived' ? '' : '之后还能让 AI 逐章补正文。') + '</div>' +
          '<div class="df-drop df-drop-lg" id="dfDrop">' +
            '<div class="df-drop-ico">⇪</div>' +
            '<div class="df-drop-t">把 Word 拖到这里</div>' +
            '<div class="df-drop-p">或点下面的按钮选文件（.docx / .doc）</div>' +
            '<button class="btn" id="btnImport">上传我写的 Word</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<input type="file" id="impInput" accept=".docx,.doc" style="display:none">' +
      '<span id="dfMsg" class="muted" style="font-size:13px"></span></div>';
  } else {
    const rows = cur0.chapters.map((c, i) => {
      const isOpen = st.openChapter === c.id;
      const chars = c.body ? c.body.length : 0;
      const srcTag = c.source === 'ai' ? '<span class="tag green">AI 写</span>' : c.source === 'upload' ? '<span class="tag blue">你上传的</span>' : c.source === 'manual' ? '<span class="tag">手写</span>' : '';
      const needRow = c.type === 'index' || c.type === 'deviation';
      const cnt = needRow ? ((c.rows || []).length + ' 条') : (chars ? chars + ' 字' : '空');
      const actions = c.type === 'normal'
        ? '<button class="btn tiny" data-ch="' + c.id + '" data-go="open">' + (chars ? '查看/编辑' : '手写') + '</button>' +
          (cur.status === 'archived' ? '' : 
          '<button class="btn tiny" data-ch="' + c.id + '" data-go="write">' + (chars ? '重写' : 'AI 写正文') + '</button>' +
          (chars ? '<button class="btn tiny" data-ch="' + c.id + '" data-go="expand">扩写</button>' : '')) +
          (c.role === 'tech' || c.role === 'biz'
            ? '<button class="btn tiny indep" data-indep="' + c.id + '" title="独立编制：开一个独立窗口，和 AI 边聊边改，可以生成图/表、导出验收用 Word">编制</button>'
            : '')
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
      // 已标注的显示蓝/紫标签；没标注的平时不显示，鼠标移到这一行才露出淡灰「+ 重要」提示，点它即可标注
      const roleTag = c.type === 'normal'
        ? (c.role === 'tech' || c.role === 'biz'
          ? '<span class="tag ' + (c.role === 'tech' ? 'role-tech' : 'role-biz') + '" data-rolebtn="' + c.id + '" title="点一下切换：重要技术 → 重要商务 → 不标注">' +
            (c.role === 'tech' ? '重要技术' : '重要商务') + '</span>'
          : '<span class="tag role-none" data-rolebtn="' + c.id + '" title="标为重要内容，AI 会按技术/商务专家模式写">＋ 重要</span>')
        : '';
      const main = '<div class="df-ch-main" data-ch="' + c.id + '" data-go="open" style="padding-left:' + pad + 'px">' +
        '<div class="df-ch-t' + titleCls + '">' + esc(numTxt + c.title) + ' ' + (typeTagText && typeTagText !== c.title ? typeTag : '') + ' ' + roleTag + ' ' + srcTag + '</div>' +
        '<div class="df-ch-s">' + esc(c.hint || '') + '</div></div>' +
        '<div class="df-ch-n">' + cnt + '</div>' +
        '<div class="df-ch-a">' + actions +
          (cur.status === 'archived' ? '' : '<button class="btn tiny" data-ch="' + c.id + '" data-go="rename">改名</button>' +
          '<button class="btn tiny danger" data-ch="' + c.id + '" data-go="del">删</button>') + '</div>';
      const panel = isOpen ? chapterPanel(cur0, c) : '';
      return '<div class="df-ch' + (isOpen ? ' open' : '') + '">' + main + panel + '</div>';
    }).join('');

    right = '<div class="df-head">' +
      '<div><b>' + esc(cur0.title) + '</b> <span class="muted" style="font-size:13px">共 ' + cur0.chapters.length + ' 章</span></div>' +
      '<div class="row" style="gap:8px">' +
        (cur.status === 'archived' ? '' :
          '<button class="btn" id="btnAddCh">＋加一章</button>' +
          '<button class="btn" id="btnReviewRoles" title="让 AI 把每章重新判一遍属于重要技术还是重要商务">AI 复核章节性质</button>' +
          '<button class="btn" id="btnRefreshTables">刷新索引/偏离表</button>' +
          '<button class="btn" id="btnImport">上传我写的 Word</button>' +
          (cur0.source === 'upload' ? '<button class="btn" id="btnRestoreOutline">恢复自动框架</button>' : '')) +
        '<button class="btn primary" id="btnExportDraft">下载 Word</button>' +
        (cur.status === 'archived' ? '' : '<button class="btn" id="btnReOutline">重新生成框架</button>') +
      '</div></div>' +
      '<input type="file" id="impInput" accept=".docx,.doc" style="display:none">' +
      '<div class="df-msg muted" id="dfMsg"></div>' +
      (cur.status === 'archived' ? '' : '<div class="df-drop" id="dfDrop"><span>⇪ 把 Word 拖到这里，直接按你写的章节替换（.docx / .doc）</span></div>') +
      '<div class="df-chs">' + rows + '</div>';
  }

  return head + roleBar + '<div class="df-wrap">' + left + '<div class="df-main">' + right + '</div></div>';
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
  const roleKind = c.role === 'tech' || c.role === 'biz' ? c.role : '';
  const prof = roleKind && S.pf && S.pf.projectId === S.cur.id ? S.pf.profiles[roleKind] : null;
  const roleBar = roleKind
    ? '<div class="df-rolebar ' + (roleKind === 'tech' ? 'is-tech' : 'is-biz') + '">' +
        '<span>本章按【AI ' + (roleKind === 'tech' ? '技术专家' : '商务专家') + '】模式撰写，依据' +
        (prof && prof.confirmed ? '已确认的项目' + (roleKind === 'tech' ? '技术' : '商务') + '画像' : '项目画像（还没确认，第一次生成时会让您确认）') + '</span>' +
        '<a href="javascript:;" data-pfopen="' + roleKind + '">' + (prof && prof.confirmed ? '查看 / 修改画像' : '现在建画像') + '</a>' +
        '<a href="javascript:;" data-pfdemo="' + roleKind + '">看看 AI 是怎么理解这个项目的</a>' +
      '</div>'
    : '';
  return '<div class="df-panel">' + roleBar + '<div class="df-panel-h"><b>' + esc(c.title) + '</b>' + srcHint +
    '<span class="muted" style="font-size:12px">' + (c.body ? c.body.length + ' 字' : '还没有内容') + '</span></div>' +
    '<textarea class="df-editor" data-body="' + c.id + '" rows="16" placeholder="可以直接在这里写、改，或者点上面的「AI 写正文」让 AI 先写一版">' + esc(c.body || '') + '</textarea>' +
    '<div class="row" style="margin-top:10px"><button class="btn primary" data-savebody="' + c.id + '">保存正文</button>' +
    '<button class="btn" data-ch="' + c.id + '" data-go="write">AI 写一版</button>' +
    '<button class="btn" data-ch="' + c.id + '" data-go="expand">在现有内容上扩写</button>' +
    (roleKind ? '<button class="btn indep" data-indep="' + c.id + '">独立编制（对话改稿 + 生成图表 + 导出 Word）</button>' : '') +
    '<button class="btn" data-close-ch="' + c.id + '">收起</button></div></div>';
}

/* ---------- 模块3 事件 ---------- */
function dfSetMsg(t) { const el = $('#dfMsg'); if (el) el.textContent = t; }

// v1.1.4：上传/拖入 Word 后按标题层级读章节，整份替换当前文件
async function dfDoImport(f) {
  const st = S.df;
  if (!st || !S.cur) return;
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
    dfSetMsg('');
    await reloadDraft();
  } catch (e) { dfSetMsg(''); toast(e.message, true); }
}

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

  /* v1.1.2 独立编制：开一个独立的浏览器窗口，边聊边改 */
  document.querySelectorAll('[data-indep]').forEach((el) => {
    el.onclick = (ev) => {
      ev.stopPropagation();
      openIndep(el.dataset.indep, st.doc);
    };
  });

  /* 章节性质标签：点一下循环切换 重要技术 → 重要商务 → 不标注 */
  document.querySelectorAll('[data-rolebtn]').forEach((el) => {
    el.onclick = async (ev) => {
      ev.stopPropagation();
      const cid = el.dataset.rolebtn;
      const ch = (d.docs[st.doc].chapters || []).find((x) => x.id === cid);
      if (!ch) return;
      // 注意：'' 是合法目标（不标注），不能用 || 兜底，否则 商务→技术 会跳过「不标注」
      const curRole = ch.role === 'tech' || ch.role === 'biz' ? ch.role : '';
      const next = Object.prototype.hasOwnProperty.call(ROLE_NEXT, curRole) ? ROLE_NEXT[curRole] : 'tech';
      try {
        const r = await api('PUT', '/api/projects/' + S.cur.id + '/draft/' + st.doc + '/chapter/' + cid + '/role', { role: next });
        ch.role = r.role; ch.roleBy = 'user';
        toast('已改为「' + ROLE_NAME[r.role || ''] + '」');
        renderProject();
      } catch (e) { toast(e.message, true); }
    };
  });

  /* AI 复核章节性质 */
  const btnRR = $('#btnReviewRoles');
  if (btnRR) btnRR.onclick = async () => {
    btnRR.disabled = true; const old = btnRR.textContent; btnRR.textContent = 'AI 正在复核…';
    try {
      const r = await api('POST', '/api/projects/' + S.cur.id + '/draft/' + st.doc + '/review-roles', {});
      toast('复核完成：重要技术 ' + r.counts.tech + ' 章、重要商务 ' + r.counts.biz + ' 章');
      await reloadDraft();
    } catch (e) { toast(e.message, true); }
    finally { btnRR.disabled = false; btnRR.textContent = old; }
  };

  /* 章节面板里「查看 / 修改画像」 */
  document.querySelectorAll('[data-pfopen]').forEach((el) => {
    el.onclick = (ev) => { ev.preventDefault(); openProfileDialog(el.dataset.pfopen, false); };
  });
  /* 「看看 AI 是怎么理解这个项目的」：只读展示已确认画像 */
  document.querySelectorAll('[data-pfdemo]').forEach((el) => {
    el.onclick = (ev) => {
      ev.preventDefault();
      const kind = el.dataset.pfdemo;
      const p = S.pf && S.pf.profiles ? S.pf.profiles[kind] : null;
      if (!p || !p.data) { openProfileDialog(kind, true); return; }
      const d = p.data;
      const li = (arr, f) => (Array.isArray(arr) ? arr.map(f).filter(Boolean).map((x) => '<li>' + x + '</li>').join('') : '');
      openModal('<h3>AI ' + pfKindName(kind) + '专家对这个项目的理解</h3>' +
        '<div class="pf-head">' + esc(d.summary || p.headline || '') + '</div>' +
        '<div class="grid" style="margin-top:10px">' +
        (d.direction ? '<div class="field full"><label>身份定位</label><div class="muted">' + esc(d.direction) + '</div></div>' : '') +
        (d.stack && d.stack.length ? '<div class="field full"><label>技术环节</label><ol class="pf-list">' + li(d.stack, (x) => esc(x.stage) + (x.desc ? '：' + esc(x.desc) : '')) + '</ol></div>' : '') +
        (d.targets && d.targets.length ? '<div class="field full"><label>硬指标</label><ul class="pf-list">' + li(d.targets, (x) => esc(x.item) + '：' + esc(x.value) + (x.page ? '（第' + esc(String(x.page)) + '页）' : '')) + '</ul></div>' : '') +
        (d.difficulty && d.difficulty.length ? '<div class="field full"><label>技术难点</label><ul class="pf-list">' + li(d.difficulty, (x) => esc(x)) + '</ul></div>' : '') +
        (d.focus && d.focus.length ? '<div class="field full"><label>评分关注点</label><ul class="pf-list">' + li(d.focus, (x) => esc(x)) + '</ul></div>' : '') +
        (d.bizLogic ? '<div class="field full"><label>商务逻辑</label><div class="muted">' + esc(d.bizLogic) + '</div></div>' : '') +
        (d.mgmtLogic ? '<div class="field full"><label>管理逻辑</label><div class="muted">' + esc(d.mgmtLogic) + '</div></div>' : '') +
        (d.qualityLogic ? '<div class="field full"><label>质量逻辑</label><div class="muted">' + esc(d.qualityLogic) + '</div></div>' : '') +
        (d.commitments && d.commitments.length ? '<div class="field full"><label>可以承诺的</label><ul class="pf-list">' + li(d.commitments, (x) => esc(x.item) + (x.note ? '：' + esc(x.note) : '')) + '</ul></div>' : '') +
        (d.boundary && d.boundary.length ? '<div class="field full"><label>不能乱承诺的</label><ul class="pf-list">' + li(d.boundary, (x) => esc(x)) + '</ul></div>' : '') +
        '</div>' +
        '<div class="modal-foot"><button class="btn" data-close>关闭</button>' +
        '<button class="btn primary" id="pfEdit">修改画像</button></div>');
      $('#pfEdit').onclick = () => openProfileDialog(kind, false);
    };
  });

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
      if (go === 'write') { startChapter(cid, 'first', ch.body, ch.role); return; }
      if (go === 'expand') { startChapter(cid, 'expand', ch.body, ch.role); return; }
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
      await dfDoImport(f);
    };
    // v1.1.4：整块拖拽上传（拖到虚线框里就行，效果和点按钮一样）
    const dz = $('#dfDrop');
    if (dz) {
      dz.onclick = (e) => { if (e.target === dz || dz.contains(e.target)) { if (!e.target.closest('button')) impIn.click(); } };
      const on = (v) => dz.classList.toggle('hot', v);
      dz.ondragover = (e) => { e.preventDefault(); on(true); };
      dz.ondragleave = () => on(false);
      dz.ondrop = async (e) => {
        e.preventDefault(); on(false);
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (!f) return;
        if (!/\.(docx|doc)$/i.test(f.name)) { toast('只能拖 Word 文件（.docx / .doc）', true); return; }
        await dfDoImport(f);
      };
    }
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
        '<div class="card" style="background:#f7f9fc"><code style="font-size:13px">' + esc(rootPath() + '\\' + r.relPath.replace(/\//g, '\\')) + '</code></div>' +
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
    if (S.cur) renderProject();
  } catch (e) { toast(e.message, true); }
}

function dfPoll(taskId, silent) {
  if (S.df && S.df.timer) clearInterval(S.df.timer);
  if (!S.df) return;
  S.df.taskId = taskId;
  S.df.running = { taskId, message: '' };
  S.df.timer = setInterval(async () => {
    let t;
    try { t = await api('GET', '/api/draft-tasks/' + taskId); } catch { return; }
    if (!S.df || S.df.taskId !== taskId) { clearInterval(S.df.timer); return; }
    dfSetMsg(t.message || '正在处理…');
    if (t.state !== 'running') {
      clearInterval(S.df.timer);
      S.df.timer = null;
      S.df.running = null;
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

async function startChapter(cid, mode, curBody, role) {
  const go = async () => {
    if (mode === 'first' && curBody && curBody.trim()) {
      openModal('<h3>要重写这一章吗？</h3><p>这一章已经有内容了，重新让 AI 写会把它覆盖掉。' +
        '如果只是想让内容更丰满，建议点「扩写」，AI 会在现有内容基础上补充。</p>' +
        '<div class="modal-foot"><button class="btn" data-close>取消</button><button class="btn primary" id="okReW">确定重写</button></div>');
      $('#okReW').onclick = async () => { closeModal(); await doStartChapter(cid, 'first'); };
      return;
    }
    await doStartChapter(cid, mode);
  };
  // v1.1.0：重要技术/商务章节，第一次写之前先让用户确认专家画像
  if (role === 'tech' || role === 'biz') { await ensureProfileThen(role, go); return; }
  await go();
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


/* ================= v1.1.0：专家画像 ================= */
S.pf = null; // { projectId, profiles: { tech, biz } }

async function loadProfilesFor(pid) {
  try {
    const r = await api('GET', '/api/projects/' + pid + '/profiles');
    S.pf = { projectId: pid, profiles: r.profiles || {} };
  } catch {
    S.pf = { projectId: pid, profiles: {} };
  }
  return S.pf;
}

function pfKindName(kind) { return kind === 'tech' ? '技术' : '商务'; }

// 把画像数据渲染成可编辑的表单
function pfForm(kind, data) {
  const d = data || {};
  const lines = (arr, f) => (Array.isArray(arr) ? arr.map(f).filter(Boolean).join('\n') : '');
  if (kind === 'tech') {
    return '<div class="field full"><label>一句话理解（会显示给您确认）</label><textarea id="pfSummary" rows="2">' + esc(d.summary || '') + '</textarea></div>' +
      '<div class="field full"><label>本项目所属技术方向</label><input id="pfDirection" value="' + esc(d.direction || '') + '"></div>' +
      '<div class="field full"><label>这个方向的全流程技术环节（一行一个，格式：环节名称｜说明）</label><textarea id="pfStack" rows="6">' + esc(lines(d.stack, (x) => x && x.stage ? x.stage + (x.desc ? '｜' + x.desc : '') : '')) + '</textarea></div>' +
      '<div class="field full"><label>本项目硬指标（一行一个，格式：指标｜数值｜页码）</label><textarea id="pfTargets" rows="6">' + esc(lines(d.targets, (x) => x && (x.item || x.value) ? [x.item, x.value, x.page].filter((v) => v !== '' && v != null).join('｜') : '')) + '</textarea></div>' +
      '<div class="field full"><label>技术难点（一行一个）</label><textarea id="pfDifficulty" rows="3">' + esc(lines(d.difficulty, (x) => x)) + '</textarea></div>' +
      '<div class="field full"><label>评委技术评分关注点（一行一个）</label><textarea id="pfFocus" rows="3">' + esc(lines(d.focus, (x) => x)) + '</textarea></div>' +
      '<div class="field full"><label>技术逻辑主线</label><textarea id="pfApproach" rows="3">' + esc(d.approach || '') + '</textarea></div>';
  }
  return '<div class="field full"><label>一句话理解（会显示给您确认）</label><textarea id="pfSummary" rows="2">' + esc(d.summary || '') + '</textarea></div>' +
    '<div class="field full"><label>我方以什么身份写商务标</label><input id="pfDirection" value="' + esc(d.direction || '') + '"></div>' +
    '<div class="field full"><label>商务逻辑主线（交付→验收→付款→质保→售后→违约）</label><textarea id="pfBizLogic" rows="3">' + esc(d.bizLogic || '') + '</textarea></div>' +
    '<div class="field full"><label>整体管理逻辑</label><textarea id="pfMgmtLogic" rows="3">' + esc(d.mgmtLogic || '') + '</textarea></div>' +
    '<div class="field full"><label>质量管理逻辑</label><textarea id="pfQualityLogic" rows="2">' + esc(d.qualityLogic || '') + '</textarea></div>' +
    '<div class="field full"><label>可以承诺的事项（一行一个，格式：事项｜怎么承诺）</label><textarea id="pfCommit" rows="4">' + esc(lines(d.commitments, (x) => x && x.item ? x.item + (x.note ? '｜' + x.note : '') : '')) + '</textarea></div>' +
    '<div class="field full"><label>承诺边界（一行一个，不能乱承诺的地方）</label><textarea id="pfBoundary" rows="3">' + esc(lines(d.boundary, (x) => x)) + '</textarea></div>' +
    '<div class="field full"><label>评委商务评分关注点（一行一个）</label><textarea id="pfFocus" rows="3">' + esc(lines(d.focus, (x) => x)) + '</textarea></div>';
}

function pfCollect(kind) {
  const v = (id) => { const el = $('#' + id); return el ? el.value : ''; };
  const split = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);
  const pair = (s, a, b) => split(s).map((line) => {
    const p = line.split(/[｜|]/);
    const o = {}; o[a] = (p[0] || '').trim(); o[b] = (p[1] || '').trim(); return o;
  }).filter((o) => o[a]);
  if (kind === 'tech') {
    return {
      summary: v('pfSummary'), direction: v('pfDirection'),
      stack: split(v('pfStack')).map((line) => { const p = line.split(/[｜|]/); return { stage: (p[0] || '').trim(), desc: (p[1] || '').trim() }; }).filter((x) => x.stage),
      targets: split(v('pfTargets')).map((line) => { const p = line.split(/[｜|]/); return { item: (p[0] || '').trim(), value: (p[1] || '').trim(), page: (p[2] || '').trim() }; }).filter((x) => x.item || x.value),
      difficulty: split(v('pfDifficulty')), focus: split(v('pfFocus')), approach: v('pfApproach')
    };
  }
  return {
    summary: v('pfSummary'), direction: v('pfDirection'),
    bizLogic: v('pfBizLogic'), mgmtLogic: v('pfMgmtLogic'), qualityLogic: v('pfQualityLogic'),
    commitments: pair(v('pfCommit'), 'item', 'note'),
    boundary: split(v('pfBoundary')), focus: split(v('pfFocus'))
  };
}

// 画像弹窗：needGen=true 表示还没有画像，先让 AI 生成
function openProfileDialog(kind, needGen, onDone) {
  const kn = pfKindName(kind);
  const prof = S.pf && S.pf.profiles ? S.pf.profiles[kind] : null;
  const confirmed = !!(prof && prof.confirmed);
  const shell = (inner) => '<h3>AI ' + kn + '专家 · 上岗画像</h3>' + inner;
  const okText = typeof onDone === 'function' ? '确认，开始写正文' : '确认修改';
  const foot = (extra) => '<div class="modal-foot">' +
    (extra || '') +
    '<button class="btn" data-close>取消</button>' +
    '<button class="btn" id="pfRegen">重新生成</button>' +
    '<button class="btn primary" id="pfOk">' + okText + '</button></div>';

  openModal(shell('<div class="placeholder"><span class="loading"></span> AI 正在通读招标文件、建立' + kn + '专家画像…（约 20～60 秒）</div>'));

  const gen = async (isRegen) => {
    try {
      const r = await api('POST', '/api/projects/' + S.cur.id + '/profiles/' + kind + '/generate', {});
      if (!S.pf) S.pf = { projectId: S.cur.id, profiles: {} };
      S.pf.profiles[kind] = { kind, label: kn, confirmed: false, data: r.profile, headline: r.headline };
      show(r.profile, r.headline, r.refsUsed, isRegen);
    } catch (e) {
      openModal(shell('<p style="color:#d1242f">' + esc(e.message) + '</p>' +
        '<p class="muted" style="font-size:13px">画像要靠招标分析结果来建。如果还没做「招标分析」，请先去那一页做一次。</p>' +
        '<div class="modal-foot"><button class="btn" data-close>关闭</button></div>'));
    }
  };

  const show = (data, headline, refsUsed, isRegen) => {
    const cur = S.pf && S.pf.profiles ? S.pf.profiles[kind] : null;
    const tip = (cur && cur.confirmed)
      ? '这个项目的' + kn + '画像之前已经确认过了。您可以继续用，也可以改。'
      : '这是 AI 对这个项目的理解。请看一眼——如果哪里理解错了，直接在下面改，改完点「确认」。确认后这个项目以后每章都按这份画像写，不用再确认。';
    openModal(shell(
      '<div class="pf-head">' + esc(headline || '') + '</div>' +
      '<p class="muted" style="margin:6px 0 12px;font-size:13px">' + tip +
        (refsUsed ? '（本次参考了 ' + refsUsed + ' 个历史项目的经验）' : '（知识库还没有同类项目，本次按 AI 通用策略建立）') + '</p>' +
      '<div class="grid">' + pfForm(kind, data) + '</div>') + foot());
    const regen = $('#pfRegen');
    if (regen) regen.onclick = () => gen(true);
    $('#pfOk').onclick = async () => {
      const payload = pfCollect(kind);
      try {
        await api('PUT', '/api/projects/' + S.cur.id + '/profiles/' + kind, { data: payload, confirm: true });
        if (S.pf) { S.pf.profiles[kind] = { ...(S.pf.profiles[kind] || {}), kind, confirmed: true, data: payload }; }
        closeModal();
        toast('画像已确认，之后每章都按这份画像写');
        if (typeof onDone === 'function') onDone();
        else renderProject();
      } catch (e) { toast(e.message, true); }
    };
  };

  if (needGen || !prof || !prof.data || (!prof.data.summary && !prof.data.direction)) gen(false);
  else show(prof.data, prof.headline || '', 0, false);
}

// 写正文前先确保画像已确认
async function ensureProfileThen(kind, cb) {
  if (!S.pf || S.pf.projectId !== S.cur.id) await loadProfilesFor(S.cur.id);
  const prof = S.pf && S.pf.profiles ? S.pf.profiles[kind] : null;
  if (prof && prof.confirmed) { cb(); return; }
  openProfileDialog(kind, !prof || !prof.data || (!prof.data.summary && !prof.data.direction), cb);
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
      running: !!(r.running && r.running.taskId),
      msg: (r.running && r.running.message) || ''
    };
    // v1.1.5：切回页面时把还在跑的核查任务接上
    if (r.running && r.running.taskId && !S.ck.timer) ckPoll(r.running.taskId, true);
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
        '<div class="card" style="background:#f7f9fc"><code style="font-size:13px">' + esc(rootPath() + '\\' + r.relPath.replace(/\//g, '\\')) + '</code></div>' +
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

function ckPoll(taskId, silent) {
  if (S.ck && S.ck.timer) clearInterval(S.ck.timer);
  if (S.ck) { S.ck.taskId = taskId; S.ck.running = true; }
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
        '<div class="card" style="background:#f7f9fc"><code style="font-size:13px">' + esc(rootPath() + '\\' + r.relPath.replace(/\//g, '\\')) + '</code></div>' +
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
  const year = new Date().getFullYear();

  // v1.1.2：先查能不能关（截止时间门禁 / 补录项目 / 放弃投标）
  api('GET', '/api/projects/' + S.cur.id + '/close-status').then((st) => {
    if (!st.canClose) {
      openModal('<h3>现在还不能关闭归档</h3>' +
        '<div class="card" style="background:#fff5f5;border-color:#f0b9b9">' +
        '<b style="color:#c53030">这个项目还在投标期内，不能关闭归档。</b><br>' +
        '投标截止时间是 <b>' + esc(st.deadline || '（没填）') + '</b>，' +
        '还剩 <b>' + esc(String(fmtLeft(st.deadline).big).replace(/^剩\s*/, '')) + '</b>。<br>' +
        '<span class="muted" style="font-size:13px">按流程，标书递交、开标、评标都走完（或明确不投了）才归档。现在归档会把还没定稿的资料定格住。</span>' +
        '</div>' +
        '<p class="muted" style="font-size:13px">如果这个项目本来就不打算投了，可以点下面的「放弃投标，关闭归档」。</p>' +
        '<div class="modal-foot"><button class="btn" data-close>知道了</button>' +
        '<button class="btn danger" id="okAbandon">放弃投标，关闭归档</button></div>');
      $('#okAbandon').onclick = () => abandonDialog(st);
      return;
    }
    closeConfirmDialog(st, done, all, year);
  }).catch((e) => toast(e.message, true));
}

function closeConfirmDialog(st, done, all, year) {
  const pathText = rootPath() + '\\归档\\' + new Date().getFullYear() + '\\<招标编号_项目名>\\';
  openModal('<h3>关闭项目并归档</h3>' +
    '<div class="card" style="background:#fff5f5;border-color:#f0b9b9">' +
    '<b style="color:#c53030">⚠ 这是重要节点，请确认。</b><br>' +
    '关闭后这个项目会从「我的项目」移到「已归档」，整套资料（招标文件、分析、投标文件、核查报告、递交清单、过程记录）会复制到下面这个文件夹。' +
    '<br><span class="muted" style="font-size:13px">归档后默认只能查看；要再改，得先点「重新打开」。' +
    (st.isBackfill ? '（本项目是<b>补录项目</b>，不受截止时间限制。）' : '') + '</span>' +
    '</div>' +
    '<div class="card" style="background:#f7f9fc"><code style="font-size:13px">' + esc(pathText) + '</code></div>' +
    '<div class="card" style="background:#f7f9fc">递交清单完成度：<b>' + done + ' / ' + all + '</b>' +
      (done < all ? ' <span class="warn-text">还有 ' + (all - done) + ' 项没勾，确认已经递交了吗？</span>' : ' <span style="color:#2f855a">已全部完成</span>') + '</div>' +
    '<div class="grid"><div class="field full"><label>关闭说明（可留空，会写进归档文件夹）</label>' +
    '<textarea id="clNote" rows="2" placeholder="例如：已中标 / 未中标，报价 32 万"></textarea></div>' +
    '<div class="field full"><label>请手动输入「关闭归档」四个字确认</label>' +
    '<input id="clConfirm" placeholder="关闭归档" autocomplete="off">' +
    '<div class="hint">防止手滑点错。</div></div></div>' +
    '<div class="modal-foot"><button class="btn" data-close>取消</button>' +
    '<button class="btn danger" id="okClose" disabled>关闭并归档</button></div>');

  const inp = $('#clConfirm');
  const btn = $('#okClose');
  inp.oninput = () => { btn.disabled = inp.value.trim() !== '关闭归档'; };
  inp.focus();

  btn.onclick = async () => {
    if (inp.value.trim() !== '关闭归档') { toast('请先输入「关闭归档」四个字', true); return; }
    btn.disabled = true; btn.textContent = '归档中…';
    try {
      const r = await api('POST', '/api/projects/' + S.cur.id + '/close', { note: $('#clNote').value.trim(), confirmText: '关闭归档' });
      closeModal();
      goHome();
      await refreshProjects();
      showArchivedDialog(r);
      // v1.2.0：归档后知识卡在后台自动提炼，任务条上能看到进度
      if (r.cardTaskId) { try { startTaskPolling(); pollActiveTasks(); } catch {} }
    } catch (e) {
      btn.disabled = false; btn.textContent = '关闭并归档';
      toast(e.message, true);
    }
  };
}

function abandonDialog(st) {
  openModal('<h3>放弃投标，关闭归档</h3>' +
    '<div class="card" style="background:#fff5f5;border-color:#f0b9b9">' +
    '<b style="color:#c53030">⚠ 这个项目会直接归档，状态标为「放弃投标」。</b><br>' +
    '资料不会删，以后还能在「已归档」里打开查看或重新打开。' +
    '</div>' +
    '<div class="grid"><div class="field full"><label>放弃原因（必填，会写进归档）</label>' +
    '<textarea id="abReason" rows="2" placeholder="例如：客户预算调整，本次不投 / 资质不满足，主动放弃"></textarea></div>' +
    '<div class="field full"><label>请手动输入「关闭归档」四个字确认</label>' +
    '<input id="abConfirm" placeholder="关闭归档" autocomplete="off"></div></div>' +
    '<div class="modal-foot"><button class="btn" data-close>取消</button>' +
    '<button class="btn danger" id="okAbandon2" disabled>确认放弃并归档</button></div>');
  const inp = $('#abConfirm');
  const btn = $('#okAbandon2');
  const chk = () => { btn.disabled = !(inp.value.trim() === '关闭归档' && $('#abReason').value.trim().length >= 2); };
  inp.oninput = chk;
  $('#abReason').oninput = chk;
  btn.onclick = async () => {
    btn.disabled = true; btn.textContent = '归档中…';
    try {
      const r = await api('POST', '/api/projects/' + S.cur.id + '/close', {
        mode: 'abandon', abandonReason: $('#abReason').value.trim(), confirmText: '关闭归档'
      });
      closeModal();
      goHome();
      await refreshProjects();
      showArchivedDialog(r);
    } catch (e) {
      btn.disabled = false; btn.textContent = '确认放弃并归档';
      toast(e.message, true);
    }
  };
}

function showArchivedDialog(r) {
  const ks = r.knowledgeSummary;
  const kbLine = ks
    ? '<div class="card" style="background:#f2f7f2;border-color:#cfe3cf;margin-top:8px"><b>已沉淀进专家知识库</b>：' +
      '重要技术 <b>' + (ks.tech || 0) + '</b> 章、重要商务 <b>' + (ks.biz || 0) + '</b> 章' +
      ((ks.hasProfile && (ks.hasProfile.tech || ks.hasProfile.biz)) ? '，专家画像 ' +
        [ks.hasProfile.tech ? '技术' : '', ks.hasProfile.biz ? '商务' : ''].filter(Boolean).join(' + ') + ' 各 1 份' : '') +
      '。<br><span class="muted" style="font-size:13px">以后做同类项目时，AI 会参考这些经验（左侧「🧠 专家知识库」可以查看）。</span></div>' +
      (r.cardTaskId ? '<div class="card" style="background:#f2f7f2;border-color:#cfe3cf;margin-top:8px"><b>正在提炼知识卡…</b><br><span class="muted" style="font-size:13px">工作台会用 AI 把重要技术 / 商务内容提炼成一张张可以复用的知识卡，进度看左侧栏顶部的任务条，不用等它跑完。</span></div>' : '')
    : (r.knowledge && r.knowledge.error
        ? '<p class="warn-text">知识库这次没写成功：' + esc(r.knowledge.error) + '<br>不影响归档，可以到「专家知识库」页对这个项目点「补录」。</p>'
        : '<p class="muted" style="font-size:13px">这个项目没有标注重要技术/重要商务章节，所以知识库里没有内容。</p>');
  openModal('<h3>已归档</h3><p>项目已关闭，全部资料已归档到：</p>' +
    '<div class="card" style="background:#f7f9fc"><code style="font-size:13px">' + esc(r.dir) + '</code></div>' +
    '<p class="muted" style="font-size:13px">共 ' + r.files + ' 个文件。以后要在别的标书里复用，直接去这个文件夹找。</p>' +
    kbLine +
    '<div class="modal-foot"><button class="btn primary" data-close>知道了</button></div>');
}


async function renderArchiveList() {
  let d;
  try { d = await api('GET', '/api/archives'); } catch (e) {
    $('#main').innerHTML = '<div class="page"><div class="placeholder">读取归档失败：' + esc(e.message) + '</div></div>';
    return;
  }
  const all = d.archives || [];
  const kw = String(S.archKw || '').trim().toLowerCase();
  const list = all.filter((x) => !kw || [x.name, x.code, x.owner, x.year].map((v) => String(v || '')).join(' ').toLowerCase().includes(kw));
  const head = '<div class="page-head"><div><div class="page-title">已归档的项目</div>' +
    '<div class="page-sub">关闭的项目都在这里，资料存在 D 盘，随时可以打开文件夹查看；按投标截止日期由近到远排列</div></div>' +
    '<div class="page-actions"><button class="btn" id="archHome">🏠 回到首页</button></div></div>' +
    '<div class="arch-search">' +
      '<input id="archSearch" type="search" placeholder="查找归档项目：项目名称 / 招标人 / 招标编号" value="' + esc(S.archKw || '') + '" autocomplete="off">' +
      '<span class="muted">共 ' + all.length + ' 个' + (kw ? '，匹配 ' + list.length + ' 个' : '') + '</span>' +
    '</div>';
  const body = !all.length
    ? '<div class="placeholder">还没有归档的项目。在「递交归档」页点「关闭项目并归档」就会出现在这里。</div>'
    : (!list.length
      ? '<div class="placeholder">没有匹配「' + esc(S.archKw) + '」的归档项目。</div>'
      : '<div class="arch-list">' + list.map((a) => {
        const left = fmtLeft(a.bidDeadline);
        const dlCls = left.cls === 'c-done' ? 'c-done' : left.cls;
        const dlTxt = a.bidDeadline
          ? esc(String(a.bidDeadline).replace('T', ' ').slice(0, 16)) + '　<span class="' + dlCls + '">' + esc(left.cls === 'c-done' ? '已过截止' : left.big) + '</span>'
          : '<span class="muted">未设置投标截止日期</span>';
        return '<div class="arch-i"><div class="arch-h"><b>' + esc(a.name) + '</b>' +
          (a.check && a.check.verdict === 'red' ? '<span class="tag tag-red">核查有问题</span>' : '') +
          (a.check && a.check.verdict === 'green' ? '<span class="tag tag-green">全部通过</span>' : '') +
        '</div>' +
        '<div class="arch-m">' + esc(a.code || '') + (a.owner ? ' · ' + esc(a.owner) : '') + (a.budget ? ' · 预算 ' + esc(a.budget) : '') + '</div>' +
        '<div class="arch-dl">投标截止：' + dlTxt + '</div>' +
        '<div class="arch-p">' + esc(a.path) + '</div>' +
        '<div class="arch-a"><span class="muted">归档于 ' + esc(String(a.archivedAt).slice(0, 10)) + '</span>' +
        '<span class="row" style="gap:6px">' +
          '<button class="btn tiny" data-reveal="' + esc(a.path) + '">打开文件夹</button>' +
          (a.projectId ? '<button class="btn tiny" data-reopen="' + esc(a.projectId) + '">重新打开</button>' : '') +
          (a.projectId ? '<button class="btn tiny danger" data-archdel="' + esc(a.projectId) + '" data-name="' + esc(a.name) + '" data-path="' + esc(a.path) + '">删除</button>' : '') +
        '</span></div></div>';
      }).join('') + '</div>');
  $('#main').innerHTML = '<div class="page">' + head + body + '</div>';
  const ah = $('#archHome');
  if (ah) ah.onclick = () => goHome();
  // v1.2.0：知识库页的「回到首页」（之前只画了按钮没绑事件，点了没反应）
  const kh = $('#kbHome');
  if (kh) kh.onclick = () => { S.archived = false; const ab2 = $('#btnArchived'); if (ab2) ab2.textContent = '查看已归档'; goHome(); };
  const si = $('#archSearch');
  if (si) {
    si.oninput = () => { S.archKw = si.value; renderArchiveList(); };
    si.focus();
    const v = si.value; si.value = ''; si.value = v; // 光标停在末尾
  }
  document.querySelectorAll('[data-reveal]').forEach((b) => {
    b.onclick = async () => {
      try { await api('POST', '/api/reveal', { path: b.dataset.reveal }); }
      catch (e) { toast(e.message, true); }
    };
  });
  document.querySelectorAll('[data-reopen]').forEach((b) => {
    b.onclick = () => reopenProject(b.dataset.reopen);
  });
  document.querySelectorAll('[data-archdel]').forEach((b) => {
    b.onclick = () => deleteArchivedProject(b.dataset.archdel, b.dataset.name, b.dataset.path);
  });
}

/* v1.1.3：删除已归档项目 —— 归档文件夹、项目资料、知识库经验一并删掉，删前必须二次确认 */
function deleteArchivedProject(pid, name, dirPath) {
  openModal('<h3>删除已归档的项目</h3>' +
    '<p>要删除的是：<b>' + esc(name || '') + '</b></p>' +
    '<div class="card" style="background:#fdf3f3;border-color:#f3c9c9;padding:12px 14px;font-size:13px;line-height:1.9">' +
      '<b style="color:#b6242e">删除后工作台空间内所有资料一并删除，请做好备份。</b><br>' +
      '会被删掉的内容：<br>' +
      '· 归档文件夹：<code style="font-size:12px">' + esc(dirPath || '') + '</code><br>' +
      '· 项目工作目录里的全部文件（招标文件、分析、制作稿、核查报告等）<br>' +
      '· 专家知识库里这个项目沉淀的经验记录<br>' +
      '· 独立编制里的草稿与图表<br>' +
      '<span class="muted">删除后无法恢复。</span>' +
    '</div>' +
    '<label class="chk-row" style="margin-top:12px"><input type="checkbox" id="ackDel"> 我已经把需要的资料备份好了</label>' +
    '<div class="modal-foot"><button class="btn" data-close>取消</button>' +
    '<button class="btn danger" id="okArchDel" disabled>确认删除</button></div>');
  const ack = $('#ackDel');
  const ok = $('#okArchDel');
  ack.onchange = () => { ok.disabled = !ack.checked; };
  ok.onclick = async () => {
    if (!ack.checked) return;
    ok.disabled = true; ok.textContent = '正在删除…';
    try {
      await api('DELETE', '/api/projects/' + pid);
      closeModal();
      toast('已删除，归档文件夹和资料都清理掉了');
      await refreshProjects();
      await renderArchiveList();
    } catch (e) {
      ok.disabled = false; ok.textContent = '确认删除';
      toast(e.message, true);
    }
  };
}

function reopenProject(pid) {
  openModal('<h3>重新打开这个项目？</h3>' +
    '<p>项目会回到「我的项目」里，可以继续编辑。<b>归档文件夹和知识库记录都会保留</b>，不会删掉。</p>' +
    '<p class="muted" style="font-size:13px">重新打开后如果又关闭一次，会再归档一份（以新的为准）。</p>' +
    '<div class="modal-foot"><button class="btn" data-close>取消</button><button class="btn primary" id="okReopen">重新打开</button></div>');
  $('#okReopen').onclick = async () => {
    try {
      await api('POST', '/api/projects/' + pid + '/reopen', {});
      closeModal(); toast('已重新打开');
      await refreshProjects();
      await openProject(pid, true);
    } catch (e) { toast(e.message, true); }
  };
}

/* ================= v1.1.0：专家知识库 ================= */
async function renderKnowledgeList() {
  S.kb = true;
  let d;
  try { d = await api('GET', '/api/knowledge'); } catch (e) {
    $('#main').innerHTML = '<div class="page"><div class="placeholder">读取知识库失败：' + esc(e.message) + '</div></div>';
    return;
  }
  const list = d.projects || [];
  const head = '<div class="page-head"><div><div class="page-title">专家知识库</div>' +
    '<div class="page-sub">每个项目关闭归档时，工作台会用 AI 把里面的重要技术 / 重要商务内容提炼成一张张「知识卡」（技术路线、具体做法、硬指标、管理机制、得分点、亮点、表格模板）。以后做新项目，AI 会优先参考这些知识卡，而不是照搬章节。</div></div>' +
    '<div class="page-actions"><button class="btn" id="kbHome">🏠 回到首页</button><button class="btn" id="kbBackfill">从已有项目补录</button></div></div>';
  const empty = '<div class="placeholder">知识库还是空的。<br>等您把一个项目「关闭并归档」之后，这个项目的重要技术内容、重要商务内容、专家画像就会自动存进来。<br><br>' +
    '<span class="muted" style="font-size:13px">没有历史数据也不影响使用——AI 会按通用策略先建画像，数据越多越贴合您公司。</span></div>';
  const cards = list.map((k) => {
    const c = k.counts || {};
    const hasP = !!(k.hasProfile && (k.hasProfile.tech || k.hasProfile.biz));
    const dirTxt = (k.direction && (k.direction.tech || k.direction.biz)) || '';
    const broken = Array.isArray(k.missing) && k.missing.length;
    return '<div class="kb-i' + (broken ? ' kb-broken' : '') + '" data-kb="' + esc(k.projectId) + '">' +
      '<div class="kb-h"><b>' + esc(k.name || '未命名项目') + '</b>' +
        (hasP ? '<span class="tag tag-green">有画像</span>' : '<span class="tag tag-gray">无画像</span>') +
        (broken ? '<span class="tag tag-red">文件缺失</span>' : '') + '</div>' +
      '<div class="kb-m">' + esc(k.code || '') + (dirTxt ? ' · ' + esc(dirTxt) : '') + '</div>' +
      (broken ? '<div class="kb-warn">知识库里有记录，但这几份文件不见了：' + esc(k.missing.join('、')) +
        '。点「补录」可以按项目现有内容重建。</div>' : '') +
      '<div class="kb-c"><span>知识卡 技术 <b>' + ((k.cardCounts && k.cardCounts.tech) || 0) + '</b> 张</span>' +
        '<span>商务 <b>' + ((k.cardCounts && k.cardCounts.biz) || 0) + '</b> 张</span>' +
        '<span class="muted">原章节 技术 ' + (c.tech || 0) + ' / 商务 ' + (c.biz || 0) + '</span>' +
        (k.purchaseMethod ? '<span>' + esc(k.purchaseMethod) + '</span>' : '') + '</div>' +
      '<div class="kb-a"><span class="muted">归档于 ' + esc(String(k.archivedAt || '').slice(0, 10)) + '</span>' +
        '<button class="btn tiny" data-kbfix="' + esc(k.projectId) + '">补录</button>' +
        '<button class="btn tiny" data-kbview="' + esc(k.projectId) + '">查看</button>' +
        '<button class="btn tiny danger" data-kbdel="' + esc(k.projectId) + '">删除</button></div></div>';
  }).join('');
  const stat = d.stat || {};
  const statBar = list.length
    ? '<div class="kb-stat">' +
        '<span>已沉淀项目 <b>' + (stat.projects || list.length) + '</b> 个</span>' +
        '<span>重要技术内容 <b>' + (stat.techChapters || 0) + '</b> 章</span>' +
        '<span>重要商务内容 <b>' + (stat.bizChapters || 0) + '</b> 章</span>' +
        '<span>技术画像 <b>' + (stat.techProfiles || 0) + '</b> 份</span>' +
        '<span>商务画像 <b>' + (stat.bizProfiles || 0) + '</b> 份</span>' +
        (stat.broken ? '<span class="kb-stat-bad">' + stat.broken + ' 个项目的文件缺失，点「补录」可重建</span>' : '') +
        '<span class="muted">存放位置：' + esc(d.root || '') + '</span>' +
      '</div>'
    : '';
  $('#main').innerHTML = '<div class="page">' + head + statBar +
    (list.length ? '<div class="kb-list">' + cards + '</div>' : empty) + '</div>';
  // v1.2.0：知识库页的「回到首页」（之前只画了按钮没绑事件，点了没反应）
  const kh = $('#kbHome');
  if (kh) kh.onclick = () => { S.archived = false; const ab = $('#btnArchived'); if (ab) ab.textContent = '查看已归档'; goHome(); };
  const bf = $('#kbBackfill');
  if (bf) bf.onclick = () => backfillPicker();
  document.querySelectorAll('[data-kbfix]').forEach((b) => {
    b.onclick = (ev) => { ev.stopPropagation(); rebuildKnowledgeDialog(b.dataset.kbfix, true); };
  });
  document.querySelectorAll('[data-kbview]').forEach((b) => {
    b.onclick = (ev) => { ev.stopPropagation(); renderKnowledgeDetail(b.dataset.kbview); };
  });
  document.querySelectorAll('[data-kbdel]').forEach((b) => {
    b.onclick = async (ev) => {
      ev.stopPropagation();
      const pid = b.dataset.kbdel;
      openModal('<h3>从知识库里删掉这个项目？</h3><p>只会删掉知识库里的这份经验记录，<b>不会动归档文件夹里的任何文件</b>。</p>' +
        '<div class="modal-foot"><button class="btn" data-close>取消</button><button class="btn danger" id="okKbDel">删掉</button></div>');
      $('#okKbDel').onclick = async () => {
        try { await api('DELETE', '/api/knowledge/' + pid); closeModal(); toast('已删除'); renderKnowledgeList(); }
        catch (e) { toast(e.message, true); }
      };
    };
  });
}

// v1.1.1：从已有项目里挑一个补录进知识库
async function backfillPicker() {
  let d;
  try { d = await api('GET', '/api/projects?archived=1'); } catch (e) { toast(e.message, true); return; }
  const list = (d.projects || []);
  if (!list.length) { toast('还没有任何项目可以补录', true); return; }
  const rows = list.map((p) =>
    '<label class="pick-row"><input type="radio" name="bfpid" value="' + esc(p.id) + '">' +
    '<span><b>' + esc(p.name) + '</b><span class="muted"> · ' + esc(p.code || '无编号') + ' · ' +
    (p.status === 'archived' ? '已归档' : '在办') + '</span></span></label>').join('');
  openModal('<h3>从已有项目补录知识库</h3>' +
    '<p>选一个项目，按它现在的章节内容生成知识库记录。建议选已经投完、内容定稿的项目。</p>' +
    '<div class="pick-list">' + rows + '</div>' +
    '<div class="modal-foot"><button class="btn" data-close>取消</button><button class="btn primary" id="okBackfill">下一步</button></div>');
  $('#okBackfill').onclick = () => {
    const sel = document.querySelector('input[name="bfpid"]:checked');
    if (!sel) { toast('先选一个项目', true); return; }
    closeModal();
    rebuildKnowledgeDialog(sel.value, true);
  };
}

// v1.1.1：补录 / 重建知识库记录
function rebuildKnowledgeDialog(pid, warn) {
  openModal('<h3>' + (warn ? '补录知识库记录' : '重建知识库记录') + '</h3>' +
    '<p>会按这个项目<b>现在的内容</b>重新生成一份知识库记录：重要技术章节、重要商务章节、专家画像、生成记录。</p>' +
    '<p class="muted" style="font-size:13px">只影响知识库，不动归档文件夹，也不动项目状态。原有的同名记录会被覆盖。</p>' +
    (warn ? '<p class="muted" style="font-size:13px">如果项目已经归档、本地制作稿不在了，会自动改用归档文件夹里的 03制作/制作稿.json。</p>' : '') +
    '<div class="modal-foot"><button class="btn" data-close>取消</button><button class="btn primary" id="okKbFix">开始补录</button></div>');
  $('#okKbFix').onclick = async () => {
    const btn = $('#okKbFix');
    btn.disabled = true; btn.textContent = '补录中…';
    try {
      const r = await api('POST', '/api/knowledge/' + pid + '/rebuild', {});
      closeModal();
      if (!r.hasDraft) {
        toast('这个项目还没有生成过投标文件章节，补录不到内容', true);
        renderKnowledgeList();
        return;
      }
      toast('已补录：技术 ' + r.chapters.tech + ' 章 / 商务 ' + r.chapters.biz + ' 章');
      openModal('<h3>补录完成</h3>' +
        '<p>重要技术 <b>' + r.chapters.tech + '</b> 章、重要商务 <b>' + r.chapters.biz + '</b> 章，生成记录 <b>' + r.history + '</b> 条。</p>' +
        (r.fromArchive ? '<p class="muted" style="font-size:13px">内容取自归档文件夹里的制作稿。</p>' : '') +
        (r.chapters.tech + r.chapters.biz === 0
          ? '<p class="warn-text">这个项目的章节都还没有标注「重要技术 / 重要商务」，所以知识库里没有章节内容。可以到「投标文件」页给章节打标签后再补录。</p>' : '') +
        '<div class="modal-foot"><button class="btn primary" data-close>知道了</button></div>');
      renderKnowledgeList();
    } catch (e) {
      btn.disabled = false; btn.textContent = '开始补录';
      toast(e.message, true);
    }
  };
}

async function renderKnowledgeDetail(pid) {
  let d;
  try { d = await api('GET', '/api/knowledge/' + pid); } catch (e) {
    toast(e.message, true); return;
  }
  // v1.2.0：知识卡类型 + 这个项目的卡片
  try {
    if (!S.cardTypes) { const ct = await api('GET', '/api/card-types'); S.cardTypes = ct.types || []; }
    const cc = await api('GET', '/api/knowledge/' + pid + '/cards');
    S.kbCards = { projectId: pid, types: cc.types || [], cards: cc.cards || {} };
  } catch (e) { S.kbCards = { projectId: pid, types: [], cards: {} }; }
  const k = d.knowledge || (d && d.record ? d : {});
  const rec = k.record || {};
  const chs = {
    tech: (k.chapters && k.chapters.tech && k.chapters.tech.chapters) || [],
    biz: (k.chapters && k.chapters.biz && k.chapters.biz.chapters) || []
  };
  const hist = (k.history && k.history.records) || [];
  const prof = k.profiles || {};
  const indep = (k.indep && k.indep.sessions) || [];
  // v1.1.4：章节里附带的图表（表格给行列，图片走原路径引用）
  const kbCharts = (c) => {
    const list = Array.isArray(c.charts) ? c.charts : [];
    if (!list.length) return '';
    const one = (x) => {
      if (x.kind === 'table') {
        const rows = Array.isArray(x.rows) ? x.rows : [];
        if (!rows.length) return '';
        const keys = Array.isArray(x.columns) && x.columns.length ? x.columns.map((v) => (v && typeof v === 'object' ? v.k : v)) : Object.keys(rows[0] || {});
        const head = (Array.isArray(x.columns) && x.columns.length && typeof x.columns[0] === 'object')
          ? x.columns.map((v) => esc(v.t || v.k)).join('')
          : keys.map((k) => esc(k)).join('');
        return '<div class="kb-chart"><div class="kb-chart-h">📊 ' + esc(x.title || '表格') + '（' + (x.rowCount || rows.length) + ' 行）</div>' +
          '<div class="kb-tbl-wrap"><table class="tbl kb-tbl"><thead><tr>' + head + '</tr></thead><tbody>' +
          rows.slice(0, 60).map((r) => '<tr>' + keys.map((k) => '<td>' + esc(String((r && r[k]) != null ? r[k] : '')) + '</td>').join('') + '</tr>').join('') +
          '</tbody></table></div>' + (rows.length > 60 ? '<div class="muted" style="font-size:12px">只显示前 60 行</div>' : '') + '</div>';
      }
      if (x.kind === 'image') {
        const base = String(x.pngRel || '').split('/').pop();
        const url = base ? '/api/knowledge-image/' + encodeURIComponent(pid) + '/' + encodeURIComponent(base) : '';
        return '<div class="kb-chart"><div class="kb-chart-h">🖼 ' + esc(x.title || x.caption || '图') + '</div>' +
          (url ? '<a class="kb-img" href="' + url + '" target="_blank" rel="noopener"><img src="' + url + '" alt="' + esc(x.title || '') + '"></a>' : '<div class="muted" style="font-size:12px">图片文件已不在原位置</div>') +
          (x.caption ? '<div class="muted" style="font-size:12px;margin-top:4px">' + esc(x.caption) + '</div>' : '') +
          (x.reason ? '<div class="muted" style="font-size:12px">用途：' + esc(x.reason) + '</div>' : '') + '</div>';
      }
      return '';
    };
    return '<div class="kb-charts">' + list.map(one).join('') + '</div>';
  };
  const block = (role, title, cls) => {
    const arr = chs[role] || [];
    return '<div class="card kb-sec"><div class="kb-sec-h"><span class="tag ' + cls + '">' + title + '</span>' +
      '<span class="muted">' + arr.length + ' 章</span></div>' +
      (arr.length ? arr.map((c) => {
        const cks = Array.isArray(c.charts) ? c.charts : [];
        const nt = cks.filter((x) => x.kind === 'table').length;
        const ni = cks.filter((x) => x.kind === 'image').length;
        const cnt = (nt ? ' · 表 ' + nt : '') + (ni ? ' · 图 ' + ni : '');
        return '<details class="kb-ch"><summary>' + esc((c.number ? c.number + ' ' : '') + c.title) +
        ' <span class="muted">' + (String(c.body || '').length) + ' 字' + cnt + '</span></summary>' +
        '<pre class="kb-body">' + esc(String(c.body || '').slice(0, 4000)) + (String(c.body || '').length > 4000 ? '\n…（只显示前 4000 字）' : '') + '</pre>' +
        kbCharts(c) + '</details>';
      }).join('')
        : '<div class="muted" style="font-size:13px;padding:6px 0">没有记录</div>') + '</div>';
  };
  const profBlock = (role, title, cls) => {
    const p = prof[role];
    if (!p || !p.data) return '';
    const pd = p.data;
    return '<div class="card kb-sec"><div class="kb-sec-h"><span class="tag ' + cls + '">' + title + '画像</span>' +
      (p.confirmed ? '<span class="muted">已确认</span>' : '<span class="muted">未确认</span>') + '</div>' +
      (pd.summary ? '<div class="pf-head" style="margin:4px 0 8px">' + esc(pd.summary) + '</div>' : '') +
      (pd.direction ? '<div class="muted" style="font-size:13px">方向：' + esc(pd.direction) + '</div>' : '') +
      (Array.isArray(p.revisions) && p.revisions.length
        ? '<div class="muted" style="font-size:13px">共修改 ' + p.revisions.length + ' 次：' +
          p.revisions.slice(-5).map((r) => esc(String(r.at || '').slice(0, 10)) + (r.note ? '（' + esc(r.note) + '）' : '')).join('、') + '</div>'
        : '') + '</div>';
  };
  // v1.1.4：独立编制里画过的图/表，也在这里看得到（图片只存原路径引用）
  const indepBlock = () => {
    const list = indep.filter((x) => x && (String(x.text || '').trim() || (x.charts || []).length));
    if (!list.length) return '';
    return '<div class="card kb-sec"><div class="kb-sec-h"><span class="tag tag-gray">独立编制</span>' +
      '<span class="muted">' + list.length + ' 章</span></div>' +
      list.map((x) => {
        const cks = Array.isArray(x.charts) ? x.charts : [];
        const fake = { charts: cks.map((c) => ({
          kind: (c.table && Array.isArray(c.table.rows)) ? 'table' : (c.pngRel ? 'image' : 'table'),
          chartType: c.chartType || '', title: c.title || '', caption: c.caption || '', reason: c.reason || '',
          pngRel: c.pngRel || '',
          columns: (c.table && c.table.columns) || (c.spec && c.spec.columns) || null,
          rows: (c.table && c.table.rows) || (c.spec && c.spec.rows) || [],
          rowCount: ((c.table && c.table.rows) || (c.spec && c.spec.rows) || []).length
        })) };
        const cnt = (cks.length ? ' · 图表 ' + cks.length : '');
        return '<details class="kb-ch"><summary>' + esc((x.chapterTitle || x.title || '未命名')) +
          ' <span class="muted">' + (String(x.text || '').length) + ' 字' + cnt + '</span></summary>' +
          '<pre class="kb-body">' + esc(String(x.text || '').slice(0, 4000)) + '</pre>' + kbCharts(fake) + '</details>';
      }).join('') + '</div>';
  };
  // v1.2.0：知识卡区（核心）—— 可编辑、可新增、可删除、可重新提炼
  const CARD_TYPES_LOCAL = (S.cardTypes || []);
  const typeName = (k) => {
    const x = CARD_TYPES_LOCAL.find((y) => y.key === k);
    return x ? x.name : k;
  };
  const cardState = S.kbCards && S.kbCards.projectId === pid ? S.kbCards : null;
  const cardsBlock = (role, title, cls) => {
    const pack = cardState && cardState.cards ? cardState.cards[role] : null;
    const list = (pack && pack.cards) || [];
    const err = (pack && pack.extractError) || '';
    const at = (pack && pack.extractedAt) || '';
    const body = list.length
      ? CARD_TYPES_LOCAL.map((tp) => {
          const sub = list.filter((c) => c.type === tp.key);
          if (!sub.length) return '';
          return '<div class="kbc-group"><div class="kbc-group-h">' + esc(tp.name) + '<span class="muted">' + esc(tp.desc) + '</span></div>' +
            sub.map((c) => '<div class="kbc" data-card="' + esc(c.id) + '" data-kind="' + role + '">' +
              '<div class="kbc-h"><b>' + esc(c.title) + '</b>' +
                '<span class="kbc-meta">★' + (c.quality || 3) + ' · 用过 ' + (c.usedCount || 0) + ' 次' + (c.edited ? ' · 已手改' : '') + '</span></div>' +
              '<div class="kbc-body">' + esc(c.body) + '</div>' +
              (c.tags && c.tags.length ? '<div class="kbc-tags">' + c.tags.map((x) => '<span>' + esc(x) + '</span>').join('') + '</div>' : '') +
              '<div class="kbc-a"><button class="btn tiny" data-kbcedit="' + esc(c.id) + '" data-kind="' + role + '">编辑</button>' +
                '<button class="btn tiny danger" data-kbcdel="' + esc(c.id) + '" data-kind="' + role + '">删除</button></div>' +
            '</div>').join('') + '</div>';
        }).join('')
      : '<div class="muted" style="font-size:13px;padding:8px 0">还没有知识卡。' + (at ? '' : '点右上角「重新提炼」让 AI 从内容里提炼。') + '</div>';
    return '<div class="card kb-sec"><div class="kb-sec-h"><span class="tag ' + cls + '">' + title + '知识卡</span>' +
      '<span class="muted">' + list.length + ' 张' + (at ? ' · 提炼于 ' + esc(String(at).slice(0, 10)) : '') + '</span>' +
      '<span style="flex:1"></span>' +
      '<button class="btn tiny" data-kbcadd="' + role + '">＋ 手工新增</button>' +
      '<button class="btn tiny" data-kbcextract="' + role + '">重新提炼</button></div>' +
      (err ? '<div class="kb-warn">上次提炼有问题：' + esc(err) + '</div>' : '') +
      body + '</div>';
  };

  $('#main').innerHTML = '<div class="page">' +
    '<div class="page-head"><div><button class="btn tiny" id="kbBack">← 返回知识库</button>' +
    '<div class="page-title" style="margin-top:8px">' + esc(rec.name || '未命名项目') + '</div>' +
    '<div class="page-sub">' + esc(rec.code || '') + (rec.purchaseMethod ? ' · ' + esc(rec.purchaseMethod) : '') +
      (rec.archivedAt ? ' · 归档于 ' + esc(String(rec.archivedAt).slice(0, 10)) : '') + '</div></div></div>' +
    cardsBlock('tech', '技术', 'tag-blue') + cardsBlock('biz', '商务', 'role-biz') +
    profBlock('tech', '技术专家', 'tag-blue') + profBlock('biz', '商务专家', 'role-biz') +
    block('tech', '重要技术内容', 'tag-blue') + block('biz', '重要商务内容', 'role-biz') + indepBlock() +
    '<div class="card kb-sec"><div class="kb-sec-h"><span class="tag tag-gray">生成记录</span>' +
      '<span class="muted">' + hist.length + ' 条</span></div>' +
      (hist.length ? '<table class="tbl"><thead><tr><th>章节</th><th>性质</th><th>AI 生成次数</th><th>最终字数</th><th>是否保留</th></tr></thead><tbody>' +
        hist.map((h) => '<tr><td>' + esc(h.title || '') + '</td><td>' + esc(h.role === 'tech' ? '技术' : h.role === 'biz' ? '商务' : '') + '</td>' +
          '<td>' + (h.aiTimes || 0) + '</td><td>' + (h.chars || 0) + '</td><td>' + (h.kept ? '保留' : '被替换') + '</td></tr>').join('') +
        '</tbody></table>' : '<div class="muted" style="font-size:13px">没有记录</div>') + '</div>' +
    '</div>';
  const back = $('#kbBack');
  if (back) back.onclick = () => renderKnowledgeList();
  bindCardActions(pid);
}

/* v1.2.0：知识卡的增删改与重新提炼 */
function bindCardActions(pid) {
  document.querySelectorAll('[data-kbcadd]').forEach((b) => {
    b.onclick = () => cardEditDialog(pid, b.dataset.kbcadd, null);
  });
  document.querySelectorAll('[data-kbcedit]').forEach((b) => {
    b.onclick = () => cardEditDialog(pid, b.dataset.kind, b.dataset.kbcedit);
  });
  document.querySelectorAll('[data-kbcdel]').forEach((b) => {
    b.onclick = async () => {
      const kind = b.dataset.kind;
      const id = b.dataset.kbcdel;
      openModal('<h3>删除这张知识卡？</h3><p class="muted" style="margin-top:0">删掉以后，AI 编制标书时就不会再参考它了。</p>' +
        '<div class="modal-foot"><button class="btn" data-close>取消</button><button class="btn danger" id="okCardDel">删除</button></div>');
      $('#okCardDel').onclick = async () => {
        try {
          await api('DELETE', '/api/knowledge/' + pid + '/cards/' + kind + '/' + id);
          closeModal(true);
          toast('已删除');
          renderKnowledgeDetail(pid);
        } catch (e) { toast(e.message, true); }
      };
    };
  });
  document.querySelectorAll('[data-kbcextract]').forEach((b) => {
    b.onclick = () => cardExtractDialog(pid);
  });
}

// 手工新增 / 编辑一张知识卡
async function cardEditDialog(pid, kind, cardId) {
  if (!S.cardTypes || !S.cardTypes.length) { try { const r = await api('GET', '/api/card-types'); S.cardTypes = r.types || []; } catch {} }
  const types = S.cardTypes || [];
  const pack = S.kbCards && S.kbCards.cards ? S.kbCards.cards[kind] : null;
  const card = cardId ? ((pack && pack.cards) || []).find((c) => c.id === cardId) : null;
  openModal('<h3>' + (card ? '编辑知识卡' : '新增知识卡') + '</h3>' +
    '<div class="grid">' +
      '<div class="field"><label>类型</label><select id="kceType">' +
        types.map((t) => '<option value="' + esc(t.key) + '"' + (card && card.type === t.key ? ' selected' : '') + '>' + esc(t.name) + '</option>').join('') +
      '</select></div>' +
      '<div class="field"><label>重要程度（1～5）</label><select id="kceQ">' +
        [5, 4, 3, 2, 1].map((n) => '<option value="' + n + '"' + (card && card.quality === n ? ' selected' : '') + '>' + n + ' 分</option>').join('') +
      '</select><div class="hint">低于 3 分不会被 AI 采用</div></div>' +
      '<div class="field full"><label>标题（不超过 20 字）</label><input id="kceTitle" value="' + esc(card ? card.title : '') + '" placeholder="例如：三级质量复核机制"></div>' +
      '<div class="field full"><label>正文</label><textarea id="kceBody" rows="8" placeholder="写成可以直接抄进下一份标书的做法，60～400 字">' + esc(card ? card.body : '') + '</textarea></div>' +
      '<div class="field full"><label>关键词（逗号分隔）</label><input id="kceTags" value="' + esc(card && card.tags ? card.tags.join('，') : '') + '" placeholder="例如：质量管理，复核，闭环"></div>' +
    '</div>' +
    '<div class="modal-foot"><button class="btn" data-close>取消</button><button class="btn primary" id="okCardSave">保存</button></div>');
  $('#okCardSave').onclick = async () => {
    const body = {
      kind,
      type: $('#kceType').value,
      quality: Number($('#kceQ').value) || 4,
      title: $('#kceTitle').value.trim(),
      body: $('#kceBody').value.trim(),
      tags: $('#kceTags').value.split(/[，,、\s]+/).map((x) => x.trim()).filter(Boolean)
    };
    if (!body.title) { toast('请填标题', true); return; }
    if (body.body.length < 20) { toast('正文太短了，至少写 20 个字', true); return; }
    try {
      if (card) await api('PUT', '/api/knowledge/' + pid + '/cards/' + kind + '/' + card.id, body);
      else await api('POST', '/api/knowledge/' + pid + '/cards/add', body);
      closeModal(true);
      toast('已保存');
      renderKnowledgeDetail(pid);
    } catch (e) { toast(e.message, true); }
  };
}

// 重新提炼知识卡（老项目升级 / 不满意重跑）
function cardExtractDialog(pid) {
  openModal('<h3>重新提炼知识卡？</h3>' +
    '<p class="muted" style="margin-top:0">AI 会重新读这个项目已沉淀的技术 / 商务内容，重新提炼一遍知识卡。<br>' +
    '你自己手工加的和改过的卡片会保留，AI 提炼出来的会被替换。</p>' +
    '<div class="modal-foot"><button class="btn" data-close>取消</button><button class="btn primary" id="okKbEx">开始提炼</button></div>');
  $('#okKbEx').onclick = async () => {
    try {
      const r = await api('POST', '/api/knowledge/' + pid + '/cards/extract');
      closeModal(true);
      toast('已开始提炼，进度在左侧任务条里');
      kbCardPoll(pid, r.taskId);
    } catch (e) { toast(e.message, true); }
  };
}

function kbCardPoll(pid, taskId) {
  const tick = async () => {
    let t = null;
    try { t = await api('GET', '/api/card-tasks/' + taskId); } catch { t = null; }
    if (!t) { setTimeout(tick, 2500); return; }
    toast(t.message || '正在提炼…');
    if (t.state === 'running') { setTimeout(tick, 2500); return; }
    if (t.state === 'error') toast('提炼失败：' + (t.error || ''), true);
    else toast(t.message || '提炼完成');
    if (S.kbCards && S.kbCards.projectId === pid) renderKnowledgeDetail(pid);
  };
  setTimeout(tick, 1500);
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
  // v1.1.5：左侧栏固定「回到首页」，任何页面都能一键回来（不会打断后台任务）
  const bh = $('#btnHome');
  if (bh) bh.onclick = () => { S.archived = false; const ab = $('#btnArchived'); if (ab) ab.textContent = '查看已归档'; goHome(); };
  // v1.1.5：全局任务中心 + 心跳（关掉网页自动关服务）
  startTaskPolling();
  startHeartbeat();
  const btnKB = $('#btnKB');
  if (btnKB) btnKB.onclick = () => { S.archived = false; $('#btnArchived').textContent = '查看已归档'; renderKnowledgeList(); };
  $('#btnSettings').onclick = settingsDialog;
  // v1.1.3：侧栏项目查找（边打边筛）
  const ps = $('#projSearch');
  if (ps) {
    ps.value = S.projKw || '';
    ps.oninput = () => { S.projKw = ps.value; renderSidebar(); };
  }
  $('#btnArchived').onclick = async () => {
    S.archived = !S.archived;
    $('#btnArchived').textContent = S.archived ? '返回项目列表' : '查看已归档';
    const nl = $('#navLabel');
    if (nl) nl.textContent = S.archived ? '已归档的项目' : '我的项目';
    if (ps) ps.placeholder = S.archived ? '查找归档项目（名称 / 招标人 / 编号）' : '查找项目（名称 / 招标人 / 编号）';
    S.projKw = ''; S.archKw = '';
    if (ps) ps.value = '';
    await refreshProjects();
    if (S.archived) {
      try { await renderArchiveList(); } catch (e) { toast(e.message, true); }
    } else {
      await refreshProjects();
    }
  };
  await loadHealth();
  try { await refreshProjects(); } catch (e) { toast('读取项目列表失败：' + e.message, true); }
  // 支持刷新后回到原项目；没有项目就显示首页
  const m = /^#\/p\/([^/]+)(?:\/([a-z]+))?/.exec(location.hash || '');
  if (m) {
    S.tab = m[2] || 'info';
    try { await openProject(decodeURIComponent(m[1]), true); } catch (e) {}
  } else {
    renderHome();
  }
  window.addEventListener('hashchange', () => {
    const mm = /^#\/p\/([^/]+)(?:\/([a-z]+))?/.exec(location.hash || '');
    if (mm) { if (!S.cur || S.cur.id !== decodeURIComponent(mm[1])) openProject(decodeURIComponent(mm[1]), true); }
    else if (S.cur) goHome();
  });
  // 每分钟刷新倒计时
  setInterval(() => { if (S.cur) renderSidebar(); }, 60000);
}

boot();