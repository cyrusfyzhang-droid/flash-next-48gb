/**
 * Strata UI 适配层
 *
 * Strata 的前端（public/web/）原本对接它自己的 Python 服务端，期望一组特定格式的端点。
 * 本模块把 llama-server 的数据 + macOS 系统指标组装成同样的格式，让那套 UI 直接跑在
 * llama.cpp 之上：
 *
 *   GET  /health    → { model, images, max_context }
 *   GET  /metrics   → { live, hardware, hardware_static, engine, history, requests, totals, conversation_cache }
 *   GET  /mcp       → { servers, tools }
 *   GET  /config    → { file, keys }          POST → { changed }
 *   GET  /settings  → { shared }              POST → { shared }
 *   POST /v1/chat/completions → 标准 OpenAI（llama-server 原生，无需适配）
 *
 * 系统指标的来源都在 macOS 上实测过：
 *   CPU    os.cpus() 差值
 *   RAM    vm_stat（total − free − inactive − speculative）
 *   GPU    ioreg IOAccelerator 的 PerformanceStatistics
 *   磁盘   iostat
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const PAGE_SIZE = 16384;   // macOS on Apple Silicon
const HIST_MAX = 60;       // sparkline 保留的采样点数

/* ══════════════════ 采样历史（Monitor 的 sparkline） ══════════════════ */

export const history = {
  tok_s: [], prefill_tok_s_mean: [], gpu_util: [], gpu_mem_used: [],
  gpu_temp: [], gpu_power: [], gpu_pcie_rx_mb: [], cpu: [], disk_read_mb: [],
};

function pushHist(key, v) {
  const a = history[key];
  if (!a) return;
  a.push(Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
  if (a.length > HIST_MAX) a.shift();
}

/* ══════════════════ 系统指标采样 ══════════════════ */

const sys = { cpu: null, mem: null, gpu: null, disk: null, diskWrite: null, at: 0 };

/** CPU 占用率：两次 os.cpus() 采样之间 busy/total 的比值 */
let _cpuPrev = null;
function cpuPercent() {
  const now = os.cpus();
  if (!_cpuPrev || _cpuPrev.length !== now.length) {
    _cpuPrev = now.map((c) => ({ ...c.times }));
    return null;
  }
  let idle = 0, total = 0;
  for (let i = 0; i < now.length; i++) {
    const a = _cpuPrev[i], b = now[i].times;
    const di = b.idle - a.idle;
    const dt = (b.user - a.user) + (b.nice - a.nice) + (b.sys - a.sys) + di + (b.irq - a.irq);
    idle += di; total += dt;
  }
  _cpuPrev = now.map((c) => ({ ...c.times }));
  return total > 0 ? 100 * (1 - idle / total) : null;
}

/** 内存：macOS 的可用内存 = free + inactive + speculative */
async function memInfo() {
  const total = os.totalmem();
  let used = total - os.freemem();
  try {
    const { stdout } = await run('vm_stat', [], { timeout: 3000 });
    const pages = (label) => {
      const m = stdout.match(new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':\\s+(\\d+)'));
      return m ? Number(m[1]) * PAGE_SIZE : 0;
    };
    const avail = pages('Pages free') + pages('Pages inactive') + pages('Pages speculative');
    if (avail > 0) used = Math.max(0, Math.min(total, total - avail));
  } catch { /* vm_stat 不可用时退回 os.freemem() */ }
  return { total, used };
}

/** GPU：Apple Silicon 通过 ioreg 的 IOAccelerator 读利用率和显存 */
async function gpuInfo() {
  const out = { util: null, memUsed: null, name: null, note: null };
  try {
    const { stdout } = await run('sh', ['-c',
      'ioreg -r -d 1 -c IOAccelerator 2>/dev/null | grep -m1 PerformanceStatistics'],
      { timeout: 4000 });
    const num = (k) => {
      const m = stdout.match(new RegExp('"' + k + '"\\s*=\\s*(\\d+)'));
      return m ? Number(m[1]) : null;
    };
    out.util = num('Device Utilization %');
    out.memUsed = num('In use system memory');
  } catch { /* 非 Apple Silicon，或 ioreg 被限制 */ }
  return out;
}

/** 磁盘吞吐：macOS iostat -d 的第三列是 MB/s（第二次采样为瞬时值） */
async function diskInfo() {
  try {
    const { stdout } = await run('iostat', ['-d', '-c', '2'], { timeout: 5000 });
    const lines = stdout.trim().split('\n').filter((l) => l.trim());
    const cols = lines[lines.length - 1].trim().split(/\s+/);
    if (cols.length >= 3) return { read: Number(cols[2]), write: null };
  } catch { /* iostat 不可用 */ }
  return { read: null, write: null };
}

