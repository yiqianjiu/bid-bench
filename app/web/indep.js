/* 独立编制窗口（v1.1.3）
 * 左边和 AI 聊怎么改，右边看「Word 真实版面」——稿子先排成 Word 再转 PDF，逐页显示成图片，
 * 建议配图按锚点挂到对应段落右侧，两列并排同滚。也可以切「纯文本」直接看字。
 * 会话与稿件存在服务端（数据\独立编制\<项目id>\<章节id>.json），关掉再开原样恢复。 */
(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const q = new URLSearchParams(location.search);
  const PID = q.get('p');
  const DOC = q.get('d');
  const CID = q.get('c');

  const S = {
    session: null, busy: '', outDir: '',
    view: 'pdf',        // pdf | text
    pv: null,           // 版面预览数据 {pages:[{page,url,lines}], sig}
    pvBusy: false,
    zoom: 'fit',        // 版面预览缩放：'fit' 或 0.5/0.75/1/1.25/1.5/2（v1.2.4）
    hd: false,          // 高清出图（每页图约大 80%，放大看不糊）（v1.2.4）
    railOff: false,     // 配图栏是否收起（v1.2.4）
    anchored: 0         // 已落位的配图张数（v1.2.4）
  };

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
    ['#ipGen', '#ipApply', '#ipSend', '#ipExport', '#ipRedoAll', '#ipWriteBack', '#ipRefreshPv', '#ipImport'].forEach((k) => { const el = $(k); if (el) el.disabled = !!on; });
    $('#ipMsg').textContent = S.busy || '';
  }

  /* ---------------- 对话 ---------------- */
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

  /* ---------------- 版面预览：左边是纸，右边是建议配图（v1.2.4 重排） ----------------
   * 纸面宽度跟着窗口走：适应宽度时按可用宽度铺满（最多 900 逻辑像素），
   * 也可以手动选 50%～200%。放大后横向滚动，Ctrl+滚轮也能缩放。
   * 右侧配图栏只在真有配图时出现，随时能收起；比例和高清开关记在浏览器里。 */
  const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2];
  const PV_MEM = 'twb.pv.';                 // 记忆键前缀：缩放 / 高清 / 配图栏开关
  const PV_MAXW = 900;                      // 适应宽度时的最大纸面宽（再宽就超出图片清晰度了）
  const PV_SCALE = { 1.6: 1, 2.0: 1.25 };   // 后端出图倍率 ↔ 用户选的「高清」档

  const mem = {
    get(k, d) { try { const v = localStorage.getItem(PV_MEM + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(PV_MEM + k, JSON.stringify(v)); } catch (e) {} }
  };

  function zoomVal() { return S.zoom == null ? 'fit' : String(S.zoom); }
  function zoomIdx() { return ZOOMS.indexOf(Number(S.zoom)); }
  function fitWidth() {
    const box = $('#ipPages');
    if (!box) return 620;
    // 滚动区是 flex:1，配图栏出现时它自己会让位，这里只扣内边距。
    // 只有「真的有图挂在右边」的那一页会自己缩窄（见 .pv-row.pv-has-side .pv-page），
    // 不能为了少数几页把 29 页全压窄——那正是用户抱怨的「页面太小」。
    // 扣掉 .pv-pages 左右内边距 12+12 与 .pv-canvas 左右 2+2，刚好不出横向滚动条
    return Math.max(140, Math.min(PV_MAXW, box.clientWidth - 28));
  }
  // 把纸面宽度算出来写进 CSS 变量，所有页面（含配图栏宽度）跟着变
  function applyZoom() {
    const grid = $('#ipPv');
    if (!grid) return;
    const box = $('#ipPages');
    const basis = fitWidth();
    const w = S.zoom == null || S.zoom === 'fit' ? basis : Math.round(basis * Number(S.zoom) * 10) / 10;
    grid.style.setProperty('--pv-w', Math.round(w) + 'px');
    // 右边挂了图的那一页要自己让出侧列宽度，否则整行会横向溢出
    const narrow = !!box && box.clientWidth < 700;
    grid.classList.toggle('pv-narrow', narrow);
    const wSide = narrow ? w : Math.max(300, Math.min(w, (box ? box.clientWidth : 900) - 28 - 332));
    grid.style.setProperty('--pv-w-side', Math.round(wSide) + 'px');
    const sel = $('#ipZoomSel');
    if (sel && sel.value !== zoomVal()) sel.value = zoomVal();
    const i = zoomIdx();
    const out = $('#ipZoomOut'), inn = $('#ipZoomIn');
    if (out) out.disabled = i >= 0 && i <= 0;
    if (inn) inn.disabled = i === ZOOMS.length - 1;
  }
  function setZoom(v) {
    S.zoom = v === 'fit' ? 'fit' : Number(v);
    mem.set('zoom', S.zoom);
    applyZoom();
  }
  function stepZoom(dir) {
    const i = zoomIdx();
    if (i < 0) return setZoom(dir > 0 ? 1 : 0.75);
    const n = Math.max(0, Math.min(ZOOMS.length - 1, i + dir));
    setZoom(ZOOMS[n]);
  }

  function chartCardHtml(c) {
    let body;
    if (c.chartType === 'table' && c.table) {
      body = '<table class="mini-tbl"><thead><tr>' + c.table.columns.map((x) => '<th>' + esc(x) + '</th>').join('') + '</tr></thead><tbody>' +
        c.table.rows.map((r) => '<tr>' + c.table.columns.map((_, i) => '<td>' + esc(r[i] == null ? '' : r[i]) + '</td>').join('') + '</tr>').join('') +
        '</tbody></table>';
    } else if (c.url) {
      body = '<img src="' + esc(c.url) + '?t=' + encodeURIComponent(c.at || '') + '" alt="">';
    } else {
      body = '<div class="muted">图没画出来</div>';
    }
    const isTbl = c.chartType === 'table';
    return '<div class="chart-card" data-chart="' + esc(c.id) + '">' +
      '<div class="chart-h"><b>' + esc(c.title || (isTbl ? '建议表格' : '示意图')) + '</b><span class="tag">' + (isTbl ? '表格' : '示意图') + '</span></div>' +
      (c.reason ? '<div class="chart-r">' + esc(c.reason) + '</div>' : '') +
      '<div class="chart-img">' + body + '</div>' +
      (c.caption ? '<div class="chart-c">' + esc(c.caption) + '</div>' : '') +
      '<div class="row" style="gap:6px;flex-wrap:wrap">' +
        '<button class="btn tiny" data-redo="' + esc(c.id) + '">' + (isTbl ? '改这张表' : '重新画一张') + '</button>' +
        '<button class="btn tiny" data-copy="' + esc(c.id) + '">复制</button>' +
        '<button class="btn tiny" data-dl="' + esc(c.id) + '">下载' + (isTbl ? ' Word' : '') + '</button>' +
        '<button class="btn tiny" data-drop="' + esc(c.id) + '">不要这张</button>' +
      '</div></div>';
  }

  // 每页右侧那一列只在真的有图挂上去时才出现；没有一张落位时整列都不存在（不再留白）
  function toggleSides() {
    document.querySelectorAll('.pv-row').forEach((row) => {
      const side = row.querySelector('.pv-side');
      if (!side) return;
      const filled = side.children.length > 0;
      side.style.display = filled ? '' : 'none';
      row.classList.toggle('pv-has-side', filled);
    });
  }

  // 把每张图/表格挂到预览页里对应段落的位置（按 afterText 找那一行，换算成该页的百分比高度）
  function placeCharts() {
    const cs = (S.session && S.session.charts) || [];
    const pages = (S.pv && S.pv.pages) || [];
    const rail = $('#ipRail');
    document.querySelectorAll('.pv-side').forEach((el) => { el.innerHTML = ''; });
    if (rail) { rail.innerHTML = ''; rail.hidden = true; }
    if (!cs.length) { toggleSides(); renderPvBar(); return; }

    const detached = [];
    for (const c of cs) {
      const key = String(c.afterText || '').replace(/\s+/g, '');
      let hit = null;
      if (key.length >= 4) {
        const head = key.slice(0, 14);
        for (const p of pages) {
          for (const ln of p.lines || []) {
            if (String(ln.text || '').replace(/\s+/g, '').includes(head)) { hit = { page: p.page, y: ln.y, h: p.h }; break; }
          }
          if (hit) break;
        }
      }
      const holder = hit ? document.querySelector('.pv-row[data-page="' + hit.page + '"] .pv-side') : null;
      if (!holder) { detached.push(c); continue; }
      const wrap = document.createElement('div');
      wrap.className = 'pv-anchor';
      wrap.style.top = Math.max(0, Math.min(94, (hit.y / Math.max(1, hit.h)) * 100)) + '%';
      wrap.innerHTML = chartCardHtml(c);
      holder.appendChild(wrap);
    }
    toggleSides();

    // 没落位的图放到右侧配图栏；有落位的图但配图栏被收起时也提示还能展开
    const anchored = cs.length - detached.length;
    if (rail && detached.length) {
      rail.hidden = S.railOff;
      rail.innerHTML = '<div class="pv-rail-h">位置未定的配图（' + detached.length + ' 张，可自己摆）</div>' + detached.map(chartCardHtml).join('');
    }
    S.anchored = anchored;
    renderPvBar();
    bindChartActions();
  }

  // 配图卡片上的四个按钮：改这张 / 复制 / 下载 / 不要这张（v1.2.4 重排时搬回来）
  function bindChartActions() {
    document.querySelectorAll('[data-redo]').forEach((el) => { el.onclick = () => redoChart(el.dataset.redo); });
    document.querySelectorAll('[data-drop]').forEach((el) => {
      el.onclick = async () => {
        S.session.charts = (S.session.charts || []).filter((x) => x.id !== el.dataset.drop);
        await saveText(true);
        renderPreview(false);
      };
    });
    document.querySelectorAll('[data-dl]').forEach((el) => {
      el.onclick = () => {
        const url = base + '/chart/' + encodeURIComponent(el.dataset.dl) + '/download';
        const a = document.createElement('a');
        a.href = url; a.download = '';
        document.body.appendChild(a); a.click(); a.remove();
        toast('开始下载');
      };
    });
    document.querySelectorAll('[data-copy]').forEach((el) => {
      el.onclick = async () => {
        const c = (S.session.charts || []).find((x) => x.id === el.dataset.copy);
        if (!c) return;
        try {
          if (c.chartType === 'table' && c.table) {
            const tsv = [c.table.columns.join('\t')].concat(c.table.rows.map((r) => c.table.columns.map((_, i) => String(r[i] == null ? '' : r[i])).join('\t'))).join('\n');
            await navigator.clipboard.writeText(tsv);
            toast('表格已复制（可以直接粘到 Excel / Word 里）');
          } else if (c.url) {
            const r = await fetch(c.url);
            const blob = await r.blob();
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
            toast('图片已复制（可以直接粘到 Word 里）');
          }
        } catch (e) {
          toast('这个浏览器不让自动复制，请用「下载」', true);
        }
      };
    });
  }

  // 顶部工具条：页数 / 配图情况 / 配图栏开关
  function renderPvBar() {
    const pv = S.pv;
    const cs = (S.session && S.session.charts) || [];
    const anchored = S.anchored == null ? cs.length : S.anchored;
    const detached = Math.max(0, cs.length - anchored);
    const info = $('#ipPvInfo');
    if (info) {
      const bits = [];
      if (pv && pv.total) bits.push('共 ' + pv.total + ' 页');
      if (cs.length) bits.push('配图 ' + anchored + ' 张已落位' + (detached ? ' · ' + detached + ' 张位置未定' : ''));
      info.textContent = bits.length ? bits.join(' · ') : '版面预览';
    }
    const btn = $('#ipRailBtn');
    if (btn) {
      btn.hidden = !detached;
      btn.textContent = S.railOff ? '显示配图栏' : '收起配图栏';
      btn.classList.toggle('primary', !S.railOff && detached > 0);
    }
    applyZoom();
  }

  function renderPages() {
    const box = $('#ipCanvas');
    const pv = S.pv;
    const empty = $('#ipPvEmpty');
    if (!pv || !pv.pages || !pv.pages.length) {
      box.innerHTML = '';
      empty.hidden = false;
      empty.innerHTML = S.pvBusy ? '正在把稿子排成 Word 版面，第一次大约要 10~30 秒…' : '还没有版面。点右上角「刷新版面」按当前稿子排一版。';
      renderPvBar();
      return;
    }
    empty.hidden = true;
    box.innerHTML = pv.pages.map((p) => {
      return '<div class="pv-row" data-page="' + p.page + '">' +
        '<div class="pv-page" style="aspect-ratio:' + p.w + '/' + p.h + '">' +
          '<img src="' + esc(p.url) + '?t=' + encodeURIComponent(pv.sig || '') + '" alt="第 ' + p.page + ' 页" loading="lazy">' +
          '<div class="pv-no">第 ' + p.page + ' 页</div>' +
        '</div>' +
        '<div class="pv-side"></div>' +
      '</div>';
    }).join('');
    placeCharts();
  }


  async function renderPreview(force) {
    if (!S.session) return;
    if (!String(S.session.text || '').trim()) {
      S.pv = null;
      renderPages();
      return;
    }
    if (S.pvBusy) return;
    S.pvBusy = true;
    $('#ipMeta').textContent = '正在排版面…';
    renderPages();
    try {
      const d = await api('POST', base + '/preview', {
        force: !!force,
        hd: !!S.hd,
        text: $('#ipText').value || S.session.text || '',
        charts: S.session.charts || []
      });
      S.pv = { pages: d.pages, sig: d.sig, at: d.at, total: d.total };
      renderPreviewMeta();
    } catch (e) {
      S.pv = null;
      $('#ipPvEmpty').hidden = false;
      $('#ipPvEmpty').innerHTML = '版面预览没做出来：' + esc(e.message) + '<br>可以切「纯文本」看内容，或点「刷新版面」重试。';
    } finally {
      S.pvBusy = false;
      renderPages();
      renderMeta();
    }
  }

  function renderPreviewMeta() { renderMeta(); }

  /* ---------------- 纯文本 ---------------- */
  function renderText() {
    $('#ipText').value = (S.session && S.session.text) || '';
  }

  function renderHints() {
    const hs = (S.session && S.session.hints) || [];
    if (!hs.length) { $('#ipHints').innerHTML = '<div class="muted" style="font-size:12px">暂时没有。</div>'; return; }
    $('#ipHints').innerHTML = hs.map((h) => '<div class="hint-card">⚠ ' + esc(h.text) + '</div>').join('');
  }

  function renderMeta() {
    const s = S.session || {};
    const n = (s.text || '').length;
    if (S.pvBusy) return;
    if (!n) { $('#ipMeta').textContent = '还没有内容'; return; }
    const pages = S.pv && S.pv.total ? (' · 共 ' + S.pv.total + ' 页') : '';
    $('#ipMeta').textContent = '已写 ' + n + ' 字 · ' + ((s.charts || []).length) + ' 张图' + pages +
      ' · 更新于 ' + String((S.pv && S.pv.at) || s.updatedAt || '').replace('T', ' ').slice(0, 16);
  }

  function setView(v) {
    S.view = v;
    document.querySelectorAll('#ipViewSeg button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
    $('#ipPv').style.display = v === 'pdf' ? '' : 'none';
    if ($('#ipPvBar')) $('#ipPvBar').style.display = v === 'pdf' ? '' : 'none';
    $('#ipText').style.display = v === 'text' ? '' : 'none';
    if (v === 'pdf') applyZoom();
    if (v === 'pdf' && !S.pv) renderPreview(false);
    if (v === 'text') renderText();
  }

  function renderAll() {
    const s = S.session || {};
    $('#ipTitle').textContent = (s.chapterTitle || '独立编制');
    $('#ipRole').textContent = s.role === 'biz' ? '重要商务' : '重要技术';
    $('#ipProj').textContent = s.projectName || '';
    if (!$('#ipDir').value) $('#ipDir').value = S.outDir || '';
    renderMsgs();
    renderHints();
    renderText();
    renderMeta();
    if (S.view === 'pdf') renderPreview(false);
  }

  /* ---------------- 数据 ---------------- */
  async function load() {
    try {
      const d = await api('GET', base);
      S.session = d.session;
      S.outDir = d.outDir || '';
      if (!S.session) { toast('这个章节打不开', true); return; }
      if (!d.apiReady) toast('还没配置模型服务，AI 功能用不了（可以在工作台「设置」里填）', true);
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
      const d = await api('POST', base + '/chat', { message: msg, text: S.session.text || '' });
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
      const d = await api('POST', base + '/generate', { text: S.session.text || '' });
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
      const d = await api('POST', base + '/update', { text: S.session.text || '' });
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

  async function importWord(file) {
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file, file.name);
    setBusy(true, '正在读你上传的 Word…');
    try {
      const r = await fetch(base + '/import', { method: 'POST', body: fd });
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error((d && (d.message || d.error)) || ('上传失败（' + r.status + '）'));
      S.session = d.session;
      S.pv = null;
      renderAll();
      toast('已用《' + d.fileName + '》覆盖当前稿件（' + d.chars + ' 字）');
    } catch (e) { toast(e.message, true); }
    finally { setBusy(false); $('#ipImpInput').value = ''; }
  }

  async function exportWord() {
    if (S.busy) return;
    setBusy(true, '正在生成 Word…');
    try {
      const dir = $('#ipDir').value.trim();
      const d = await api('POST', base + '/export', { dir, text: $('#ipText').value || S.session.text || '' });
      S.outDir = d.dir;
      $('#ipDir').value = d.dir;
      setBusy(false);
      toast('已导出：' + d.file);
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
      const d = await api('POST', base + '/writeback', { text: $('#ipText').value || S.session.text || '' });
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

  /* ---------------- 版面预览：缩放 / 高清 / 配图栏（v1.2.4） ---------------- */
  S.zoom = mem.get('zoom', 'fit');
  if (S.zoom !== 'fit' && ZOOMS.indexOf(Number(S.zoom)) < 0) S.zoom = 'fit';
  S.hd = !!mem.get('hd', false);
  S.railOff = !!mem.get('railOff', false);
  if ($('#ipZoomSel')) $('#ipZoomSel').value = zoomVal();
  if ($('#ipHd')) $('#ipHd').checked = S.hd;

  if ($('#ipZoomOut')) $('#ipZoomOut').onclick = () => stepZoom(-1);
  if ($('#ipZoomIn')) $('#ipZoomIn').onclick = () => stepZoom(1);
  if ($('#ipZoomSel')) {
    $('#ipZoomSel').onchange = (ev) => {
      const v = ev.target.value;
      setZoom(v === 'fit' ? 'fit' : Number(v));
    };
  }
  if ($('#ipHd')) {
    $('#ipHd').onchange = (ev) => {
      S.hd = !!ev.target.checked;
      mem.set('hd', S.hd);
      // 清晰度变了要重新出一遍图，否则看到的是旧分辨率的图
      S.pv = null;
      renderPreview(true);
    };
  }
  if ($('#ipRailBtn')) {
    $('#ipRailBtn').onclick = () => {
      S.railOff = !S.railOff;
      mem.set('railOff', S.railOff);
      const rail = $('#ipRail');
      if (rail) rail.hidden = S.railOff || !rail.children.length;
      // 配图栏一收一放，可用宽度变了，纸面要重算
      renderPvBar();
    };
  }
  // Ctrl+滚轮缩放：只在页面上滚，不缩放整个网页
  if ($('#ipPages')) {
    $('#ipPages').addEventListener('wheel', (ev) => {
      if (!ev.ctrlKey) return;
      ev.preventDefault();
      stepZoom(ev.deltaY > 0 ? -1 : 1);
    }, { passive: false });
  }
  let pvResizeTm = null;
  window.addEventListener('resize', () => {
    clearTimeout(pvResizeTm);
    pvResizeTm = setTimeout(() => { if (S.view === 'pdf') applyZoom(); }, 120);
  });

  /* ---------------- 绑定 ---------------- */
  $('#ipSend').onclick = send;
  $('#ipInput').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); send(); }
  });
  $('#ipGen').onclick = generate;
  $('#ipApply').onclick = applyUpdate;
  $('#ipRedoAll').onclick = redoAll;
  $('#ipRefreshPv').onclick = () => renderPreview(true);
  $('#ipImport').onclick = () => $('#ipImpInput').click();
  $('#ipImpInput').onchange = (ev) => importWord(ev.target.files && ev.target.files[0]);
  $('#ipExport').onclick = exportWord;
  $('#ipWriteBack').onclick = writeBack;
  $('#ipOpenDir').onclick = openDir;
  $('#ipEnv').onclick = envCheck;
  $('#ipClose').onclick = () => { saveText(true).finally(() => window.close()); };
  document.querySelectorAll('#ipViewSeg button').forEach((b) => { b.onclick = () => setView(b.dataset.view); });
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
