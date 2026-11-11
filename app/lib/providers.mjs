// v1.2.3：模型服务层。
// 以前整个程序只会连 DeepSeek（写死了 baseUrl + deepseekModel）。
// 现在把「连哪个模型」抽成一份可增删改的列表，任何 OpenAI 兼容接口都能接：
// DeepSeek / 通义千问 / Kimi / 智谱 / OpenAI / Ollama / LM Studio / vLLM ...
// 每个能力（分析、核查、评标、撰写、知识卡、看图）可以各指一个模型。
import { loadConfig, saveConfig } from './config.mjs';

// 常见服务商的预设。用户点一下就能填好地址，只差 Key。
export const PRESETS = [
  { kind: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', needKey: true, vision: false, json: true },
  { kind: 'dashscope', name: '通义千问（阿里云）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', needKey: true, vision: true, json: true },
  { kind: 'kimi', name: 'Kimi（月之暗面）', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-32k', needKey: true, vision: false, json: true },
  { kind: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus', needKey: true, vision: true, json: true },
  { kind: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', needKey: true, vision: true, json: true },
  { kind: 'ollama', name: 'Ollama（本机）', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:14b', needKey: false, vision: false, json: true, local: true },
  { kind: 'lmstudio', name: 'LM Studio（本机）', baseUrl: 'http://127.0.0.1:1234/v1', model: 'local-model', needKey: false, vision: false, json: true, local: true },
  { kind: 'vllm', name: 'vLLM（本机/内网）', baseUrl: 'http://127.0.0.1:8000/v1', model: 'local-model', needKey: false, vision: false, json: true, local: true },
  { kind: 'custom', name: '自定义（OpenAI 兼容）', baseUrl: '', model: '', needKey: true, vision: false, json: true }
];

export const PURPOSES = [
  { key: 'analyze', name: '读招标文件、分析关键信息', desc: '要能读懂长招标文件，建议用能力强的大模型' },
  { key: 'check', name: '投标文件逐条核查', desc: '要对照几百条要求逐条判，量大、调用次数多' },
  { key: 'score', name: '模拟评标打分', desc: '按评分表逐项打分并给提分建议' },
  { key: 'draft', name: '投标文件正文撰写', desc: '写章节正文、扩写、改写' },
  { key: 'card', name: '知识卡提炼', desc: '从历史项目里提炼可复用的经验' },
  { key: 'profile', name: '专家画像提炼', desc: '提炼技术/商务方向与能力标签' },
  { key: 'vision', name: '看扫描页图片', desc: '本机 OCR 认不出来的页面，交给能看图的模型' }
];

export function presetOf(kind) {
  return PRESETS.find((p) => p.kind === kind) || PRESETS[PRESETS.length - 1];
}

export function maskKey(k) {
  const s = String(k || '');
  if (!s) return '';
  if (s.length <= 10) return s.slice(0, 2) + '****';
  return s.slice(0, 6) + '****' + s.slice(-4);
}

function normBase(u) {
  return String(u || '').trim().replace(/\/+$/, '');
}

function normOne(p, i) {
  const pre = presetOf(p.kind);
  return {
    id: String(p.id || 'p' + (i + 1)),
    name: String(p.name || pre.name || '模型服务'),
    kind: p.kind || 'custom',
    baseUrl: normBase(p.baseUrl || pre.baseUrl || ''),
    apiKey: String(p.apiKey || ''),
    model: String(p.model || pre.model || ''),
    vision: p.vision !== undefined ? !!p.vision : !!pre.vision,
    json: p.json !== undefined ? !!p.json : pre.json !== false,
    local: p.local !== undefined ? !!p.local : !!pre.local,
    timeoutSec: Math.max(30, Math.min(1800, Number(p.timeoutSec) || 300)),
    enabled: p.enabled === undefined ? true : !!p.enabled
  };
}

// 把老配置（只有 deepseekApiKey / deepseekBaseUrl / deepseekModel 三个字段）自动转成一条模型服务。
// 用户升级后不用重新填 Key。
export function migrateProviders(cfg) {
  const c = cfg || loadConfig();
  const list = Array.isArray(c.providers) ? c.providers.filter(Boolean) : [];
  if (list.length) return { providers: list.map(normOne), migrated: false };
  const key = String(c.deepseekApiKey || '');
  const base = normBase(c.deepseekBaseUrl || 'https://api.deepseek.com');
  const model = String(c.deepseekModel || 'deepseek-chat');
  if (!key && (!c.deepseekBaseUrl || base === 'https://api.deepseek.com')) {
    // 什么都没有：给一条空白的 DeepSeek 预设，用户填个 Key 就能用
    return {
      providers: [normOne({ id: 'p_deepseek', kind: 'deepseek', name: 'DeepSeek', baseUrl: base || 'https://api.deepseek.com', model: model || 'deepseek-chat', apiKey: '' }, 0)],
      migrated: false
    };
  }
  return {
    providers: [normOne({ id: 'p_deepseek', kind: 'deepseek', name: 'DeepSeek', baseUrl: base, model, apiKey: key }, 0)],
    migrated: true
  };
}

export function getProviders() {
  const cfg = loadConfig();
  const m = migrateProviders(cfg);
  return m.providers;
}

// 存盘：同时把老字段同步过去，别的模块（导出、健康检查）还在读 deepseek*
export function saveProviders(list) {
  const arr = (Array.isArray(list) ? list : []).map(normOne);
  const first = arr[0] || null;
  const patch = { providers: arr };
  if (first) {
    patch.deepseekApiKey = first.apiKey || '';
    patch.deepseekBaseUrl = first.baseUrl || '';
    patch.deepseekModel = first.model || '';
  }
  return saveConfig(patch);
}

export function getPurposes() {
  const cfg = loadConfig();
  return { ...(cfg.purposes || {}) };
}

export function savePurposes(p) {
  return saveConfig({ purposes: { ...(p || {}) } });
}

export function providerById(id) {
  return getProviders().find((p) => p.id === id) || null;
}

function usable(p) {
  if (!p || !p.enabled) return false;
  if (!p.baseUrl || !p.model) return false;
  if (presetOf(p.kind).needKey && !p.apiKey) return false;
  return true;
}

// 按用途挑模型：用途指定 → 默认模型 → 第一条能用的
export function resolveProvider(purpose) {
  const cfg = loadConfig();
  const list = getProviders();
  const purposes = cfg.purposes || {};
  const candidates = [];
  const want = purpose ? purposes[purpose] : '';
  if (want) candidates.push(want);
  if (cfg.defaultProvider) candidates.push(cfg.defaultProvider);
  for (const p of list) candidates.push(p.id);
  for (const id of candidates) {
    const p = list.find((x) => x.id === id);
    if (usable(p)) return p;
  }
  return null;
}

export function apiReady() {
  return !!resolveProvider('');
}

// 能看图的模型（给「看图识别」下拉框用）
export function visionProviders() {
  return getProviders().filter((p) => p.vision && usable(p));
}

// 所有「能用」的服务（enabled + 地址/模型/Key 齐），供失败自动切换用
export function seeUsable() {
  return getProviders().filter(usable);
}

export function providerSummary() {
  return getProviders().map((p) => ({
    id: p.id,
    name: p.name,
    kind: p.kind,
    baseUrl: p.baseUrl,
    model: p.model,
    vision: p.vision,
    local: p.local,
    enabled: p.enabled,
    timeoutSec: p.timeoutSec,
    hasKey: !!p.apiKey,
    apiKeyMasked: maskKey(p.apiKey),
    usable: usable(p)
  }));
}

// 测试连接：发一句最短的话，看能不能正常返回
export async function testProviderOp(id) {
  const cfg = loadConfig();
  const p = id ? providerById(id) : resolveProvider('');
  if (!p) return { ok: false, error: '还没有可用的模型服务，请先填一个' };
  const t0 = Date.now();
  try {
    const out = await rawChat(p, [{ role: 'user', content: '回复两个字：可以' }], { maxTokens: 32, timeoutMs: 30000, noJson: true });
    return { ok: true, ms: Date.now() - t0, model: p.model, text: String(out || '').slice(0, 60) };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, model: p.model, error: String(e && e.message || e) };
  }
}

// 参数兼容处理：小模型/某些服务不认 reasoning_effort、response_format，
// 报错了就把它们去掉再试一次，而不是让整次调用失败。
const OPTIONAL_PARAMS = ['reasoning_effort', 'response_format'];

export async function rawChat(pIn, messages, opts) {
  const o = opts || {};
  // 名称兜底：草稿配置（还没保存）时可能没带 name，别让报错里出现 undefined
  const p = { ...(pIn || {}) };
  p.name = p.name || presetOf(p.kind).name || '模型服务';
  const body = {
    model: p.model,
    messages,
    temperature: o.temperature !== undefined ? o.temperature : 0.2,
    max_tokens: o.maxTokens || 8000,
    stream: false
  };
  if (!o.noJson && p.json && o.json) body.response_format = { type: 'json_object' };
  if (o.reasoningEffort) body.reasoning_effort = o.reasoningEffort;

  const timeoutMs = o.timeoutMs || (p.timeoutSec || 300) * 1000;
  const url = normBase(p.baseUrl) + '/chat/completions';
  const headers = { 'Content-Type': 'application/json' };
  if (p.apiKey) headers.Authorization = 'Bearer ' + p.apiKey;

  const attempt = async (payload) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => { try { ctrl.abort(); } catch {} }, timeoutMs);
    let resp;
    try {
      resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: ctrl.signal });
    } catch (e) {
      clearTimeout(timer);
      const msg = String(e && e.message || e);
      const timeout = /abort/i.test(msg) || (e && e.name === 'AbortError');
      throw Object.assign(new Error(timeout ? ('等 ' + p.name + ' 超过 ' + Math.round(timeoutMs / 1000) + ' 秒还没返回（模型太慢或网络断了）') : ('连不上 ' + p.name + '（' + normBase(p.baseUrl) + '）：' + msg)), { status: 0 });
    }
    clearTimeout(timer);
    const txt = await resp.text();
    if (!resp.ok) {
      let msg = txt.slice(0, 300);
      try { const j = JSON.parse(txt); msg = (j.error && j.error.message) || (j.message) || msg; } catch {}
      if (resp.status === 401 || resp.status === 403) msg = 'API Key 不正确或没有权限（' + msg + '）';
      if (resp.status === 402) msg = '账户余额不足（' + msg + '）';
      if (resp.status === 404) msg = '地址或模型名不对，检查一下 Base URL 和模型名（' + msg + '）';
      if (resp.status === 429) msg = '调用太频繁被限流了，等一会儿再试（' + msg + '）';
      const err = new Error(p.name + ' 调用失败 [' + resp.status + ']：' + msg);
      err.status = resp.status;
      err.detail = msg;
      throw err;
    }
    let data;
    try { data = JSON.parse(txt); } catch { throw new Error(p.name + ' 返回了无法解析的内容'); }
    const choice = (data.choices && data.choices[0]) || {};
    const m = choice.message || {};
    let content = m.content;
    if (!content && m.reasoning_content) content = m.reasoning_content;
    if (!content) {
      const reason = choice.finish_reason;
      if (reason === 'length') throw new Error('这次要读的内容太多，AI 输出被截断了（可以少选几页再试）');
      throw new Error(p.name + ' 没有返回内容（' + (reason || '未知原因') + '），重试一次通常就好');
    }
    return content;
  };

  try {
    return await attempt(body);
  } catch (e) {
    // 参数不兼容：把可选参数去掉再试一次
    const msg = String(e && e.message || '');
    const bad = OPTIONAL_PARAMS.filter((k) => k in body && new RegExp(k, 'i').test(msg));
    if (bad.length) {
      const slim = { ...body };
      for (const k of bad) delete slim[k];
      return attempt(slim);
    }
    // 400 / 422 里提到「不支持 / unknown / not support / invalid」也当作参数不兼容
    if ((e.status === 400 || e.status === 422) && /not support|unsupported|unknown|invalid|unrecognized/i.test(msg)) {
      const slim = { ...body };
      let removed = false;
      for (const k of OPTIONAL_PARAMS) { if (k in slim) { delete slim[k]; removed = true; } }
      if (removed) return attempt(slim);
    }
    throw e;
  }
}
