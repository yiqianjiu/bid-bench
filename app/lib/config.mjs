import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 工作目录不写死：默认取本程序所在目录的上一级，
// 也可以用环境变量 TWB_ROOT 指定（比如把程序和数据分开放在不同盘）。
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APP_DIR = path.resolve(HERE, '..');
export const ROOT = process.env.TWB_ROOT ? path.resolve(process.env.TWB_ROOT) : path.resolve(APP_DIR, '..');
export const WEB_DIR = path.join(APP_DIR, 'web');
export const DATA_DIR = path.join(ROOT, '数据');
export const UPLOAD_DIR = path.join(DATA_DIR, '上传');
export const PROJECT_DIR = path.join(ROOT, '项目');
export const ARCHIVE_DIR = path.join(ROOT, '归档');
export const TEMPLATE_DIR = path.join(ROOT, '模板');
export const CONFIG_FILE = path.join(APP_DIR, 'config.json');
export const DB_FILE = path.join(DATA_DIR, 'workbench.db');

export const DEFAULT_CONFIG = {
  port: 7830,
  deepseekApiKey: '',
  deepseekBaseUrl: 'https://api.deepseek.com',
  deepseekModel: 'deepseek-flash',
  company: '',
  // v1.1.5：关掉网页就自动关掉后台服务（默认开）。关掉后需要手动点「关闭工作台」
  autoExitOnClose: true,
  // v1.2.3：Word 转 PDF 最长等多久（秒）。超大标书要几分钟，超过就停下并降级为文字类核查
  convertTimeoutSec: 480,
  version: '1.2.4'
};

export function ensureDirs() {
  for (const d of [ROOT, APP_DIR, DATA_DIR, UPLOAD_DIR, PROJECT_DIR, ARCHIVE_DIR, TEMPLATE_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

export function loadConfig() {
  ensureDirs();
  let cfg = { ...DEFAULT_CONFIG };
  if (fs.existsSync(CONFIG_FILE)) {
    try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; } catch {}
  }
  return cfg;
}

export function saveConfig(patch) {
  const cfg = { ...loadConfig(), ...patch };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  return cfg;
}
