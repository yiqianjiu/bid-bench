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

// v1.2.0：把被截断的 JSON 尽量救回来 —— 从最后一个完整成员处截断，再补齐括号。
// 读招标文件时一段 16 页的 JSON 经常超额度，能救回来就不用整段重跑。
function repairJson(s) {
  const stack = [];
  let inStr = false, esc = false, lastSafe = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{' || c === '[') { stack.push(c === '{' ? '}' : ']'); continue; }
    if (c === '}' || c === ']') { stack.pop(); if (stack.length) lastSafe = i; continue; }
    if (c === ',' && stack.length) lastSafe = i;
  }
  if (!stack.length) return null;
  if (lastSafe < 0) return null;
  const head = s.slice(0, lastSafe);
  // 重算 head 结尾处的栈
  const st2 = [];
  let inS = false, es = false;
  for (let i = 0; i < head.length; i++) {
    const c = head[i];
    if (inS) { if (es) es = false; else if (c === '\\') es = true; else if (c === '"') inS = false; continue; }
    if (c === '"') inS = true;
    else if (c === '{') st2.push('}');
    else if (c === '[') st2.push(']');
    else if (c === '}' || c === ']') st2.pop();
  }
  return head + st2.reverse().join('');
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
  if (s !== -1) {
    const fixed = repairJson(cand.slice(s));
    if (fixed) { try { return JSON.parse(fixed); } catch {} }
  }
  throw new Error('AI 返回的内容不是标准 JSON，请重试一次');
}

export async function callJson(system, user, opts) {
  const base = { ...(opts || {}), json: true };
  const content = await chat(
    [{ role: 'system', content: system }, { role: 'user', content: user }],
    base
  );
  try {
    return tryJson(content);
  } catch (e) {
    // v1.2.0：JSON 没闭合，十有八九是输出额度被截断了。放大额度再来一次，
    // 比让上层整段重跑省一半时间（原来一段 16 页要重试 2 次才失败）。
    const bigger = { ...base, maxTokens: Math.min((base.maxTokens || 8000) * 2, 32000), temperature: 0.1 };
    const out2 = await chat(
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      bigger
    );
    return tryJson(out2);
  }
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