/**
 * 后台采样器：每 1.5 秒刷新一次系统指标并写入缓存。
 * 请求路径只读缓存，绝不阻塞（iostat 一次要 1 秒）。
 */
let _sampling = false;
async function sampleSystem() {
  if (_sampling) return;
  _sampling = true;
  try {
    const [mem, gpu, disk] = await Promise.all([memInfo(), gpuInfo(), diskInfo()]);
    sys.cpu = cpuPercent();
    sys.mem = mem;
    sys.gpu = gpu;
    sys.disk = disk;
    sys.at = Date.now();
  } catch { /* 忽略采样失败 */ }
  finally { _sampling = false; }
}
sampleSystem();
const _sysTimer = setInterval(sampleSystem, 1500);
if (_sysTimer.unref) _sysTimer.unref();

/* ══════════════════ 静态硬件信息（只读一次） ══════════════════ */

async function sysctl(key) {
  try { const { stdout } = await run('sysctl', ['-n', key], { timeout: 2000 }); return stdout.trim(); }
  catch { return null; }
}

let _static = null;
export async function staticInfo() {
  if (_static) return _static;
  const [brand, phys, logical, chip] = await Promise.all([
    sysctl('machdep.cpu.brand_string'),
    sysctl('hw.physicalcpu'),
    sysctl('hw.logicalcpu'),
    sysctl('hw.model'),
  ]);
  _static = {
    cpu_name: brand || os.cpus()[0]?.model || 'Unknown',
    cores: phys ? Number(phys) : os.cpus().length,
    threads: logical ? Number(logical) : os.cpus().length,
    gpu_name: brand ? `${brand} GPU` : null,
    gpu_note: 'unified memory — no separate VRAM',
    psutil: true,
    model_id: chip,
  };
  return _static;
}

/* ══════════════════ 请求记录 ══════════════════ */

export const reqLog = {
  list: [],          // 最近的请求，新的在前
  kept: 200,
  totals: {
    requests: 0, since: Math.floor(Date.now() / 1000),
    prompt_tokens: 0, reused: 0, prompt_ms: 0,
    output_tokens: 0, decode_ms: 0,
  },
};

/**
 * 记录一次完成的请求。由 server.mjs 的代理层在响应结束时调用。
 * @param {{promptTokens:number, reused:number, outputTokens:number, promptMs:number,
 *          decodeMs:number, finish:string, tps:number, projection:boolean}} r
 */
export function recordRequest(r) {
  const t = reqLog.totals;
  t.requests += 1;
  t.prompt_tokens += r.promptTokens || 0;
  t.reused += r.reused || 0;
  t.prompt_ms += r.promptMs || 0;
  t.output_tokens += r.outputTokens || 0;
  t.decode_ms += r.decodeMs || 0;

  const entry = {
    time: Math.floor(Date.now() / 1000),
    status: 'ok',
    finish: r.finish || 'stop',
    prompt_tokens: r.promptTokens || 0,
    reused: r.reused || 0,
    output_tokens: r.outputTokens || 0,
    prompt_ms: r.promptMs || 0,
    decode_tok_s: r.tps || (r.decodeMs > 0 ? (r.outputTokens || 0) / (r.decodeMs / 1000) : 0),
    hit_rate: r.promptTokens ? Math.min(1, (r.reused || 0) / r.promptTokens) : null,
    pcie_share: null,
    duration_s: ((r.promptMs || 0) + (r.decodeMs || 0)) / 1000,
    projection: r.projection || null,
  };
  reqLog.list.unshift(entry);
  if (reqLog.list.length > reqLog.kept) reqLog.list.length = reqLog.kept;
  return entry;
}

/* ══════════════════ llama-server 数据获取 ══════════════════ */

