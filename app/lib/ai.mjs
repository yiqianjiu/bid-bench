// v1.2.3：AI 调用层。原来是写死连 DeepSeek，现在按「用途」从模型服务列表里挑一个可用的。
// 每个用途（分析/核查/评标/撰写/知识卡/画像/看图）可以在设置里单独指定模型；
// 没指定就用默认模型；默认也连不上就自动往后面找能用的那条。
import { loadConfig } from './config.mjs';
import { resolveProvider, rawChat, apiReady as providersReady, visionProviders } from './providers.mjs';

export { apiReady } from './providers.mjs';

// 按用途挑模型；挑不到时报一句人话
function pick(purpose) {
  const p = resolveProvider(purpose);
  if (p) return p;
  const cfg = loadConfig();
  if (cfg.deepseekApiKey || (cfg.providers && cfg.providers.length)) {
    throw new Error('模型服务都用不了：请到「设置 → 模型服务」里检查地址、Key 和模型名，点「测试连接」看看。');
  }
  throw new Error('还没有配置模型服务，请到「设置 → 模型服务」里填一个（DeepSeek 之类都行）。');
}

async function chatOnce(messages, opts) {
  const o = opts || {};
  const p = o.provider || pick(o.purpose);
  const content = await rawChat(p, messages, {
    temperature: o.temperature !== undefined ? o.temperature : 0.2,
    maxTokens: o.maxTokens || 8000,
    timeoutMs: o.timeoutMs,
    json: !!o.json,
    // deepseek-flash 这类模型默认会先"想"很久，对「照原文抽 JSON」只会把额度耗光导致正文被截断
    reasoningEffort: o.reasoningEffort || (p.kind === 'deepseek' ? 'none' : '')
  });
  o._provider = p;
  return content;
}

export async function chatMessages(messages, opts) {
  return chat(messages, opts);
}

async function chat(messages, opts) {
  // 大模型有时会先"想"很久、把输出额度耗光，导致正文为空；这里自动重试一次并放大额度。
  const first = { ...(opts || {}) };
  delete first.json;
  try {
    return await chatOnce(messages, first);
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);

    // 主模型挂了（超时/连不上/5xx/没有返回内容）时，如果还配了别的模型，自动换一个再试，
    // 免得夜里跑长任务被一条挂掉的线路卡死。Key/余额/模型名这类错误换了也没用，不重试。
    const hardFail = /API Key 不正确|没有权限|余额不足|地址或模型名不对|调用失败 \[4\d\d\]/i.test(msg);
    const tryFailover = !first.noFailover && !hardFail;
    if (tryFailover) {
      const list = (await import('./providers.mjs')).seeUsable();
      const triedId = first.provider ? first.provider.id : '';
      for (const cand of list) {
        if (cand.id === triedId) continue;
        try {
          return await chatOnce(messages, { ...first, provider: cand, noFailover: true });
        } catch {}
      }
    }

    const retryable = /没有返回内容|输出被截断|无法解析/.test(msg);
    if (!retryable) throw e;
    const bigger = { ...first, maxTokens: Math.min((first.maxTokens || 8000) * 2, 32000), temperature: 0.1, noFailover: true };
    const out = await chatOnce(messages, bigger);
    if (out) return out;
    throw e;
  }
}

// v1.2.0：把被截断的 JSON 尽量救回来 —— 从最后一个完整成员处截断，再补齐括号。
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
    // JSON 没闭合，十有八九是输出额度被截断了。放大额度再来一次。
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

// 用图片让 AI 读扫描页。v1.2.3：只挑「支持看图」的模型；
// 一个都没有就返回 null，调用方（lib/text.mjs）走本机 OCR。
export async function callVisionJson(system, instruction, images) {
  const cfg = loadConfig();
  const list = visionProviders();
  let chosen = null;
  if (cfg.purposes && cfg.purposes.vision) {
    chosen = list.find((p) => p.id === cfg.purposes.vision) || null;
  }
  if (!chosen) chosen = list[0] || null;
  if (!chosen) return null;

  const content = [{ type: 'text', text: instruction }];
  for (const img of images) {
    content.push({ type: 'image_url', image_url: { url: 'data:image/png;base64,' + img.toString('base64') } });
  }
  const out = await chat(
    [{ role: 'system', content: system }, { role: 'user', content }],
    { json: true, provider: chosen, purpose: 'vision', maxTokens: 4000, timeoutMs: 180000 }
  );
  return tryJson(out);
}
