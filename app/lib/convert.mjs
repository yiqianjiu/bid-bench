// v1.2.3：Word COM 转换（.doc → .docx、.docx → PDF）
// 关键改动：原来用 execFileSync 同步调用 PowerShell，转换期间整个 Node 事件循环被冻住，
// 前端 2 秒一次的进度轮询全部挂起，页面就永远停在「正在读取文件」。
// 现在改成 spawn 子进程 + Promise，转换期间服务照常响应，并且支持超时、取消、进度回报。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { loadConfig } from './config.mjs';

const POWERSHELL = 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

// 把 Word COM 的英文报错翻成用户看得懂的话（v1.2.1 起一直用这套文案）
export function wordHint(e) {
  const s = String((e && (e.stderr || e.message)) || e || '');
  if (/800401F3|Invalid class string|ProgID|0x80080005/i.test(s)) {
    return '这台电脑没有装 Microsoft Word（或 Word 打不开），读不了 .doc。请用 Word 打开这个文件，另存为 .docx 再上传。';
  }
  if (/找不到您的文件|cannot be found|isn't found|无法打开/i.test(s)) {
    return 'Word 打不开这个 .doc 文件（可能已损坏，或路径里有特殊字符）。请用 Word 打开后另存为 .docx 再上传。';
  }
  const first = s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0] || '未知错误';
  return '转换失败：' + first.slice(0, 200);
}

// ---------- 只杀我们自己开出来的 WINWORD，不动用户自己开着的 Word ----------
function winwordPids() {
  const out = new Set();
  try {
    const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq WINWORD.EXE', '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    const txt = String(r.stdout || '');
    for (const line of txt.split(/\r?\n/)) {
      const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
      if (m) out.add(Number(m[2]));
    }
  } catch {}
  return out;
}

function killTree(pid) {
  try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 15000, windowsHide: true }); } catch {}
}

function killWordNewerThan(before) {
  // before 是转换开始前就已经存在的 WINWORD 进程号集合；这些不杀
  const now = winwordPids();
  for (const pid of now) if (!before.has(pid)) killTree(pid);
}

