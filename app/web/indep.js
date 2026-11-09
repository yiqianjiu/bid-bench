/* 独立编制窗口（v1.1.2）
 * 一个独立的浏览器窗口：左边和 AI 聊，右边看稿子，可以生成图表、导出验收用 Word。
 * 所有会话与稿件都存在服务端（数据\独立编制\<项目id>\<章节id>.json），关掉再开原样恢复。 */
(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const q = new URLSearchParams(location.search);
  const PID = q.get('p');
  const DOC = q.get('d');
  const CID = q.get('c');

  const S = { session: null, busy: '', outDir: '' };

  function toast(msg, bad) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show' + (bad ? ' bad' : '');
    clearTimeout(t._tm);
    t._tm = setTimeout(() => { t.className = 'toast'; }, bad ? 5200 : 3000);
  }

  async function api(method, url, body) {
    const r = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    let d = null;
    try { d = await r.json(); } catch (e) { d = null; }
    if (!r.ok) {
      const e = new Error((d && (d.message || d.error)) || ('请求失败（' + r.status + '）'));
      e.code = d && d.code;
      e.data = d;
      throw e;
    }
    return d;
  }

  const base = '/api/projects/' + encodeURIComponent(PID) + '/draft/' + encodeURIComponent(DOC) + '/chapter/' + encodeURIComponent(CID) + '/indep';

  function setBusy(on, text) {
    S.busy = on ? (text || '处理中…') : '';
    ['#ipGen', '#ipApply', '#ipSend', '#ipExport', '#ipRedoAll', '#ipWriteBack'].forEach((k) => { const el = $(k); if (el) el.disabled = !!on; });
    $('#ipMsg').textContent = S.busy || '';
  }

  /* ---------------- 渲染 ---------------- */
  function renderMsgs() {
    const list = (S.session && S.session.messages) || [];
    if (!list.length) {
      $('#ipMsgs').innerHTML = '<div class="indep-empty">还没有对话。<br>可以直接说「先按招标文件写一版」，也可以点右边的「编制生成」。</div>';
      return;
    }
    $('#ipMsgs').innerHTML = list.map((m) => {
      const mine = m.role === 'user';
      return '<div class="msg ' + (mine ? 'me' : 'ai') + '">' +
        '<div class="msg-h">' + (mine ? '我' : 'AI') + '<span class="muted">' + esc((m.at || '').replace('T', ' ').slice(0, 16)) + '</span></div>' +
        '<div class="msg-b">' + esc(m.content).replace(/\n/g, '<br>') + '</div></div>';
    }).join('');
    const box = $('#ipMsgs');
    box.scrollTop = box.scrollHeight;
  }

  function renderCharts() {
    const cs = (S.session && S.session.charts) || [];
    if (!cs.length) {
      $('#ipCharts').innerHTML = '<div class="muted" style="font-size:12px">这一稿暂时没有配图。可以在左边说「加一张流程图/甘特图」，AI 判断该画什么。</div>';
      return;
    }
    $('#ipCharts').innerHTML = cs.map((c) => {
      let img;
      if (c.chartType === 'table' && c.table) {
        img = '<table class="mini-tbl"><thead><tr>' + c.table.columns.map((x) => '<th>' + esc(x) + '</th>').join('') + '</tr></thead><tbody>' +
          c.table.rows.map((r) => '<tr>' + c.table.columns.map((_, i) => '<td>' + esc(r[i] == null ? '' : r[i]) + '</td>').join('') + '</tr>').join('') +
          '</tbody></table>';
      } else if (c.url) {
        img = '<img src="' + esc(c.url) + '?t=' + encodeURIComponent(c.at || '') + '" alt="">';
      } else {
        img = '<div class="muted">图没画出来</div>';
      }
      return '<div class="chart-card" data-chart="' + esc(c.id) + '">' +
        '<div class="chart-h"><b>' + esc(c.title || (c.chartType === 'table' ? '建议表格' : '示意图')) + '</b><span class="tag">' + (c.chartType === 'table' ? '表格' : '示意图') + '</span></div>' +
        (c.reason ? '<div class="chart-r">' + esc(c.reason) + '</div>' : '') +
        '<div class="chart-img">' + img + '</div>' +
        (c.caption ? '<div class="chart-c">' + esc(c.caption) + '</div>' : '') +
        '<div class="row" style="gap:6px">' +
          '<button class="btn tiny" data-redo="' + esc(c.id) + '">' + (c.chartType === 'table' ? '改这张表' : '重新画一张') + '</button>' +
          '<button class="btn tiny" data-drop="' + esc(c.id) + '">不要这张</button>' +
        '</div></div>';
    }).join('');
    document.querySelectorAll('[data-redo]').forEach((el) => {
      el.onclick = () => redoChart(el.dataset.redo);
    });
    document.querySelectorAll('[data-drop]').forEach((el) => {
      el.onclick = async () => {
        S.session.charts = (S.session.charts || []).filter((x) => x.id !== el.dataset.drop);
        await saveText(true);
        renderCharts();
      };
    });
  }

  function renderHints() {
    const hs = (S.session && S.session.hints) || [];
    if (!hs.length) { $('#ipHints').innerHTML = '<div class="muted" style="font-size:12px">暂时没有。</div>'; return; }
    $('#ipHints').innerHTML = hs.map((h) => '<div class="hint-card">⚠ ' + esc(h.text) + '</div>').join('');
  }

  function renderAll() {
    const s = S.session || {};
    $('#ipTitle').textContent = (s.chapterTitle || '独立编制');
    $('#ipRole').textContent = s.role === 'biz' ? '重要商务' : '重要技术';
    $('#ipProj').textContent = s.projectName || '';
    const n = (s.text || '').length;
    $('#ipMeta').textContent = n ? ('已写 ' + n + ' 字 · ' + ((s.charts || []).length) + ' 张图 · 更新于 ' + String(s.updatedAt || '').replace('T', ' ').slice(0, 16)) : '还没有内容';
    $('#ipText').value = s.text || '';
    if (!$('#ipDir').value) $('#ipDir').value = S.outDir || '';
    renderMsgs();
    renderCharts();
    renderHints();
  }

  /* ---------------- 数据 ---------------- */
  async function load() {
    try {
      const d = await api('GET', base);
      S.session = d.session;
      S.outDir = d.outDir || '';
      if (!S.session) { toast('这个章节打不开', true); return; }
      if (!d.apiReady) toast('还没配 DeepSeek API Key，AI 功能用不了（可以在工作台「设置」里填）', true);
      renderAll();
    } catch (e) { toast(e.message, true); }
  }

  async function saveText(silent) {
    try {
      await api('POST', base + '/save', { text: $('#ipText').value, charts: S.session.charts, hints: S.session.hints });
      S.session.text = $('#ipText').value;
      if (!silent) toast('已保存');
    } catch (e) { toast(e.message, true); }
  }

  async function send() {
    const msg = $('#ipInput').value.trim();
    if (!msg) return;
    if (S.busy) return;
    $('#ipInput').value = '';
    S.session.messages = (S.session.messages || []).concat([{ role: 'user', content: msg, at: new Date().toISOString() }]);
    renderMsgs();
    setBusy(true, 'AI 正在想…');
    try {
      const d = await api('POST', base + '/chat', { message: msg, text: $('#ipText').value });
      S.session = d.session;
      renderAll();
    } catch (e) {
      toast(e.message, true);
      S.session.messages.pop();
      renderMsgs();
    } finally { setBusy(false); }
  }

  async function generate() {
    if (S.busy) return;
    setBusy(true, '正在按招标文件写这一章，大约 1~3 分钟…');
    try {
      const d = await api('POST', base + '/generate', { text: $('#ipText').value });
      S.session = d.session;
      renderAll();
      toast('写好了，看看右边。不满意就在左边说怎么改。');
    } catch (e) { toast(e.message, true); }
    finally { setBusy(false); }
  }

  async function applyUpdate() {
    if (S.busy) return;
    setBusy(true, '正在按你的要求改稿，大约 1~3 分钟…');
    try {
      const d = await api('POST', base + '/update', { text: $('#ipText').value });
      S.session = d.session;
      renderAll();
      toast('已按对话更新');
    } catch (e) { toast(e.message, true); }
    finally { setBusy(false); }
  }

  async function redoChart(id) {
    const ins = prompt('想怎么改？直接说（例如：横轴改成按天、第 2 步拆成两步、加一列负责人）。留空就重新生成一版。');
    if (ins === null) return;
    setBusy(true, '正在改…');
    try {
      const d = await api('POST', base + '/chart/' + encodeURIComponent(id), { instruction: ins });
      S.session = d.session;
      renderAll();
      toast('改好了');
    } catch (e) { toast(e.message, true); }
    finally { setBusy(false); }
  }

  async function redoAll() {
    if (!(S.session && (S.session.charts || []).length)) { toast('现在还没有图'); return; }
    setBusy(true, '正在按当前设定把图重画一遍…');
    try {
      const d = await api('POST', base + '/redocharts', {});
      S.session = d.session;
      renderAll();
      const bad = (d.results || []).filter((x) => !x.ok).length;
      toast(bad ? ('重画完成，有 ' + bad + ' 张还是画不出来，可以点「重新画一张」让 AI 换个画法') : '图都重画好了');
    } catch (e) { toast(e.message, true); }
    setBusy(false);
  }

  async function exportWord() {
    if (S.busy) return;
    setBusy(true, '正在生成 Word…');
    try {
      const dir = $('#ipDir').value.trim();
      const d = await api('POST', base + '/export', { dir, text: $('#ipText').value });
      S.outDir = d.dir;
      $('#ipDir').value = d.dir;
      setBusy(false);
      toast('已导出：' + d.file);
      // 导出后立刻提示保存路径 + 一键打开文件夹（放到显眼的顶部提示条里）
      $('#ipMsg').innerHTML = '已保存到：<b>' + esc(d.file) + '</b> <a href="#" id="ipGoDir">打开文件夹</a>';
      const bar = $('#ipNotice');
      if (bar) { bar.hidden = false; bar.innerHTML = '✅ 验收用 Word 已生成：<b>' + esc(d.file) + '</b>　<a href="#" id="ipGoDir2">打开文件夹</a>'; const g2 = $('#ipGoDir2'); if (g2) g2.onclick = (ev) => { ev.preventDefault(); api('POST', '/api/reveal', { path: d.file }).catch((e) => toast(e.message, true)); }; }
      const g = $('#ipGoDir');
      if (g) g.onclick = (ev) => { ev.preventDefault(); api('POST', '/api/reveal', { path: d.file }).catch((e) => toast(e.message, true)); };
    } catch (e) { setBusy(false); toast(e.message, true); }
  }

  async function writeBack() {
    if (!confirm('把这份稿子写回投标文件里这一章的正文？\n（原来的正文会被覆盖，但可以再用「AI 写正文」重新生成）')) return;
    setBusy(true, '正在写回…');
    try {
      const d = await api('POST', base + '/writeback', { text: $('#ipText').value });
      setBusy(false);
      toast('已写回本章正文（' + (d.chars || 0) + ' 字）');
    } catch (e) { setBusy(false); toast(e.message, true); }
  }

  async function openDir() {
    const dir = $('#ipDir').value.trim() || S.outDir;
    if (!dir) return;
    try { await api('POST', base + '/outdir', { dir }); S.outDir = dir; toast('文件夹已打开'); }
    catch (e) { toast(e.message, true); }
  }

  async function envCheck() {
    try {
      const d = await api('GET', '/api/env-check');
      const rows = d.items.map((x) => (x.ok ? '✅ ' : '❌ ') + x.name + '：' + (x.detail || (x.ok ? '可用' : '没找到')));
      openModalSimple('本机环境自检', rows.join('\n') + (d.items.some((x) => !x.ok) ? '\n\n缺的可以点下面的「去下载」按提示装。' : '\n\n都齐了。'));
    } catch (e) { toast(e.message, true); }
  }

  function openModalSimple(title, text) {
    const mask = document.createElement('div');
    mask.className = 'modal-mask show';
    mask.innerHTML = '<div class="modal"><h3>' + esc(title) + '</h3><pre style="white-space:pre-wrap;font-size:13px;line-height:1.8">' + esc(text) + '</pre>' +
      '<div class="modal-foot"><button class="btn primary" data-close>知道了</button></div></div>';
    document.body.appendChild(mask);
    mask.querySelector('[data-close]').onclick = () => mask.remove();
    mask.onclick = (ev) => { if (ev.target === mask) mask.remove(); };
  }

  /* ---------------- 绑定 ---------------- */
  $('#ipSend').onclick = send;
  $('#ipInput').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); send(); }
  });
  $('#ipGen').onclick = generate;
  $('#ipApply').onclick = applyUpdate;
  if ($('#ipRedoAll')) $('#ipRedoAll').onclick = redoAll;
  $('#ipExport').onclick = exportWord;
  $('#ipWriteBack').onclick = writeBack;
  $('#ipOpenDir').onclick = openDir;
  $('#ipEnv').onclick = envCheck;
  $('#ipClose').onclick = () => { saveText(true).finally(() => window.close()); };
  $('#ipText').addEventListener('blur', () => saveText(true));
  let tm = null;
  $('#ipText').addEventListener('input', () => {
    clearTimeout(tm);
    tm = setTimeout(() => saveText(true), 1500);
  });
  window.addEventListener('beforeunload', () => { saveText(true); });

  if (!PID || !DOC || !CID) {
    $('#ipMsgs').innerHTML = '<div class="indep-empty">地址里缺少项目或章节信息，请回工作台重新点「独立编制」。</div>';
  } else {
    load();
  }
})();
