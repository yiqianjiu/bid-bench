// v1.1.4 本地 OCR 能力：AI 读不动扫描件时，自动改用本机 OCR 工具。
// 优先 Windows 自带的 Windows.Media.Ocr（Win10/11 免安装，中文够用）；老系统退回 Tesseract（winget 一键装）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { DATA_DIR } from './config.mjs';

const POWERSHELL = 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const RUNTIME_DIR = path.join(DATA_DIR, '.runtime');
const PS_FILE = path.join(RUNTIME_DIR, 'winocr.ps1');

const TESS_CANDIDATES = [
  'C:\\Program Files\\Tesseract-OCR\\tesseract.exe',
  'C:\\Program Files (x86)\\Tesseract-OCR\\tesseract.exe',
  path.join(os.homedir(), 'AppData\\Local\\Programs\\Tesseract-OCR\\tesseract.exe')
];

// Windows 自带 OCR（WinRT）脚本。写成独立 .ps1 文件再调用，避免编码与转义问题。
const WINOCR_PS = "param([string]$Path, [string]$Out, [string]$Lang = 'zh-Hans-CN')\n$ErrorActionPreference = 'Stop'\nAdd-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null\n$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]\nfunction Await($WinRtTask, $ResultType) {\n  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)\n  $netTask = $asTask.Invoke($null, @($WinRtTask))\n  $netTask.Wait(-1) | Out-Null\n  $netTask.Result\n}\n[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime] | Out-Null\n[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics,ContentType=WindowsRuntime] | Out-Null\n[Windows.Media.Ocr.OcrEngine,Windows.Media,ContentType=WindowsRuntime] | Out-Null\n[Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime] | Out-Null\nfunction IsCjk([string]$s) {\n  if (-not $s) { return $false }\n  $n = [int]$s[0]\n  return (($n -ge 0x3000 -and $n -le 0x303F) -or ($n -ge 0x3400 -and $n -le 0x4DBF) -or ($n -ge 0x4E00 -and $n -le 0x9FFF) -or ($n -ge 0xFF00 -and $n -le 0xFFEF))\n}\n$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])\n$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])\n$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])\n$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])\n$langObj = New-Object Windows.Globalization.Language $Lang\n$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($langObj)\nif (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }\nif (-not $engine) {\n  [System.IO.File]::WriteAllText($Out, '{\"ok\":false,\"error\":\"NO_ENGINE\"}', (New-Object System.Text.UTF8Encoding $false))\n  exit 2\n}\n$sw = [System.Diagnostics.Stopwatch]::StartNew()\n$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])\n$sw.Stop()\n$lines = @()\nforeach ($line in $result.Lines) {\n  $ws = @($line.Words)\n  if ($ws.Count -eq 0) { continue }\n  $sb = New-Object System.Text.StringBuilder\n  $prev = $null\n  $prevRight = 0.0\n  $hgt = 12.0\n  foreach ($w in $ws) {\n    $t = [string]$w.Text\n    if (-not $t) { continue }\n    $r = $w.BoundingRect\n    $x = [double]$r.X\n    $wd = [double]$r.Width\n    $hgt = [double]$r.Height\n    if ($prev -ne $null) {\n      $a = IsCjk $prev\n      $b = IsCjk $t\n      if (-not $a -and -not $b) {\n        $gap = $x - $prevRight\n        if ($gap -gt ($hgt * 0.18)) { [void]$sb.Append(' ') }\n      }\n    }\n    [void]$sb.Append($t)\n    $prev = $t.Substring($t.Length - 1)\n    $prevRight = $x + $wd\n  }\n  $ws0 = @($line.Words)\n  $y0 = [double]$ws0[0].BoundingRect.Y\n  $lines += [pscustomobject]@{ y = [math]::Round($y0, 1); t = $sb.ToString() }\n}\n$obj = [pscustomobject]@{ ok = $true; ms = $sw.ElapsedMilliseconds; lang = $engine.RecognizerLanguage.LanguageTag; lines = $lines }\n[System.IO.File]::WriteAllText($Out, ($obj | ConvertTo-Json -Depth 6 -Compress), (New-Object System.Text.UTF8Encoding $false))\nWrite-Output ('OK ' + $lines.Count)";

function ensurePs() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(WINOCR_PS, 'utf16le')]);
  let need = true;
  try { const old = fs.readFileSync(PS_FILE); need = !old.equals(buf); } catch {}
  if (need) fs.writeFileSync(PS_FILE, buf);
  return PS_FILE;
}

function psRun(args, timeoutMs) {
  return spawnSync(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass'].concat(args), {
    encoding: 'utf8', timeout: timeoutMs || 120000, windowsHide: true
  });
}

function psScript(args, timeoutMs) {
  return psRun(['-File', ensurePs()].concat(args), timeoutMs);
}

let _cache = null;
export function resetOcrCache() { _cache = null; }

