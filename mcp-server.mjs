#!/usr/bin/env node
/**
 * Strata Mac MCP Server
 *
 * 把本机 llama-server 上的 Qwen3.8-Flash-Next 暴露成 WorkBuddy 可调用的工具。
 * 纯 stdio JSON-RPC，无第三方依赖。
 *
 * 关键设计：
 *   - 每个请求都带 cache_prompt: true，保证前缀缓存命中（多轮对话只 prefill 新增部分）
 *   - 统计信息从 llama-server 的 timings 字段读取，不靠客户端估算
 *   - 复用同一个 sessionId，让 llama-server 的前缀缓存有稳定的复用目标
 */

const SERVE = process.env.STRATA_SERVE || 'http://127.0.0.1:8080';
const MODEL_LABEL = process.env.STRATA_MODEL_LABEL || 'Qwen3.8-Flash-Next (Q2_0, 本地)';

/* ── 极简 MCP 框架（stdio + JSON-RPC 2.0） ───────────────────────── */

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg).catch((e) => {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e) } });
    });
  }
});

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/* ── HTTP 帮助函数 ───────────────────────────────────────────────── */

async function httpJson(path, opts = {}) {
  const url = SERVE + path;
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    throw new Error(`llama-server ${res.status}: ${text.slice(0, 300)}`);
  }
  return data;
}

/** 判断服务是否在跑 */
async function serverUp() {
  try {
    const r = await fetch(SERVE + '/v1/models', { signal: AbortSignal.timeout(2500) });
    return r.ok || r.status === 401;
  } catch {
    return false;
  }
}

/* ── 工具定义 ───────────────────────────────────────────────────── */