// 工作台被强杀（或上一次转换失败）时，Word 的自动化进程会留在后台不退出。
// 这些残留的 WINWORD 会把后面每一次转换都拖住甚至卡死，所以启动时清一遍。
// 只清「/Automation -Embedding」的自动化进程，用户自己双击打开的 Word 不会被动到。
export function killOrphanAutomation() {
  let n = 0;
  try {
    const r = spawnSync(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='WINWORD.EXE'\" | Where-Object { $_.CommandLine -like '*/Automation*' } | ForEach-Object { $_.ProcessId }"
    ], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    const pids = String(r.stdout || '').split(/\r?\n/).map((x) => Number(x.trim())).filter((x) => x > 0);
    for (const pid of pids) { killTree(pid); n++; }
  } catch {}
  return n;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 跑一段 PowerShell 脚本；超时/取消时杀掉进程树和它开出来的 Word
function runPs(psLines, opts) {
  const o = opts || {};
  const timeoutMs = (o.timeoutMs || ((loadConfig().convertTimeoutSec || 480) * 1000));
  // 中间那段编码设置必须加：不设的话 PowerShell 按 GBK 输出，Word 的中文报错到了 Node 里变乱码，
  // 下面的 wordHint() 就认不出来，用户只会看到一堆「?????」。
  const psFile = path.join(os.tmpdir(), 'twb_conv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) + '.ps1');
  // PowerShell 5.1 必须带 BOM 才会按 UTF-8 读脚本，否则中文路径变乱码，Word 报「找不到您的文件」
  // 统一前缀：输出按 UTF-8（否则 Word 的中文报错是乱码，翻不成人话）+ 遇错即停
  const full = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\r\n$ErrorActionPreference = "Stop"\r\n' + psLines;
  fs.writeFileSync(psFile, '\ufeff' + full, 'utf8');

  return new Promise((resolve, reject) => {
    let done = false;
    let out = '';
    let err = '';
    let child = null;
    let tick = null;
    const startedAt = Date.now();
    const before = winwordPids();

    const cleanup = () => {
      if (tick) { clearInterval(tick); tick = null; }
      try { fs.unlinkSync(psFile); } catch {}
    };
    const finish = (fn, val) => {
      if (done) return;
      done = true;
      cleanup();
      fn(val);
    };
    const abortNow = (reason, code) => {
      if (done) return;
      try { if (child && child.pid) killTree(child.pid); } catch {}
      killWordNewerThan(before);
      const e = new Error(reason);
      e.code = code;
      e.stderr = err;
      finish(reject, e);
    };

    try {
      child = spawn(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      cleanup();
      return reject(new Error(wordHint(e)));
    }

    if (child.stdout) child.stdout.on('data', (b) => { out += String(b); });
    if (child.stderr) child.stderr.on('data', (b) => { err += String(b); });

    const timer = setTimeout(() => {
      const waited = timeoutMs >= 120000 ? Math.round(timeoutMs / 60000) + ' 分钟' : Math.round(timeoutMs / 1000) + ' 秒';
      abortNow('Word 转换超时（已经等了 ' + waited + '），已经把它停掉了，改用只读文字的方式核查。', 'CONVERT_TIMEOUT');
    }, timeoutMs);

    // 每 3 秒回一次「还在转，已经等了多久」，让前端有东西可显示
    tick = setInterval(() => {
      if (done) return;
      if (typeof o.onProgress === 'function') {
        try { o.onProgress(Math.round((Date.now() - startedAt) / 1000)); } catch {}
      }
    }, 3000);
    if (tick.unref) tick.unref();

    const onSignalAbort = () => abortNow('已取消', 'CONVERT_CANCELLED');
    if (o.signal) {
      if (o.signal.aborted) onSignalAbort();
      else if (typeof o.signal.addEventListener === 'function') o.signal.addEventListener('abort', onSignalAbort, { once: true });
    }

    child.on('error', (e) => { clearTimeout(timer); cleanup(); if (!done) { done = true; reject(new Error(wordHint(e))); } });
    child.on('close', (codeNum) => {
      clearTimeout(timer);
      if (done) return;
      if (codeNum === 0) return finish(resolve, { out, err });
      const e = new Error(wordHint({ message: err || out }));
      e.code = 'CONVERT_FAILED';
      e.stderr = err;
      finish(reject, e);
    });
  });
}

function psQuote(p) { return String(p).replace(/"/g, '""'); }

// .doc → .docx
export async function docToDocxAsync(docPath, outPath, opts) {
  const o = opts || {};
  const tmpOut = outPath + '.part';
  try { fs.unlinkSync(tmpOut); } catch {}
  const ps = [
    '$w = New-Object -ComObject Word.Application',
    '$w.Visible = $false',
    '$w.DisplayAlerts = 0',
    '$d = $w.Documents.Open("' + psQuote(docPath) + '", $false, $true)',
    '$d.SaveAs2("' + psQuote(tmpOut) + '", 16)',
    '$d.Close(0)',
    '$w.Quit()',
    'Write-Output "OK"'
  ].join('\r\n');
  const r = await runPs(ps, o);
  if (!fs.existsSync(tmpOut)) throw new Error(r && r.err ? wordHint({ message: r.err }) : 'Word 没能把 .doc 转成 .docx');
  try { fs.unlinkSync(outPath); } catch {}
  fs.renameSync(tmpOut, outPath);
  return fs.readFileSync(outPath);
}

// .docx → PDF（页脚页码、空白页、正副本标注都要看真实排版，所以必须转 PDF）
export async function docxToPdfAsync(docxPath, pdfPath, opts) {
  const o = opts || {};
  const tmpOut = pdfPath + '.part';
  try { fs.unlinkSync(tmpOut); } catch {}
  const ps = [
    '$w = New-Object -ComObject Word.Application',
    '$w.Visible = $false',
    '$w.DisplayAlerts = 0',
    '$d = $w.Documents.Open("' + psQuote(docxPath) + '", $false, $true)',
    'try { $d.Fields.Update() } catch {}',
    'try { foreach ($t in $d.TablesOfContents) { $t.Update() } } catch {}',
    '$d.ExportAsFixedFormat("' + psQuote(tmpOut) + '", 17)',
    '$d.Close(0)',
    '$w.Quit()',
    'Write-Output "OK"'
  ].join('\r\n');
  const r = await runPs(ps, o);
  if (!fs.existsSync(tmpOut)) throw new Error(r && r.err ? wordHint({ message: r.err }) : 'Word 没能导出 PDF');
  try { fs.unlinkSync(pdfPath); } catch {}
  fs.renameSync(tmpOut, pdfPath);
  return true;
}

// 给「按页看原文」之类的地方用：简单串行跑，不需要进度
export { sleep, winwordPids };
