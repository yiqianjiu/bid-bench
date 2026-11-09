// v1.1.2 图表引擎：AI 出「图纸」（结构化 JSON），工作台本地画成 SVG → PNG → 嵌进 Word
// 模型本身不产图，只产结构；渲染在本机用浏览器完成，不联网、不上传任何内容。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { DATA_DIR } from './config.mjs';
import { uid } from './util.mjs';

export const CHART_DIR = path.join(DATA_DIR, '图表');
export function ensureChartDirs() { fs.mkdirSync(CHART_DIR, { recursive: true }); }

const FONT = "'Microsoft YaHei','SimHei',sans-serif";
const C = {
  line: '#2b6cb0', line2: '#2f855a', line3: '#b7791f', line4: '#c53030',
  box: '#ffffff', boxStroke: '#2b6cb0', fill1: '#ebf4ff', fill2: '#f0fff4', fill3: '#fffaf0',
  text: '#1a202c', muted: '#718096', grid: '#e2e8f0', bar: '#4299e1'
};

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function textW(s, size) {
  // 中文按 1 个字宽、英文数字按 0.55
  let w = 0;
  for (const ch of String(s || '')) w += /[\u4e00-\u9fa5]/.test(ch) ? size : size * 0.56;
  return w;
}
// 文字换行（按像素宽度）
function wrap(s, size, maxW) {
  const out = [];
  let cur = '';
  for (const ch of String(s || '')) {
    if (textW(cur + ch, size) > maxW && cur) { out.push(cur); cur = ch; }
    else cur += ch;
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}

function svgWrap(w, h, inner) {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">' +
    '<defs>' +
    '<marker id="ar" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto"><path d="M0,0 L10,4 L0,8 z" fill="' + C.line + '"/></marker>' +
    '<marker id="ar2" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto"><path d="M0,0 L10,4 L0,8 z" fill="' + C.muted + '"/></marker>' +
    '</defs>' +
    '<rect width="' + w + '" height="' + h + '" fill="#ffffff"/>' + inner + '</svg>';
}

function titleLine(title, w) {
  if (!title) return { svg: '', y: 20 };
  return { svg: '<text x="' + (w / 2) + '" y="28" font-size="20" font-weight="bold" text-anchor="middle" fill="' + C.text + '" font-family="' + FONT + '">' + esc(title) + '</text>', y: 52 };
}

/* ---------------- 1. 流程图（蛇形布局） ---------------- */
function drawFlow(spec) {
  const W = 1200;
  const nodes = (spec.nodes || []).filter((n) => n && (n.label || n.text));
  if (!nodes.length) return null;
  const perRow = Math.min(4, Math.max(2, Math.ceil(Math.sqrt(nodes.length))));
  const rows = Math.ceil(nodes.length / perRow);
  const boxH = 64, gapX = 46, gapY = 62, padX = 60;
  const boxW = Math.min(220, Math.floor((W - padX * 2 - gapX * (perRow - 1)) / perRow));
  const t = titleLine(spec.title, W);
  const top = t.y + 10;
  const H = top + rows * boxH + (rows - 1) * gapY + 40;
  let s = t.svg;
  const pos = [];
  nodes.forEach((n, i) => {
    const r = Math.floor(i / perRow);
    const inRow = i % perRow;
    const col = r % 2 === 0 ? inRow : (perRow - 1 - inRow);
    const x = padX + col * (boxW + gapX);
    const y = top + r * (boxH + gapY);
    pos.push({ x, y, w: boxW, h: boxH, n });
  });
  // 连线
  for (let i = 0; i < pos.length - 1; i++) {
    const a = pos[i], b = pos[i + 1];
    const sameRow = Math.abs(a.y - b.y) < 1;
    if (sameRow) {
      const dir = b.x > a.x ? 1 : -1;
      const x1 = a.x + (dir > 0 ? a.w : 0), x2 = b.x + (dir > 0 ? 0 : b.w);
      const y = a.y + a.h / 2;
      s += '<line x1="' + x1 + '" y1="' + y + '" x2="' + (x2 - dir * 6) + '" y2="' + y + '" stroke="' + C.line + '" stroke-width="2" marker-end="url(#ar)"/>';
    } else {
      const x1 = a.x + a.w / 2, y1 = a.y + a.h;
      const x2 = b.x + b.w / 2, y2 = b.y;
      const midY = (y1 + y2) / 2;
      s += '<path d="M' + x1 + ',' + y1 + ' L' + x1 + ',' + midY + ' L' + x2 + ',' + midY + ' L' + x2 + ',' + (y2 - 6) + '" fill="none" stroke="' + C.line + '" stroke-width="2" marker-end="url(#ar)"/>';
    }
  }
  pos.forEach((p) => {
    const n = p.n;
    const kind = String(n.kind || '').toLowerCase();
    const fill = kind === 'start' || kind === 'end' ? C.fill2 : kind === 'decision' ? C.fill3 : C.fill1;
    const stroke = kind === 'start' || kind === 'end' ? C.line2 : C.line;
    const lines = wrap(n.label || n.text, 15, p.w - 20).slice(0, 3);
    const cy = p.y + p.h / 2 - (lines.length - 1) * 10 + 5;
    s += '<rect x="' + p.x + '" y="' + p.y + '" width="' + p.w + '" height="' + p.h + '" rx="' + (kind === 'start' || kind === 'end' ? 32 : 8) + '" fill="' + fill + '" stroke="' + stroke + '" stroke-width="1.6"/>';
    lines.forEach((ln, i) => {
      s += '<text x="' + (p.x + p.w / 2) + '" y="' + (cy + i * 20) + '" font-size="15" text-anchor="middle" fill="' + C.text + '" font-family="' + FONT + '">' + esc(ln) + '</text>';
    });
    if (n.note) {
      s += '<text x="' + (p.x + p.w / 2) + '" y="' + (p.y + p.h + 18) + '" font-size="12" text-anchor="middle" fill="' + C.muted + '" font-family="' + FONT + '">' + esc(String(n.note).slice(0, 30)) + '</text>';
    }
  });
  return svgWrap(W, H, s);
}

/* ---------------- 2. 分层架构图 ---------------- */
function drawArch(spec) {
  const W = 1200;
  const layers = (spec.layers || []).filter((l) => l && (l.name || (l.items || []).length));
  if (!layers.length) return null;
  const t = titleLine(spec.title, W);
  const padX = 60, labelW = 150, gapY = 16;
  const itemH = 54;
  let y = t.y + 10;
  let s = t.svg;
  layers.forEach((l, li) => {
    const items = (l.items || []).map((x) => (typeof x === 'string' ? x : x.name || x.label || '')).filter(Boolean);
    const areaW = W - padX * 2 - labelW - 16;
    const n = Math.max(1, items.length);
    const gap = 12;
    const iw = Math.max(90, Math.floor((areaW - gap * (n - 1)) / n));
    const lh = itemH + 22;
    const fills = [C.fill1, C.fill2, C.fill3, '#faf5ff', '#f7fafc'];
    s += '<rect x="' + padX + '" y="' + y + '" width="' + (W - padX * 2) + '" height="' + lh + '" rx="8" fill="' + fills[li % fills.length] + '" stroke="#cbd5e0" stroke-width="1"/>';
    s += '<text x="' + (padX + labelW / 2) + '" y="' + (y + lh / 2 + 6) + '" font-size="16" font-weight="bold" text-anchor="middle" fill="' + C.text + '" font-family="' + FONT + '">' + esc(l.name || ('层 ' + (li + 1))) + '</text>';
    s += '<line x1="' + (padX + labelW) + '" y1="' + (y + 8) + '" x2="' + (padX + labelW) + '" y2="' + (y + lh - 8) + '" stroke="#cbd5e0" stroke-width="1" stroke-dasharray="4 4"/>';
    items.forEach((it, i) => {
      const x = padX + labelW + 16 + i * (iw + gap);
      const lines = wrap(it, 14, iw - 14).slice(0, 2);
      s += '<rect x="' + x + '" y="' + (y + 11) + '" width="' + iw + '" height="' + itemH + '" rx="6" fill="#ffffff" stroke="' + C.line + '" stroke-width="1.2"/>';
      lines.forEach((ln, k) => {
        s += '<text x="' + (x + iw / 2) + '" y="' + (y + 11 + itemH / 2 + 5 - (lines.length - 1) * 9 + k * 18) + '" font-size="14" text-anchor="middle" fill="' + C.text + '" font-family="' + FONT + '">' + esc(ln) + '</text>';
      });
    });
    y += lh + gapY;
  });
  return svgWrap(W, y + 20, s);
}

/* ---------------- 3. 甘特图（进度） ---------------- */
function drawGantt(spec) {
  const W = 1200;
  const tasks = (spec.tasks || []).filter((x) => x && (x.name || x.title));
  if (!tasks.length) return null;
  const unit = spec.unit || '天';
  const t = titleLine(spec.title, W);
  const padX = 40, nameW = 300, rowH = 40, top = t.y + 30;
  const maxEnd = Math.max.apply(null, tasks.map((x) => (Number(x.start) || 0) + (Number(x.span) || 1)));
  const barAreaX = padX + nameW + 20;
  const barAreaW = W - barAreaX - padX - 60;
  const per = barAreaW / Math.max(1, maxEnd);
  const H = top + tasks.length * rowH + 50;
  let s = t.svg;
  // 刻度
  const ticks = Math.min(12, Math.max(2, Math.round(maxEnd)));
  for (let i = 0; i <= ticks; i++) {
    const v = Math.round((maxEnd / ticks) * i);
    const x = barAreaX + v * per;
    s += '<line x1="' + x + '" y1="' + (top - 12) + '" x2="' + x + '" y2="' + (top + tasks.length * rowH + 4) + '" stroke="' + C.grid + '" stroke-width="1"/>';
    s += '<text x="' + x + '" y="' + (top - 18) + '" font-size="12" text-anchor="middle" fill="' + C.muted + '" font-family="' + FONT + '">' + v + unit + '</text>';
  }
  tasks.forEach((x, i) => {
    const y = top + i * rowH;
    const lines = wrap(x.name || x.title, 14, nameW - 12).slice(0, 2);
    lines.forEach((ln, k) => {
      s += '<text x="' + (padX + nameW) + '" y="' + (y + rowH / 2 + 5 - (lines.length - 1) * 9 + k * 17) + '" font-size="14" text-anchor="end" fill="' + C.text + '" font-family="' + FONT + '">' + esc(ln) + '</text>';
    });
    const st = Number(x.start) || 0, sp = Math.max(0.4, Number(x.span) || 1);
    const bx = barAreaX + st * per, bw = Math.max(8, sp * per);
    const color = [C.bar, C.line2, C.line3, '#805ad5', '#dd6b20'][i % 5];
    s += '<rect x="' + bx + '" y="' + (y + 8) + '" width="' + bw + '" height="' + (rowH - 16) + '" rx="4" fill="' + color + '" opacity="0.85"/>';
    const lab = x.label || (st + '-' + (st + sp) + unit);
    if (bw > 60) {
      s += '<text x="' + (bx + bw / 2) + '" y="' + (y + rowH / 2 + 5) + '" font-size="12" text-anchor="middle" fill="#ffffff" font-family="' + FONT + '">' + esc(String(lab).slice(0, 24)) + '</text>';
    } else {
      s += '<text x="' + (bx + bw + 8) + '" y="' + (y + rowH / 2 + 5) + '" font-size="12" fill="' + C.muted + '" font-family="' + FONT + '">' + esc(String(lab).slice(0, 24)) + '</text>';
    }
  });
  return svgWrap(W, H, s);
}

/* ---------------- 4. 时间轴 ---------------- */
function drawTimeline(spec) {
  const W = 1200;
  const items = (spec.items || []).filter((x) => x && (x.label || x.time));
  if (!items.length) return null;
  const t = titleLine(spec.title, W);
  const n = items.length;
  const padX = 70;
  const step = (W - padX * 2) / Math.max(1, n - 1 || 1);
  const y = t.y + 90;
  const H = y + 120;
  let s = t.svg;
  s += '<line x1="' + padX + '" y1="' + y + '" x2="' + (W - padX) + '" y2="' + y + '" stroke="' + C.line + '" stroke-width="3"/>';
  items.forEach((x, i) => {
    const cx = n === 1 ? W / 2 : padX + i * step;
    s += '<circle cx="' + cx + '" cy="' + y + '" r="9" fill="#ffffff" stroke="' + C.line + '" stroke-width="3"/>';
    const up = i % 2 === 0;
    const ty = up ? y - 26 : y + 40;
    const lines = wrap(x.label || '', 14, Math.min(180, step + 40)).slice(0, 3);
    if (x.time) s += '<text x="' + cx + '" y="' + (up ? y - 44 : y + 60) + '" font-size="13" font-weight="bold" text-anchor="middle" fill="' + C.line + '" font-family="' + FONT + '">' + esc(x.time) + '</text>';
    lines.forEach((ln, k) => {
      s += '<text x="' + cx + '" y="' + (ty + k * 18) + '" font-size="14" text-anchor="middle" fill="' + C.text + '" font-family="' + FONT + '">' + esc(ln) + '</text>';
    });
  });
  return svgWrap(W, H, s);
}

/* ---------------- 5. 折线 / 柱状 ---------------- */
function drawSeries(spec) {
  const W = 1200;
  const cats = (spec.categories || spec.x || []).map(String);
  const series = (spec.series || []).filter((x) => x && Array.isArray(x.data));
  if (!cats.length || !series.length) return null;
  const type = String(spec.chartType || 'line');
  const t = titleLine(spec.title, W);
  const padL = 90, padR = 60, padT = t.y + 30, padB = 80;
  const H = padT + 380 + padB;
  const plotW = W - padL - padR, plotH = 380;
  const all = series.reduce((a, s) => a.concat(s.data.map(Number).filter((x) => !Number.isNaN(x))), []);
  let max = Math.max.apply(null, all.length ? all : [1]);
  let min = Math.min.apply(null, all.length ? all : [0]);
  if (min > 0) min = 0;
  const range = (max - min) || 1;
  max = max + range * 0.1;
  const yOf = (v) => padT + plotH - ((v - min) / (max - min)) * plotH;
  const stepX = cats.length > 1 ? plotW / (cats.length - 1) : plotW / 2;
  const xOf = (i) => (cats.length > 1 ? padL + i * stepX : padL + plotW / 2);
  let s = t.svg;
  // 网格 + Y 轴
  for (let i = 0; i <= 5; i++) {
    const v = min + ((max - min) / 5) * i;
    const y = yOf(v);
    s += '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="' + C.grid + '" stroke-width="1"/>';
    s += '<text x="' + (padL - 10) + '" y="' + (y + 4) + '" font-size="12" text-anchor="end" fill="' + C.muted + '" font-family="' + FONT + '">' + (Math.round(v * 100) / 100) + '</text>';
  }
  s += '<line x1="' + padL + '" y1="' + padT + '" x2="' + padL + '" y2="' + (padT + plotH) + '" stroke="#a0aec0" stroke-width="1.5"/>';
  s += '<line x1="' + padL + '" y1="' + (padT + plotH) + '" x2="' + (W - padR) + '" y2="' + (padT + plotH) + '" stroke="#a0aec0" stroke-width="1.5"/>';
  cats.forEach((c, i) => {
    const lines = wrap(c, 12, 90).slice(0, 2);
    lines.forEach((ln, k) => {
      s += '<text x="' + xOf(i) + '" y="' + (padT + plotH + 22 + k * 16) + '" font-size="12" text-anchor="middle" fill="' + C.muted + '" font-family="' + FONT + '">' + esc(ln) + '</text>';
    });
  });
  const colors = [C.line, C.line2, C.line3, C.line4, '#805ad5'];
  series.forEach((se, si) => {
    const col = colors[si % colors.length];
    const pts = se.data.map((v, i) => ({ x: xOf(i), y: yOf(Number(v) || 0), v: Number(v) || 0 }));
    if (type === 'bar') {
      const bw = Math.max(10, Math.min(46, plotW / cats.length / (series.length + 1)));
      pts.forEach((p, i) => {
        const x = p.x - (series.length * bw) / 2 + si * bw;
        s += '<rect x="' + x + '" y="' + p.y + '" width="' + (bw - 4) + '" height="' + (padT + plotH - p.y) + '" fill="' + col + '" opacity="0.85"/>';
      });
    } else {
      s += '<polyline points="' + pts.map((p) => p.x + ',' + p.y).join(' ') + '" fill="none" stroke="' + col + '" stroke-width="2.5"/>';
      pts.forEach((p) => { s += '<circle cx="' + p.x + '" cy="' + p.y + '" r="4" fill="#ffffff" stroke="' + col + '" stroke-width="2"/>'; });
    }
    // 图例
    const lx = padL + si * 180;
    s += '<rect x="' + lx + '" y="' + (padT - 34) + '" width="14" height="10" fill="' + col + '"/>';
    s += '<text x="' + (lx + 20) + '" y="' + (padT - 25) + '" font-size="13" fill="' + C.text + '" font-family="' + FONT + '">' + esc(se.name || ('系列' + (si + 1))) + '</text>';
  });
  if (spec.yLabel) s += '<text x="' + 22 + '" y="' + (padT + plotH / 2) + '" font-size="13" fill="' + C.muted + '" font-family="' + FONT + '" transform="rotate(-90 22 ' + (padT + plotH / 2) + ')">' + esc(spec.yLabel) + '</text>';
  return svgWrap(W, H, s);
}

/* ---------------- 6. 时序图 ---------------- */
function drawSequence(spec) {
  const W = 1200;
  const actors = (spec.actors || []).map((a) => (typeof a === 'string' ? a : a.name || a.label || '')).filter(Boolean);
  const steps = (spec.steps || []).filter((x) => x && x.label);
  if (!actors.length || !steps.length) return null;
  const t = titleLine(spec.title, W);
  const padX = 50;
  const aw = Math.min(200, Math.floor((W - padX * 2) / actors.length));
  const actorX = {};
  actors.forEach((a, i) => { actorX[a] = padX + aw / 2 + i * aw; });
  const top = t.y + 20;
  const rowH = 54;
  const H = top + 60 + steps.length * rowH + 60;
  let s = t.svg;
  actors.forEach((a, i) => {
    const x = actorX[a];
    s += '<rect x="' + (x - aw / 2 + 12) + '" y="' + top + '" width="' + (aw - 24) + '" height="44" rx="6" fill="' + C.fill1 + '" stroke="' + C.line + '"/>';
    const lines = wrap(a, 14, aw - 40).slice(0, 1);
    s += '<text x="' + x + '" y="' + (top + 28) + '" font-size="14" text-anchor="middle" fill="' + C.text + '" font-family="' + FONT + '">' + esc(lines[0] || '') + '</text>';
    s += '<line x1="' + x + '" y1="' + (top + 44) + '" x2="' + x + '" y2="' + (H - 30) + '" stroke="#a0aec0" stroke-width="1" stroke-dasharray="6 5"/>';
  });
  steps.forEach((st, i) => {
    const y = top + 70 + i * rowH;
    const a = actorX[st.from] != null ? actorX[st.from] : padX + aw / 2;
    const b = actorX[st.to] != null ? actorX[st.to] : W - padX - aw / 2;
    const dir = b > a ? 1 : -1;
    s += '<line x1="' + a + '" y1="' + y + '" x2="' + (b - dir * 6) + '" y2="' + y + '" stroke="' + C.line + '" stroke-width="2" marker-end="url(#ar)"/>';
    const mx = (a + b) / 2;
    const lines = wrap(st.label, 13, Math.max(120, Math.abs(b - a) - 20)).slice(0, 2);
    lines.forEach((ln, k) => {
      s += '<text x="' + mx + '" y="' + (y - 10 - (lines.length - 1 - k) * 16) + '" font-size="13" text-anchor="middle" fill="' + C.text + '" font-family="' + FONT + '">' + esc(ln) + '</text>';
    });
  });
  return svgWrap(W, H, s);
}

/* ---------------- 7. 组织结构图 ---------------- */
function drawOrg(spec) {
  const W = 1200;
  const root = spec.root || spec.title2 || '';
  const kids = (spec.children || []).filter((x) => x && (x.name || x.label));
  if (!root && !kids.length) return null;
  const t = titleLine(spec.title, W);
  const padX = 40;
  const top = t.y + 20;
  let s = t.svg;
  const boxH = 54;
  // 根
  const rw = 260;
  const rx = (W - rw) / 2;
  s += '<rect x="' + rx + '" y="' + top + '" width="' + rw + '" height="' + boxH + '" rx="8" fill="' + C.fill1 + '" stroke="' + C.line + '" stroke-width="1.6"/>';
  s += '<text x="' + (W / 2) + '" y="' + (top + boxH / 2 + 6) + '" font-size="16" font-weight="bold" text-anchor="middle" fill="' + C.text + '" font-family="' + FONT + '">' + esc(root || spec.title || '') + '</text>';
  if (!kids.length) return svgWrap(W, top + boxH + 40, s);
  const n = kids.length;
  const gap = 18;
  const cw = Math.min(230, Math.floor((W - padX * 2 - gap * (n - 1)) / n));
  const cy = top + boxH + 70;
  const totalW = n * cw + (n - 1) * gap;
  const startX = (W - totalW) / 2;
  // 干线
  const busY = top + boxH + 34;
  s += '<line x1="' + (W / 2) + '" y1="' + (top + boxH) + '" x2="' + (W / 2) + '" y2="' + busY + '" stroke="' + C.muted + '" stroke-width="1.6"/>';
  s += '<line x1="' + (startX + cw / 2) + '" y1="' + busY + '" x2="' + (startX + totalW - cw / 2) + '" y2="' + busY + '" stroke="' + C.muted + '" stroke-width="1.6"/>';
  let maxBottom = cy + boxH;
  kids.forEach((k, i) => {
    const x = startX + i * (cw + gap);
    const cx = x + cw / 2;
    s += '<line x1="' + cx + '" y1="' + busY + '" x2="' + cx + '" y2="' + (cy - 6) + '" stroke="' + C.muted + '" stroke-width="1.6" marker-end="url(#ar2)"/>';
    s += '<rect x="' + x + '" y="' + cy + '" width="' + cw + '" height="' + boxH + '" rx="8" fill="' + C.fill2 + '" stroke="' + C.line2 + '" stroke-width="1.4"/>';
    const lines = wrap(k.name || k.label, 14, cw - 18).slice(0, 2);
    lines.forEach((ln, kk) => {
      s += '<text x="' + cx + '" y="' + (cy + boxH / 2 + 5 - (lines.length - 1) * 9 + kk * 18) + '" font-size="14" text-anchor="middle" fill="' + C.text + '" font-family="' + FONT + '">' + esc(ln) + '</text>';
    });
    const sub = (k.children || []).filter(Boolean).map((x) => (typeof x === 'string' ? x : x.name || x.label)).filter(Boolean);
    if (sub.length) {
      let sy = cy + boxH + 14;
      const sl = wrap(sub.join(' · '), 12, cw - 14).slice(0, 4);
      sl.forEach((ln, kk) => {
        s += '<text x="' + cx + '" y="' + (sy + kk * 16) + '" font-size="12" text-anchor="middle" fill="' + C.muted + '" font-family="' + FONT + '">' + esc(ln) + '</text>';
      });
      maxBottom = Math.max(maxBottom, sy + sl.length * 16);
    }
  });
  return svgWrap(W, maxBottom + 30, s);
}

const DRAW = {
  flow: drawFlow, arch: drawArch, gantt: drawGantt, timeline: drawTimeline,
  line: drawSeries, bar: drawSeries, sequence: drawSequence, org: drawOrg
};

export function buildSvg(spec) {
  const type = String((spec && (spec.chartType || spec.type)) || '').toLowerCase();
  const fn = DRAW[type];
  if (!fn) throw new Error('不支持的图表类型：' + type);
  const svg = fn({ ...spec, chartType: type });
  if (!svg) throw new Error('图表内容不完整，画不出来');
  return svg;
}

/* ---------------- 渲染成 PNG（本机浏览器，无网络） ---------------- */
const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
];
export function findBrowser() {
  for (const b of BROWSERS) { try { if (fs.existsSync(b)) return b; } catch {} }
  return '';
}