async function llama(port, pathname, timeout = 2500) {
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`, { signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error(`llama-server ${pathname} → HTTP ${r.status}`);
  return r;
}

/** 解析 Prometheus 文本成扁平对象 */
function parseProm(text) {
  const M = {};
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const i = line.lastIndexOf(' ');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    const v = Number(line.slice(i + 1));
    if (Number.isFinite(v)) M[k] = v;
  }
  return M;
}

/* ══════════════════ 端点：/health ══════════════════ */

export async function health(port, modelLabel) {
  const out = { model: modelLabel || 'llama.cpp', images: false, max_context: 0 };
  try {
    const d = await (await llama(port, '/props')).json();
    out.max_context = d.default_generation_settings?.n_ctx || d.n_ctx || 0;
    out.images = !!(d.modalities && d.modalities.vision);
    if (d.model_alias || d.model_path) {
      out.model = path.basename(String(d.model_alias || d.model_path)).replace(/\.gguf$/i, '');
    }
  } catch { /* 服务没起来：返回默认值，前端会重试 */ }
  return out;
}

/* ══════════════════ 端点：/metrics ══════════════════ */

let _lastTotals = { promptTokens: 0, predictedTokens: 0, at: 0 };
let _lastPromptTokens = 0;
// 瞬时解码速度用槽位的 n_decoded 差值算——服务端的 tokens_predicted_total 在生成期间
// 并不实时累加（实测请求结束才一次性更新），所以拿它算差值恒为 0。
let _lastGen = { n: 0, at: 0 };

export async function metrics(port, opts = {}) {
  const st = await staticInfo();

  const out = {
    live: { state: 'idle', phase: null, prompt_read: 0, prompt_total: 0, prompt_tokens: 0,
            generated: 0, max_tokens: 0, tok_s: null, prefill_tok_s_mean: null, queued: 0 },
    hardware: {
      cpu: sys.cpu, ram_total: sys.mem?.total ?? os.totalmem(), ram_used: sys.mem?.used ?? null,
      gpu_util: sys.gpu?.util ?? null,
      gpu_mem_used: sys.gpu?.memUsed ?? null,
      gpu_mem_total: sys.mem?.total ?? os.totalmem(),   // 统一内存：显存上限就是内存上限
      gpu_temp: null, gpu_power: null, gpu_power_limit: null,
      gpu_pcie_gen: null, gpu_pcie_gen_max: null, gpu_pcie_width: null, gpu_pcie_rx_mb: null,
      disk_read_mb: sys.disk?.read ?? null, disk_write_mb: sys.disk?.write ?? null,
      gpus: [],
    },
    hardware_static: st,
    engine: { model: null, version: null, max_context: 0, kv: null, kv_resident: null,
              expert_slots: null, expert_cache_mib: null, spec: null, mtp_max: null,
              lookup: false, images: false, cvec: 0 },
    history: {},
    requests: reqLog.list.slice(0, opts.all ? reqLog.list.length : 12),
    totals: reqLog.totals,
    requests_kept: reqLog.kept,
    conversation_cache: null,
  };

  let slots = null, prom = null;
  try {
    const [sr, mr, pr] = await Promise.all([
      llama(port, '/slots'), llama(port, '/metrics'), llama(port, '/props'),
    ]);
    slots = await sr.json();
    prom = parseProm(await mr.text());
    const props = await pr.json();

    // ── engine ──
    out.engine.model = path.basename(String(props.model_alias || props.model_path || 'model'))
      .replace(/\.gguf$/i, '');
    out.engine.version = props.build_info || null;
    out.engine.max_context = props.default_generation_settings?.n_ctx || props.n_ctx || 0;
    out.engine.kv = opts.kvType ? `${opts.kvType} KV` : null;
    out.engine.images = !!(props.modalities && props.modalities.vision);
    out.engine.expert_slots = props.total_slots || null;

    // ── 累计量 ──
    const now = Date.now();
    const pTok = prom['llamacpp:prompt_tokens_total'] || 0;
    const pCached = prom['llamacpp:prompt_tokens_cached_total'] || 0;

    // ── live：从槽位状态判断 ──
    // 注意两点（都是实测出来的）：
    //  1. 生成阶段 n_prompt_tokens 会把已生成的 token 一起算进去，要减掉 n_decoded 才是原始 prompt 长度
    //     （实测 181−115=66，且 processed 24 + cached 42 = 66 吻合）
    //  2. 请求结束后 is_processing 变 false，但 n_prompt_tokens 仍残留上次的值 —— 必须用它门控
    const s = Array.isArray(slots) ? slots[0] : null;
    if (s) {
      const nt = (s.next_token || [])[0] || {};
      const decoded = s.is_processing ? (nt.n_decoded || 0) : 0;
      const pt = s.n_prompt_tokens || 0;
      const done = s.n_prompt_tokens_processed || 0;
      const cached = s.n_prompt_tokens_cache || 0;

      if (!s.is_processing) {
        out.live.state = 'idle';
      } else {
        const basePrompt = decoded > 0 ? Math.max(0, pt - decoded) : pt;
        out.live.prompt_tokens = basePrompt;
        out.live.prompt_total = basePrompt;
        out.live.prompt_read = decoded > 0 ? basePrompt : done;
        out.live.generated = decoded;
        out.live.max_tokens = nt.n_remain != null ? decoded + nt.n_remain : 0;
        out.live.cache_reused = cached;
        out.live.state = decoded > 0 ? 'generating' : 'reading';
        _lastPromptTokens = basePrompt;
      }

      // 瞬时解码速度：两次采样之间 n_decoded 的增量
      let instant = null;
      if (decoded > 0 && _lastGen.at && now > _lastGen.at && decoded >= _lastGen.n) {
        const d = decoded - _lastGen.n;
        const dt = (now - _lastGen.at) / 1000;
        if (d >= 0 && dt > 0.2) instant = d / dt;
      }
      if (decoded > 0) _lastGen = { n: decoded, at: now };
      else _lastGen = { n: 0, at: 0 };

      out.live.tok_s = out.live.state === 'generating'
        ? (instant ?? prom['llamacpp:predicted_tokens_seconds'] ?? null)
        : null;
      out.live.prefill_tok_s_mean = prom['llamacpp:prompt_tokens_seconds'] || null;
    }
    out.live.queued = prom['llamacpp:requests_deferred'] || 0;

    // ── 会话缓存（用累计的复用 token 数表达）──
    out.conversation_cache = {
      enabled: false,          // 我们没有槽位落盘/停放功能
      slots: props.total_slots || 1,
      parked: 0, budget_mib: 0, bytes: 0,
      requests: reqLog.totals.requests,
      requests_reused: reqLog.list.filter((r) => r.reused > 0).length,
      prompt_tokens: pTok + pCached,
      reused_tokens: pCached,
      last_prompt: _lastPromptTokens,
      last_reused: reqLog.list[0]?.reused ?? 0,
      parks: 0, restores: 0, evictions: 0,
      last_event: null, last_tokens: 0, last_at: null,
    };
  } catch {
    // 服务未运行：live 保持 idle，前端会显示 "Server not reachable"
  }

  // ── 采样历史 ──
  pushHist('tok_s', out.live.tok_s);
  pushHist('prefill_tok_s_mean', out.live.prefill_tok_s_mean);
  pushHist('gpu_util', out.hardware.gpu_util);
  pushHist('gpu_mem_used', out.hardware.gpu_mem_used);
  pushHist('gpu_temp', out.hardware.gpu_temp);
  pushHist('gpu_power', out.hardware.gpu_power);
  pushHist('gpu_pcie_rx_mb', out.hardware.gpu_pcie_rx_mb);
  pushHist('cpu', out.hardware.cpu);
  pushHist('disk_read_mb', out.hardware.disk_read_mb);
  out.history = { ...history };

  return out;
}

/* ══════════════════ 端点：/mcp ══════════════════ */

/**
 * 读 WorkBuddy / Claude 风格的 mcp.json，转成 Strata 前端期望的结构。
 * 只做展示（列出服务器和它们的工具名），不实际拉起进程。
 */
export function mcpList() {
  const out = { servers: [], tools: 0 };
  const candidates = [
    path.join(os.homedir(), '.workbuddy-ai', 'mcp.json'),
    path.join(os.homedir(), '.codebuddy', 'mcp.json'),
    path.join(os.homedir(), '.claude.json'),
  ];
  const file = candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  if (!file) return out;

  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return out; }
  const servers = cfg.mcpServers || cfg.servers || {};
  for (const [name, def] of Object.entries(servers)) {
    if (def && def.disabled) continue;
    out.servers.push({
      name,
      transport: def.url ? 'http' : 'stdio',
      status: 'stopped',      // 我们不代管这些进程，如实标为未启动
      tools: [],
      info: null,
      error: null,
    });
  }
  return out;
}

/* ══════════════════ 端点：/config ══════════════════ */

/**
 * Strata 用这个端点读写「模型运行配置」。我们映射到控制台的启动参数，
 * 落盘到 runconfig.json（由 serve.sh / 控制台界面读取）。
 */
const CONFIG_PATH = path.join(path.dirname(new URL(import.meta.url).pathname), 'runconfig.json');

export const CONFIG_KEYS = [
  { key: 'ctx',        kind: 'number', help: '上下文总长度（会被并行槽 -np 均分）' },
  { key: 'ngl',        kind: 'number', help: 'offload 到 GPU 的层数' },
  { key: 'np',         kind: 'number', help: '并行槽位（省内存可设 1）' },
  { key: 'kv_type',    kind: 'enum',   help: 'KV cache 量化', choices: ['f16', 'q8_0', 'q4_0'] },
  { key: 'batch',      kind: 'number', help: 'prompt 批大小 -b' },
  { key: 'fa',         kind: 'bool',   help: 'Flash Attention' },
  { key: 'lazy',       kind: 'bool',   help: 'n-gram 表按需读取（省内存）' },
  { key: 'jinja',      kind: 'bool',   help: '用模型自带的对话模板' },
  { key: 'port',       kind: 'number', help: 'llama-server 监听端口' },
];

export function readConfig() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { /* 首次运行没有文件 */ }
  return {
    file: CONFIG_PATH,
    keys: CONFIG_KEYS.map((k) => ({ ...k, value: saved[k.key] ?? null })),
  };
}

export function writeConfig(set) {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { /* 首次 */ }
  const changed = [];
  for (const [k, v] of Object.entries(set || {})) {
    if (!CONFIG_KEYS.some((c) => c.key === k)) continue;
    if (v === null || v === '') delete saved[k]; else saved[k] = v;
    changed.push(k);
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(saved, null, 2));
  return { changed, file: CONFIG_PATH };
}