export function detectOcr(force) {
  if (!force && _cache && Date.now() - _cache.at < 300000) return _cache;
  const out = { at: Date.now(), winrt: { ok: false, langs: [] }, tesseract: { ok: false, path: '', version: '' }, winget: { ok: false, path: '' } };
  try {
    const cmd = '$l = @(); try { $null = [Windows.Media.Ocr.OcrEngine, Windows.Media, ContentType=WindowsRuntime]; foreach ($x in [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages) { $l += $x.LanguageTag } } catch {}; if ($l.Count) { "WINRT " + ($l -join ",") } else { "WINRT_NONE" }';
    const r = psRun(['-Command', cmd], 30000);
    const m = /WINRT\s+(\S+)/.exec(String(r.stdout || ''));
    if (m && m[1] !== 'WINRT_NONE') { out.winrt.ok = true; out.winrt.langs = m[1].split(',').map((x) => x.trim()).filter(Boolean); }
  } catch {}
  for (const p of TESS_CANDIDATES) {
    if (fs.existsSync(p)) { out.tesseract.ok = true; out.tesseract.path = p; break; }
  }
  if (!out.tesseract.ok) {
    try {
      const r = spawnSync('where', ['tesseract'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
      const line = String(r.stdout || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0];
      if (line && fs.existsSync(line)) { out.tesseract.ok = true; out.tesseract.path = line; }
    } catch {}
  }
  if (out.tesseract.ok) {
    try { out.tesseract.version = String(execFileSync(out.tesseract.path, ['--version'], { encoding: 'utf8', timeout: 8000 }) || '').split('\n')[0].trim(); } catch {}
  }
  try {
    const w = spawnSync('where', ['winget'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    const line = String(w.stdout || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0];
    if (line) { out.winget.ok = true; out.winget.path = line; }
  } catch {}
  out.available = out.winrt.ok || out.tesseract.ok;
  out.best = out.winrt.ok ? 'winrt' : out.tesseract.ok ? 'tesseract' : '';
  _cache = out;
  return out;
}

function pickWinrtLang(d) {
  const langs = (d && d.winrt && d.winrt.langs) || [];
  const want = ['zh-Hans-CN', 'zh-Hans', 'zh-CN', 'zh-Hant-TW', 'zh-Hant'];
  for (const w of want) if (langs.indexOf(w) >= 0) return w;
  return langs[0] || 'zh-Hans-CN';
}

export function winrtOcrFile(imgPath, lang) {
  ensurePs();
  imgPath = path.resolve(imgPath).replace(/\//g, '\\');
  const out = path.join(os.tmpdir(), 'twb_ocr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7) + '.json');
  const r = psScript(['-Path', imgPath, '-Out', out, '-Lang', lang || 'zh-Hans-CN'], 180000);
  let data = null;
  try { data = JSON.parse(fs.readFileSync(out, 'utf8')); } catch {}
  try { fs.unlinkSync(out); } catch {}
  if (!data) throw new Error('本机 OCR 没有返回结果：' + String(r.stderr || r.stdout || '').slice(0, 300));
  if (!data.ok) throw new Error(data.error === 'NO_ENGINE' ? '这台电脑的 Windows OCR 没有装中文语言包' : '本机 OCR 失败：' + (data.error || ''));
  const lines = (data.lines || []).map((x) => ({ y: Number(x.y) || 0, text: String(x.t || '') })).filter((x) => x.text);
  lines.sort((a, b) => a.y - b.y);
  return { text: lines.map((x) => x.text).join('\n'), lines, engine: 'winrt', lang: data.lang || lang || '', ms: data.ms || 0 };
}

export function tesseractOcrFile(imgPath, lang) {
  const d = detectOcr();
  if (!d.tesseract.ok) throw new Error('这台电脑没有安装 Tesseract');
  const outBase = path.join(os.tmpdir(), 'twb_tess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7));
  const langs = lang || 'chi_sim+eng';
  const r = spawnSync(d.tesseract.path, [imgPath, outBase, '-l', langs, '--psm', '6'], { encoding: 'utf8', timeout: 180000, windowsHide: true });
  let text = '';
  try { text = fs.readFileSync(outBase + '.txt', 'utf8'); } catch {}
  try { fs.unlinkSync(outBase + '.txt'); } catch {}
  if (!text && r.status !== 0) throw new Error('Tesseract 识别失败：' + String(r.stderr || '').slice(0, 300));
  const lines = String(text).split(/\r?\n/).map((t, i) => ({ y: i * 10, text: t.trim() })).filter((x) => x.text);
  return { text: lines.map((x) => x.text).join('\n'), lines, engine: 'tesseract', lang: langs, ms: 0 };
}

export function ocrImageFile(imgPath, opts) {
  const d = detectOcr();
  const prefer = (opts && opts.engine) || d.best;
  if (prefer === 'winrt' && d.winrt.ok) {
    try { return winrtOcrFile(imgPath, (opts && opts.lang) || pickWinrtLang(d)); }
    catch (e) { if (!d.tesseract.ok) throw e; }
  }
  if (d.tesseract.ok) return tesseractOcrFile(imgPath, (opts && opts.tessLang) || 'chi_sim+eng');
  if (d.winrt.ok) return winrtOcrFile(imgPath, pickWinrtLang(d));
  const err = new Error('这台电脑没有可用的 OCR 工具（Windows 自带 OCR 不可用，也没装 Tesseract）。');
  err.code = 'NO_OCR_TOOL';
  throw err;
}

export function installTesseract() {
  const d = detectOcr(true);
  if (!d.winget.ok) {
    const err = new Error('这台电脑没有 winget，没法自动安装。请到 https://github.com/UB-Mannheim/tesseract/wiki 下载安装包手动装。');
    err.code = 'NO_WINGET';
    throw err;
  }
  const r = spawnSync(d.winget.path, [
    'install', '--id', 'UB-Mannheim.TesseractOCR', '-e',
    '--accept-package-agreements', '--accept-source-agreements',
    '--disable-interactivity'
  ], { encoding: 'utf8', timeout: 900000, windowsHide: true });
  resetOcrCache();
  const after = detectOcr(true);
  return {
    ok: after.tesseract.ok,
    code: r.status,
    stdout: String(r.stdout || '').slice(-4000),
    stderr: String(r.stderr || '').slice(-2000),
    tesseract: after.tesseract,
    note: after.tesseract.ok ? '已安装好，可以直接识别了。' : '安装命令跑完了，但还没找到 tesseract.exe，可能需要重启工作台再试一次。'
  };
}