const TOOLS = [
  {
    name: 'local_chat',
    description:
      '用本机跑的大模型（Qwen3.8-Flash-Next，125B MoE / 6B 激活，Q2_0 量化）生成回答。' +
      '适合需要本地算力、隐私敏感、或想省云端额度的任务。' +
      '返回内容里包含实测速度与 KV 缓存命中数。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '用户消息内容' },
        system: { type: 'string', description: '可选的系统提示词' },
        max_tokens: { type: 'number', description: '最多生成多少 token，默认 2048' },
        temperature: { type: 'number', description: '采样温度，默认 0.7；写代码建议 0.2' },
        reasoning_effort: {
          type: 'string',
          enum: ['none', 'low', 'medium', 'high', 'xhigh'],
          description: '思考深度。xhigh 最深（默认），low 最快',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'local_status',
    description: '查看本地模型服务的状态：是否加载、上下文长度、并行槽位、显存与内存配置。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'local_models',
    description: '列出本机可用的 GGUF 模型文件及其体积。',
    inputSchema: { type: 'object', properties: {} },
  },
];

/* ── 工具实现 ───────────────────────────────────────────────────── */

async function toolChat(args) {
  if (!(await serverUp())) {
    return {
      content: [{
        type: 'text',
        text: '本地模型服务没在运行。请打开「Strata Mac」应用，点「启动服务」后再试。',
      }],
      isError: true,
    };
  }

  const messages = [];
  if (args.system) messages.push({ role: 'system', content: args.system });
  messages.push({ role: 'user', content: String(args.prompt || '') });

  const body = {
    messages,
    max_tokens: Number(args.max_tokens) || 2048,
    temperature: args.temperature === undefined ? 0.7 : Number(args.temperature),
    // 关键：让 llama-server 复用前缀缓存，多轮对话只 prefill 新增部分
    cache_prompt: true,
  };
  if (args.reasoning_effort) body.reasoning_effort = String(args.reasoning_effort);

  const t0 = Date.now();
  const d = await httpJson('/v1/chat/completions', { method: 'POST', body });
  const wall = (Date.now() - t0) / 1000;

  const msg = d.choices?.[0]?.message || {};
  const think = msg.reasoning_content || '';
  const content = msg.content || '';
  const u = d.usage || {};
  const t = d.timings || {};

  // llama.cpp 的 timings 字段（比自行估算准）
  const prefillRate = t.prompt_per_second || (u.prompt_tokens && t.prompt_ms ? u.prompt_tokens / (t.prompt_ms / 1000) : 0);
  const decodeRate = t.predicted_per_second || (u.completion_tokens && t.predicted_ms ? u.completion_tokens / (t.predicted_ms / 1000) : 0);
  const cached = (u.prompt_tokens_details || {}).cached_tokens || 0;

  const lines = [];
  if (think) lines.push('【思考过程】\n' + think, '');
  lines.push(content || '(无输出)');
  lines.push('');
  lines.push('---');
  lines.push(
    `速度：提示词处理 ${prefillRate ? prefillRate.toFixed(1) + ' tok/s' : '—'}` +
    ` · 输出 ${decodeRate ? decodeRate.toFixed(1) + ' tok/s' : '—'}` +
    ` · 墙钟 ${wall.toFixed(1)}s`
  );
  lines.push(
    `Token：输入 ${u.prompt_tokens ?? '—'}` +
    (cached ? `（缓存命中 ${cached}，复用率 ${((cached / u.prompt_tokens) * 100).toFixed(0)}%）` : '（无缓存命中）') +
    ` · 输出 ${u.completion_tokens ?? '—'}`
  );

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

async function toolStatus() {
  if (!(await serverUp())) {
    return {
      content: [{ type: 'text', text: '本地模型服务未运行。打开「Strata Mac」应用点「启动服务」。' }],
    };
  }
  const p = await httpJson('/props');
  const mods = p.modalities || {};
  const caps = Object.entries(mods).filter(([, v]) => v).map(([k]) => k);
  const lines = [
    '本地模型服务：运行中',
    `服务地址：${SERVE}`,
    `模型：${p.model_path || '—'}`,
    `上下文：${p.default_generation_settings?.n_ctx ?? p.n_ctx ?? '—'} tokens`,
    `并行槽：${p.total_slots ?? '—'}`,
    `多模态：${caps.length ? caps.join(' / ') : '未启用'}`,
    '',
    '提示：在「Strata Mac」控制台可以调整思考等级、KV 量化、并行槽等参数。',
  ];
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

async function toolModels() {
  // 从控制台读（它扫描多个目录）；控制台没跑就退回 llama-server
  try {
    const r = await fetch('http://127.0.0.1:8791/api/models', { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      const d = await r.json();
      if (d.models?.length) {
        const lines = d.models.map((m) => `· ${m.name}  ${m.totalGB} GB${m.mmproj ? '  （含视觉）' : ''}`);
        return { content: [{ type: 'text', text: '本机可用模型：\n' + lines.join('\n') }] };
      }
    }
  } catch {}
  const d = await httpJson('/v1/models');
  const lines = (d.data || []).map((m) => '· ' + (m.id || m.name));
  return { content: [{ type: 'text', text: '当前加载：\n' + lines.join('\n') }] };
}

/* ── JSON-RPC 分发 ──────────────────────────────────────────────── */

async function handle(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'strata-mac', version: '1.0.0' },
      },
    });
    return;
  }

  if (method === 'notifications/initialized' || method === 'initialized') return;

  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }

  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    try {
      let out;
      if (name === 'local_chat') out = await toolChat(args);
      else if (name === 'local_status') out = await toolStatus();
      else if (name === 'local_models') out = await toolModels();
      else {
        send({ jsonrpc: '2.0', id, error: { code: -32602, message: `未知工具: ${name}` } });
        return;
      }
      send({ jsonrpc: '2.0', id, result: out });
    } catch (e) {
      send({
        jsonrpc: '2.0', id,
        result: {
          content: [{ type: 'text', text: `调用失败：${e.message}` }],
          isError: true,
        },
      });
    }
    return;
  }

  if (method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return; }

  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `未实现: ${method}` } });
}

process.stderr.write(`[strata-mac-mcp] 已启动，目标服务 ${SERVE}\n`);