export function browserStatus() {
  const b = findBrowser();
  return { ok: !!b, path: b, name: b ? (/edge/i.test(b) ? 'Microsoft Edge' : 'Google Chrome') : '' };
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const p = spawn(cmd, args, { windowsHide: true });
    const timer = setTimeout(() => { if (!done) { done = true; try { p.kill(); } catch {} resolve({ code: -1, out: 'timeout' }); } }, timeoutMs || 30000);
    let out = '';
    p.stdout && p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr && p.stderr.on('data', (d) => { out += d.toString(); });
    p.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ code: -2, out: String(e && e.message || e) }); } });
    p.on('close', (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code, out }); } });
  });
}

/**
 * 把 SVG 渲染成 PNG（2 倍分辨率，插进 Word 才清晰）
 * @returns {Promise<{file:string, width:number, height:number}>}
 */
export async function svgToPng(svg, outFile, opt = {}) {
  const browser = findBrowser();
  if (!browser) throw new Error('本机没有找到 Chrome / Edge 浏览器，画不了图。可以在「设置」里看环境自检。');
  ensureChartDirs();
  const m = /width="(\d+)"\s+height="(\d+)"/.exec(svg);
  const w = m ? Number(m[1]) : 1200;
  const h = m ? Number(m[2]) : 600;
  const scale = opt.scale || 2;
  const tmpDir = path.join(os.tmpdir(), 'twb-chart-' + uid('c').slice(2, 9));
  fs.mkdirSync(tmpDir, { recursive: true });
  const htmlFile = path.join(tmpDir, 'c.html');
  const pngFile = path.join(tmpDir, 'c.png');
  const html = '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff;}' +
    'svg{display:block}</style></head><body>' + svg + '</body></html>';
  fs.writeFileSync(htmlFile, html, 'utf8');
  const args = [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--force-device-scale-factor=' + scale,
    '--window-size=' + w + ',' + h,
    '--screenshot=' + pngFile,
    '--default-background-color=FFFFFFFF',
    'file:///' + htmlFile.replace(/\\/g, '/')
  ];
  const r = await run(browser, args, 40000);
  if (!fs.existsSync(pngFile)) throw new Error('图没画出来：' + String(r.out || '').slice(-300));
  fs.copyFileSync(pngFile, outFile);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  return { file: outFile, width: w * scale, height: h * scale };
}

/* ---------------- 从 AI 给的表格 JSON 生成 docx 表格数据 ---------------- */
export function normalizeTable(spec) {
  const cols = (spec.columns || []).map((c) => (typeof c === 'string' ? c : c.name || c.label || '')).filter(Boolean);
  const rows = (spec.rows || []).map((r) => (Array.isArray(r) ? r : cols.map((c) => (r && r[c] != null ? r[c] : ''))));
  return { columns: cols, rows };
}
