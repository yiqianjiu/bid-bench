import { loadConfig } from './config.mjs';

export function apiReady() {
  const cfg = loadConfig();
  return !!cfg.deepseekApiKey;
}

async function chatOnce(messages, opts, attempt) {
  const cfg = loadConfig();
  if (!cfg.deepseekApiKey) throw new Error('还没有填写 DeepSeek API Key，请到「设置」里填。');
  const body = {
    model: (opts && opts.model) || cfg.deepseekModel || 'deepseek-flash',
    messages,
    temperature: opts && opts.temperature !== undefined ? opts.temperature : 0.2,
    max_tokens: (opts && opts.maxTokens) || 8000
  };
  // deepseek-flash 默认会先"想"很久（effort=high），对"照着原文抽 JSON"这类任务只会
  // 把输出额度耗光导致正文被截断；统一用 none 低延迟输出。
  body.reasoning_effort = (opts && opts.reasoningEffort) || 'none';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), (opts && opts.timeoutMs) || 240000);
  let resp;
  try {
    resp = await fetch((cfg.deepseekBaseUrl || 'https://api.deepseek.com').replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.deepseekApiKey },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
  } catch (e) {
    clearTimeout(timer);
    throw new Error('连不上 DeepSeek（网络或代理问题）：' + (e && e.message ? e.message : e));
  }
  clearTimeout(timer);
  const txt = await resp.text();
  if (!resp.ok) {
    let msg = txt.slice(0, 300);
    try { const j = JSON.parse(txt); msg = j.error && j.error.message ? j.error.message : msg; } catch {}
    if (resp.status === 401) msg = 'API Key 不正确或已失效（' + msg + '）';
    if (resp.status === 402) msg = ' DeepSeek 账户余额不足（' + msg + '）';
    throw new Error('DeepSeek 调用失败 [' + resp.status + ']：' + msg);
  }
  let data;
  try { data = JSON.parse(txt); } catch { throw new Error('DeepSeek 返回了无法解析的内容'); }
  const choice = (data.choices && data.choices[0]) || {};
  const msgObj = choice.message || {};
  let content = msgObj.content;
  const reason = choice.finish_reason;
  if (!content && msgObj.reasoning_content) content = msgObj.reasoning_content;
  if (!content) {
    if (reason === 'length') throw new Error('这次要读的内容太多，AI 输出被截断了（可以少选几页再试）');
    throw new Error('DeepSeek 没有返回内容（' + (reason || '未知原因') + '），重试一次通常就好');
  }
  return content;
}

export async function chatMessages(messages, opts) { return chat(messages, opts); }

async function chat(messages, opts) {
  // 大模型有时会先"想"很久、把输出额度耗光，导致正文为空；这里自动重试一次并放大额度。
  const first = { ...(opts || {}) };
  delete first.json;
  try {
    return await chatOnce(messages, first, 1);
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    const retryable = /没有返回内容|输出被截断|无法解析/.test(msg);
    if (!retryable) throw e;
    const bigger = { ...first, maxTokens: Math.min((first.maxTokens || 8000) * 2, 32000), temperature: 0.1 };
    const out = await chatOnce(messages, bigger, 2);
    if (out) return out;
    throw e;
  }
}

function tryJson(text) {
  const t = String(text || '').trim();
  const fenced = /\u0060\u0060\u0060(?:json)?\s*([\s\S]*?)\u0060\u0060\u0060/.exec(t);
  const cand = fenced ? fenced[1] : t;
  try { return JSON.parse(cand); } catch {}
  const s = cand.indexOf('{');
  const e = cand.lastIndexOf('}');
  if (s !== -1 && e > s) {
    try { return JSON.parse(cand.slice(s, e + 1)); } catch {}
  }
  throw new Error('AI 返回的内容不是标准 JSON，请重试一次');
}

export async function callJson(system, user, opts) {
  const content = await chat(
    [{ role: 'system', content: system }, { role: 'user', content: user }],
    { ...(opts || {}), json: true }
  );
  return tryJson(content);
}

export async function callText(system, user, opts) {
  return chat(
    [{ role: 'system', content: system }, { role: 'user', content: user }],
    opts || {}
  );
}

// 用图片让 AI 读扫描页
export async function callVisionJson(system, instruction, images) {
  const content = [{ type: 'text', text: instruction }];
  for (const img of images) {
    content.push({ type: 'image_url', image_url: { url: 'data:image/png;base64,' + img.toString('base64') } });
  }
  const model = loadConfig().deepseekModel || 'deepseek-flash';
  const out = await chat([{ role: 'system', content: system }, { role: 'user', content }], { json: true, model });
  return tryJson(out);
}