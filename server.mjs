#!/usr/bin/env node
/**
 * Strata Mac Console — 本地控制台后端
 *
 * 管理 llama.cpp 的 llama-server 进程（跑 ISTA-DASLab 的 GSQ-RCO GGUF），
 * 代理聊天请求，读取运行日志。纯 Node 原生，无第三方依赖。
 */

import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { Transform } from 'node:stream';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as strata from './strata-api.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const HOME = process.env.HOME || '';
// llama.cpp 编译产物目录（里面需有 llama-server 可执行文件）
const LLAMA_BIN = process.env.LLAMA_BIN || path.join(HOME, 'strata-mac', 'bin');
// 模型扫描目录：优先取 MODEL_DIRS（冒号分隔的多个目录），否则用下面的通用默认值。
// 每个目录会被递归扫描，自动识别 GGUF 分片（跳过 mmproj 视觉投影器）。
const MODEL_ROOTS = (process.env.MODEL_DIRS || [
  path.join(HOME, 'strata-mac'),
  path.join(HOME, 'models'),
  path.join(HOME, '.cache', 'llama.cpp'),
  path.join(HOME, 'Documents', 'models'),
].join(':')).split(':').filter(Boolean);
const PORT = Number(process.env.CONSOLE_PORT || 8791);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

const state = {
  proc: null,
  config: null,
  servePort: 8080,
  apiKey: '',
  log: [],
  startedAt: null,
  // 思考等级：由控制台注入到每个转发请求里，绕开客户端不支持 reasoning_effort 的问题
  reasoningEffort: '',
  // 防重复采样参数。低比特量化（Q2_0 是 2.4bpw）容易陷入复读，
  // 而多数客户端不传 repeat_penalty，llama.cpp 默认 1.0 = 完全不惩罚。
  sampling: { repeatPenalty: 1.1, repeatLastN: 256, presencePenalty: 0.1 },
  // Strata UI 适配层用：「Use for other apps too」开关把采样设置共享给所有客户端
  sharedDefaults: null,
};

const MAX_LOG = 4000;

function appendLog(text) {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  for (const l of String(text).replace(/\r/g, '\n').split('\n')) {
    if (!l.trim()) continue;
    state.log.push(`[${ts}] ${l}`);
  }
  if (state.log.length > MAX_LOG) state.log.splice(0, state.log.length - MAX_LOG);
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 递归扫描多个模型根目录 */
function scanModels() {
  const found = [];
  const mmprojFiles = [];
  const seen = new Set();
  const walk = (dir, depth) => {
    if (depth > 5) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || e.name === 'bin') continue;
        walk(full, depth + 1);
        continue;
      }
      if (!e.name.endsWith('.gguf')) continue;
      // mmproj（视觉投影器）单独收集，作为可选附件
      if (/mmproj/i.test(e.name)) {
        let sz = 0;
        try { sz = fs.statSync(full).size; } catch {}
        mmprojFiles.push({ path: full, name: e.name, sizeGB: +(sz / 1e9).toFixed(2) });
        continue;
      }
      if (/-\d{5}-of-\d{5}\.gguf$/.test(e.name) && !/-00001-of-/.test(e.name)) continue;
      if (seen.has(full)) continue;
      seen.add(full);
      let size = 0;
      try { size = fs.statSync(full).size; } catch {}
      // 加上同目录其余分片，得到总体积
      let total = size;
      try {
        const dir2 = path.dirname(full);
        for (const f of fs.readdirSync(dir2)) {
          if (!f.endsWith('.gguf')) continue;
          if (/mmproj/i.test(f)) continue;
          if (f === e.name) continue;
          if (/-00001-of-/.test(e.name) && /-\d{5}-of-\d{5}\.gguf$/.test(f)) {
            total += fs.statSync(path.join(dir2, f)).size;
          }
        }
      } catch {}
      found.push({
        path: full,
        name: e.name,
        sizeGB: +(size / 1e9).toFixed(2),
        totalGB: +(total / 1e9).toFixed(2),
        dir: path.dirname(full),
      });
    }
  };
  for (const root of MODEL_ROOTS) walk(root, 0);
  // 给每个模型附上同目录的 mmproj（若有）
  for (const m of found) {
    const sib = mmprojFiles.find((x) => path.dirname(x.path) === m.dir);
    if (sib) { m.mmproj = sib.path; m.mmprojName = sib.name; }
  }
  state.mmprojFiles = mmprojFiles;
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

function probeServer(port) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/v1/models', method: 'GET', timeout: 2500 },
      (r) => { r.resume(); resolve({ up: r.statusCode === 200 || r.statusCode === 401, status: r.statusCode }); }
    );
    req.on('error', () => resolve({ up: false }));
    req.on('timeout', () => { req.destroy(); resolve({ up: false }); });
    req.end();
  });
}

function startServer(args, port, apiKey) {
  if (state.proc) return { ok: false, error: '已有一个 llama-server 在运行，请先停止' };
  state.lastArgs = args.slice();
  state.lastPort = port;
  const bin = path.join(LLAMA_BIN, 'llama-server');
  if (!fs.existsSync(bin)) return { ok: false, error: `找不到 ${bin}，请先编译 llama.cpp` };

  const finalArgs = args.slice();
  if (apiKey) finalArgs.push('--api-key', apiKey);

  const child = spawn(bin, finalArgs, { env: process.env, cwd: LLAMA_BIN });
  state.proc = child;
  state.config = finalArgs.slice();
  state.servePort = port;
  state.apiKey = apiKey || '';
  state.startedAt = Date.now();
  state.log = [];
  appendLog(`$ ${bin} ${finalArgs.map(a => /\s/.test(a) ? `"${a}"` : a).join(' ')}`);

  child.stdout.on('data', (d) => appendLog(d.toString()));
  child.stderr.on('data', (d) => appendLog(d.toString()));
  child.on('error', (e) => appendLog(`启动失败：${e.message}`));
  child.on('close', (code, signal) => {
    appendLog(`llama-server 已退出（code=${code} signal=${signal || 'none'}）`);
    state.proc = null;
  });
  return { ok: true, pid: child.pid };
}

function stopServer() {
  if (!state.proc) return { ok: false, error: '没有在管理 llama-server 进程' };
  const p = state.proc;
  state.proc = null;
  p.kill('SIGTERM');
  setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 5000);
  appendLog('已发送停止信号');
  return { ok: true };
}

/** 状态接口 /v1/status 用：模型名缓存（不必每秒都去查 /props） */
let _modelCache = { at: 0, name: null };
async function buildStatus() {
  const probe = await probeServer(state.servePort);
  let model = _modelCache.name;
  if (probe.up && Date.now() - _modelCache.at > 5000) {
    try {
      const h = await strata.health(state.servePort);
      model = h.model || model;
      _modelCache = { at: Date.now(), name: model };
    } catch { /* 拿不到就沿用缓存 */ }
  }
  return {
    model: model || 'llama.cpp',
    loaded: probe.up,
    loading: !!state.loading,
    activity: {
      in_flight: strata.reqLog.list.filter((r) => ['queued', 'loading', 'generating'].includes(r.state)).length,
    },
    auto_load: false,
  };
}

/**
 * 加载模型：交给 serve.sh（模型发现、启动参数、mmproj 都维护在它里面，
 * 与手动 `./serve.sh` 完全同一条路径）。
 */
function startLoadFlow() {
  state.loading = true;
  const rec = strata.beginLoad(null);
  appendLog('[加载] 执行 serve.sh …');
  const child = spawn('/bin/sh', [path.join(__dirname, 'serve.sh')], {
    cwd: __dirname,
    env: { ...process.env, SERVE_PORT: String(state.servePort) },
  });
  const relay = (d) => appendLog(d.toString());
  child.stdout.on('data', relay);
  child.stderr.on('data', relay);
  child.on('error', (e) => {
    state.loading = false;
    strata.finishLoadFail(rec, `serve.sh 启动失败：${e.message}`);
    appendLog(`[加载] serve.sh 启动失败：${e.message}`);
  });
  child.on('close', (code) => {
    state.loading = false;
    if (code === 0) {
      appendLog('[加载] 模型已就绪 ✓');
      strata.removeRequest(rec);      // 占位记录撤掉，避免一直算 "in flight"
    } else {
      appendLog(`[加载] 失败（exit=${code}），看 logs/serve.log`);
      strata.finishLoadFail(rec, '加载失败：详见 logs/serve.log（控制台日志同步有记录）');
    }
  });
}

/** 停 llama-server：托管进程走 state.proc，否则按监听端口找（serve.sh 启动的情况） */
function stopServerAny() {
  let killed = false;
  if (state.proc) {
    const p = state.proc;
    state.proc = null;
    p.kill('SIGTERM');
    setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 5000);
    appendLog('已发送停止信号（托管进程）');
    killed = true;
  }
  try {
    const pids = execFileSync('lsof', ['-ti', `tcp:${state.servePort}`, '-sTCP:LISTEN'], { encoding: 'utf8', timeout: 3000 })
      .trim().split('\n').filter(Boolean);
    for (const pid of pids) {
      try {
        process.kill(Number(pid), 'SIGTERM');
        killed = true;
        appendLog(`已停止 llama-server（pid ${pid}）`);
      } catch { /* 进程已退出 */ }
    }
  } catch { /* 端口上没有进程 */ }
  return killed ? { ok: true } : { ok: false, error: { message: 'llama-server 不在运行' } };
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.join(PUBLIC_DIR, rel);
  if (!target.startsWith(PUBLIC_DIR)) { sendJson(res, 403, { error: 'forbidden' }); return; }
  fs.readFile(target, (err, data) => {
    if (err) { sendJson(res, 404, { error: 'not found' }); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
}

/**
 * 把 reasoning_effort 注入到请求体里（如果调用方没自己指定）。
 * 这是为了让 Cherry Studio 这类只提供「默认/关闭/自动」三档的客户端
 * 也能获得可控的思考深度。
 */
function injectEffort(body) {
  try {
    const j = JSON.parse(body);
    let changed = false;

    // ① 思考等级（客户端没指定时才注入）
    if (state.reasoningEffort && j.reasoning_effort === undefined && j.enable_thinking === undefined) {
      j.reasoning_effort = state.reasoningEffort;
      changed = true;
    }

    // ② 防重复：低比特量化的复读倾向靠这个压住。
    //    只在客户端完全没给重复相关参数时才注入，避免覆盖用户的显式设置。
    const sp = state.sampling || {};
    const hasRepeat = j.repeat_penalty !== undefined || j.presence_penalty !== undefined
                      || j.frequency_penalty !== undefined;
    if (!hasRepeat && sp.repeatPenalty) {
      j.repeat_penalty = sp.repeatPenalty;
      if (sp.repeatLastN) j.repeat_last_n = sp.repeatLastN;
      if (sp.presencePenalty !== undefined) j.presence_penalty = sp.presencePenalty;
      changed = true;
    }

    // ③ 前缀缓存：强制开启。
    //    llama-server 的 KV 缓存**只存在内存里**，不落盘、不占 SSD；
    //    进程重启即失效，且只服务「同一槽位上的连续对话」——正好是单会话短期缓存。
    //    客户端（Cherry Studio 等）默认不带这个字段，所以由这里补上。
    if (j.cache_prompt === undefined) {
      j.cache_prompt = true;
      changed = true;
    }

    return changed ? JSON.stringify(j) : body;
  } catch {
    return body;
  }
}

/**
 * 统计嗅探器：把 llama-server 的响应原样透传，同时提取：
 *   - usage / timings（token 数、缓存命中、两阶段耗时）→ 请求表格与统计
 *   - 输出正文（content / reasoning_content）与原始响应 → 监控页的详情面板
 * 流式（SSE）逐帧累积，非流式取整个 JSON。
 */
function makeStatsSniffer(rec) {
  let buf = '';
  let usage = null, timings = null, finish = null;
  let output = '', reasoning = '', response = '', frames = 0, marked = false, streamError = null;

  const mark = () => { if (!marked) { marked = true; strata.markFirstByte(rec); } };

  const absorb = (payload) => {
    if (!payload || payload === '[DONE]') return;
    frames += 1;
    try {
      const j = JSON.parse(payload);
      // 流式请求的错误走 HTTP 200 + 流内 error 帧（llama-server 的行为），这里单独捕获
      if (j.error) { streamError = (j.error && j.error.message) || String(j.error); return; }
      if (j.usage) usage = j.usage;
      if (j.timings) timings = j.timings;
      const c0 = j.choices && j.choices[0];
      if (c0) {
        if (c0.finish_reason) finish = c0.finish_reason;
        const d = c0.delta || c0.message || {};
        if (d.content) { output += d.content; mark(); }
        if (d.reasoning_content) { reasoning += d.reasoning_content; mark(); }
      }
      // 原始响应：非流式留全文；流式太长，留个提示
      if (frames <= 2) response += payload + '\n';
      else if (frames === 3) response = '(流式响应，正文见输出面板)';
    } catch { /* 不完整的一帧，忽略 */ }
  };

  return new Transform({
    transform(chunk, _enc, cb) {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const s = line.trim();
        if (s.startsWith('data:')) absorb(s.slice(5).trim());
      }
      cb(null, chunk);
    },
    flush(cb) {
      if (!frames) absorb(buf.trim());   // 非流式：整体就是一个 JSON，没走过 data: 分支
      this.emit('stats', { usage, timings, finish, output, reasoning, response, error: streamError });
      cb();
    },
  });
}

/**
 * KV 量化类型：优先看控制台自己管理的启动参数；否则从正在跑的 llama-server
 * 进程命令行里读（用户常直接用 serve.sh 启动，不由控制台托管）。
 */
let _kvCache = { at: 0, val: null };
function kvType() {
  const args = Array.isArray(state.config) ? state.config : [];
  const i = args.indexOf('--cache-type-k');
  if (i >= 0 && args[i + 1]) return args[i + 1];
  if (Date.now() - _kvCache.at < 10000) return _kvCache.val;
  let val = null;
  try {
    const pids = execFileSync('pgrep', ['-f', 'llama-server'], { encoding: 'utf8', timeout: 2000 })
      .trim().split('\n').filter(Boolean);
    for (const pid of pids) {
      const cmd = execFileSync('ps', ['-o', 'command=', '-p', pid], { encoding: 'utf8', timeout: 2000 });
      const m = cmd.match(/--cache-type-k\s+(\S+)/);
      if (m) { val = m[1]; break; }
    }
  } catch { /* 没在跑，或拿不到进程信息 */ }
  _kvCache = { at: Date.now(), val };
  return val;
}

/** 通用转发到 llama-server（支持 /v1/* 任意路径，含流式）。rec = 请求记录（可为 null） */
function proxyAny(req, res, pathname, query, body, rec) {
  const headers = {};
  if (body !== null) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(body);
  }
  if (state.apiKey) headers['Authorization'] = 'Bearer ' + state.apiKey;
  const upstream = http.request(
    { host: '127.0.0.1', port: state.servePort, path: pathname + (query || ''), method: req.method, headers },
    (r) => {
      const code = r.statusCode || 502;
      if (code >= 400) {
        // 把上游的错误响应也记下来
        let errBuf = '';
        r.on('data', (c) => { errBuf += c; });
        r.on('end', () => {
          appendLog(`[err ${code}] ${errBuf.slice(0, 800)}`);
          strata.finishRequest(rec, { error: errBuf.slice(0, 500) || `HTTP ${code}`, httpStatus: code });
        });
      }
      res.writeHead(code, {
        'Content-Type': r.headers['content-type'] || 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      });
      if (code < 400 && pathname.includes('chat/completions')) {
        // 边转发边提取 usage / timings / 输出文本，喂给请求表格与监控页
        const sniffer = makeStatsSniffer(rec);
        sniffer.on('stats', ({ usage, timings, finish, output, reasoning, response, error }) => {
          strata.finishRequest(rec, {
            usage, timings, httpStatus: code,
            finish: finish === 'length' ? 'length' : 'stop',
            output, reasoning, response,
            error: error || undefined,   // 流内错误帧：标成 error 记录
          });
        });
        r.pipe(sniffer).pipe(res);
      } else {
        r.pipe(res);
      }
    }
  );
  upstream.on('error', (e) => {
    strata.finishRequest(rec, { error: `无法连接 llama-server：${e.message}` });
    if (!res.headersSent) sendJson(res, 502, { error: `无法连接 llama-server：${e.message}` });
    else res.end();
  });
  // 客户端中途断开（点了停止 / 网络断）：别让记录卡在 generating
  res.on('close', () => {
    if (rec && !res.writableEnded) strata.finishDisconnect(rec);
  });
  if (body !== null) upstream.write(body);
  upstream.end();
}

function proxyChat(req, res, body, port) {
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  };
  if (state.apiKey) headers['Authorization'] = 'Bearer ' + state.apiKey;
  const upstream = http.request(
    { host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers },
    (r) => {
      res.writeHead(r.statusCode || 502, {
        'Content-Type': r.headers['content-type'] || 'application/json; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
      });
      r.pipe(res);
    }
  );
  upstream.on('error', (e) => {
    if (!res.headersSent) sendJson(res, 502, { error: `无法连接 llama-server：${e.message}` });
    else res.end();
  });
  upstream.write(body);
  upstream.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const p = url.pathname;
  try {
    // ══════════════════ Strata UI 适配层 ══════════════════
    // public/web/ 那套前端原本对接 Strata 自己的 Python 服务端。下面这几个端点
    // 把 llama-server + macOS 的数据组装成它期望的格式。实现见 strata-api.mjs。
    if (p === '/health' && req.method === 'GET') {
      sendJson(res, 200, await strata.health(state.servePort));
      return;
    }
    if (p === '/metrics' && req.method === 'GET') {
      sendJson(res, 200, await strata.metrics(state.servePort, {
        all: url.searchParams.get('requests') === 'all',
        kvType: kvType(),
      }));
      return;
    }
    if (p === '/mcp' && req.method === 'GET') {
      sendJson(res, 200, strata.mcpList());
      return;
    }
    if (p === '/config' && req.method === 'GET') {
      sendJson(res, 200, strata.readConfig());
      return;
    }
    if (p === '/config' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)) || '{}');
      sendJson(res, 200, strata.writeConfig(b.set));
      return;
    }
    if (p === '/settings' && req.method === 'GET') {
      sendJson(res, 200, { shared: !!state.sharedDefaults });
      return;
    }
    if (p === '/settings' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)) || '{}');
      state.sharedDefaults = b.defaults || null;
      // 共享设置 = 控制台注入层用的默认值，这样其它客户端（Cherry / WorkBuddy）也吃得到
      if (b.defaults) {
        if (b.defaults.reasoning_effort) state.reasoningEffort = b.defaults.reasoning_effort;
      }
      sendJson(res, 200, { shared: !!state.sharedDefaults });
      return;
    }
    // ── 模型加载 / 卸载（monitor.html 的「加载模型」「卸载模型」按钮）──
    if (p === '/v1/status' && req.method === 'GET') {
      sendJson(res, 200, await buildStatus());
      return;
    }
    if (p === '/api/requests' && req.method === 'GET') {
      const id = url.searchParams.get('id');
      if (id) {
        const one = strata.requestById(id);
        if (!one) { sendJson(res, 404, { error: { message: `没有请求 ${id}` } }); return; }
        sendJson(res, 200, one);
        return;
      }
      const up = (await probeServer(state.servePort)).up;
      sendJson(res, 200, { requests: strata.reqLog.list, loaded: up, auto_load: false });
      return;
    }
    if (p === '/load' && req.method === 'POST') {
      if (state.loading) { sendJson(res, 409, { ok: false, error: { message: '模型正在加载中，请稍候…' } }); return; }
      if ((await probeServer(state.servePort)).up) { sendJson(res, 409, { ok: false, error: { message: '模型已经加载' } }); return; }
      startLoadFlow();
      sendJson(res, 200, { ok: true, note: '正在加载，就绪后即可对话' });
      return;
    }
    if (p === '/unload' && req.method === 'POST') {
      if (state.loading) { sendJson(res, 409, { ok: false, error: { message: '模型正在加载中，稍后再试' } }); return; }
      if (!(await probeServer(state.servePort)).up) { sendJson(res, 409, { ok: false, error: { message: '模型未加载' } }); return; }
      const out = stopServerAny();
      sendJson(res, out.ok ? 200 : 409, out);
      return;
    }
    // 旧控制台（模型选择 / 服务启停 / 参数调节）保留在 /console
    if (p === '/console' || p === '/console/') {
      serveStatic(req, res, '/console.html');
      return;
    }

    if (p === '/api/state' && req.method === 'GET') {
      const probe = await probeServer(state.servePort);
      sendJson(res, 200, {
        managed: !!state.proc,
        pid: state.proc ? state.proc.pid : null,
        config: state.config,
        startedAt: state.startedAt,
        servePort: state.servePort,
        reachable: probe.up,
        hasApiKey: !!state.apiKey,
        reasoningEffort: state.reasoningEffort,
        sampling: state.sampling,
        llamaBin: LLAMA_BIN,
        modelRoots: MODEL_ROOTS,
      });
      return;
    }
    if (p === '/api/models' && req.method === 'GET') {
      sendJson(res, 200, { roots: MODEL_ROOTS, models: scanModels() });
      return;
    }
    // 全局监控：聚合 llama-server 的 /slots + /metrics
    // 这是唯一能看到「任何客户端」请求进度的途径（WorkBuddy / Cherry / 浏览器都算）
    if (p === '/api/monitor' && req.method === 'GET') {
      const port = state.servePort;
      const out = { up: false, processing: false };
      try {
        const [sr, mr] = await Promise.all([
          fetch(`http://127.0.0.1:${port}/slots`, { signal: AbortSignal.timeout(2500) }),
          fetch(`http://127.0.0.1:${port}/metrics`, { signal: AbortSignal.timeout(2500) }),
        ]);
        out.up = true;
        const slots = await sr.json();
        const mtxt = await mr.text();

        // 解析 Prometheus 文本
        const M = {};
        for (const line of mtxt.split('\n')) {
          if (!line || line.startsWith('#')) continue;
          const i = line.lastIndexOf(' ');
          if (i < 0) continue;
          const k = line.slice(0, i).trim();
          const v = Number(line.slice(i + 1));
          if (Number.isFinite(v)) M[k] = v;
        }
        out.cacheMode = 'memory-only';   // KV 只驻内存，无 SSD 落盘
        out.metrics = {
          promptTokens: M['llamacpp:prompt_tokens_total'] || 0,
          cachedTokens: M['llamacpp:prompt_tokens_cached_total'] || 0,
          promptSeconds: M['llamacpp:prompt_seconds_total'] || 0,
          predictedTokens: M['llamacpp:tokens_predicted_total'] || 0,
          predictedSeconds: M['llamacpp:tokens_predicted_seconds_total'] || 0,
          promptRate: M['llamacpp:prompt_tokens_seconds'] || 0,
          decodeRate: M['llamacpp:predicted_tokens_seconds'] || 0,
          processing: M['llamacpp:requests_processing'] || 0,
          maxTokens: M['llamacpp:n_tokens_max'] || 0,
        };

        // 槽位状态（请求进行中才有意义）
        const s0 = Array.isArray(slots) ? slots[0] : null;
        if (s0) {
          out.processing = !!s0.is_processing;
          out.slot = {
            ctx: s0.n_ctx,
            promptTokens: s0.n_prompt_tokens || 0,
            processed: s0.n_prompt_tokens_processed || 0,
            cached: s0.n_prompt_tokens_cache || 0,
          };
          const nt = (s0.next_token || [])[0];
          if (nt) { out.slot.decoded = nt.n_decoded || 0; out.slot.remain = nt.n_remain || 0; }
        }
      } catch (e) {
        out.error = String(e.message || e);
      }
      sendJson(res, 200, out);
      return;
    }

    if (p === '/api/log' && req.method === 'GET') {
      const since = Number(url.searchParams.get('since') || 0);
      sendJson(res, 200, { total: state.log.length, lines: state.log.slice(since) });
      return;
    }
    if (p === '/api/apikey' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      let key = String(body.key || '').trim();
      if (body.generate || !key) key = 'sk-' + crypto.randomBytes(24).toString('hex');
      sendJson(res, 200, { key, note: '保存后需重启 llama-server 才生效' });
      return;
    }
    if (p === '/api/serve/start' && req.method === 'POST') {
      const payload = JSON.parse((await readBody(req)) || '{}');
      const args = Array.isArray(payload.args) ? payload.args.map(String) : [];
      const port = Number(payload.port || 8080);
      state.servePort = port;
      const out = startServer(args, port, String(payload.apiKey || '').trim());
      sendJson(res, out.ok ? 200 : 409, out);
      return;
    }
    if (p === '/api/serve/stop' && req.method === 'POST') {
      const out = stopServer();
      sendJson(res, out.ok ? 200 : 409, out);
      return;
    }
    // 清空 KV 缓存：llama-server 的 KV 只在内存中，重启即清空。
    // 不用 /slots?action=erase —— 那个要求 --slot-save-path，会把状态写到磁盘。
    if (p === '/api/clearcache' && req.method === 'POST') {
      if (!state.lastArgs || !state.lastArgs.length) {
        sendJson(res, 409, { ok: false, error: '没有记录到启动参数，请手动停止后再启动' });
        return;
      }
      const args = state.lastArgs.slice();
      const port = state.lastPort || state.servePort;
      const key = state.apiKey;
      appendLog('[清空缓存] 正在重启 llama-server…');
      stopServer();
      setTimeout(() => {
        const out = startServer(args, port, key);
        appendLog(out.ok ? '[清空缓存] 已重启，KV 缓存已清空' : `[清空缓存] 重启失败：${out.error}`);
      }, 2500);
      sendJson(res, 200, { ok: true, note: '正在重启，约 30–60 秒后可用' });
      return;
    }

    if (p === '/api/sampling' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)) || '{}');
      state.sampling = {
        repeatPenalty: b.repeatPenalty === undefined ? state.sampling.repeatPenalty : Number(b.repeatPenalty),
        repeatLastN: b.repeatLastN === undefined ? state.sampling.repeatLastN : Number(b.repeatLastN),
        presencePenalty: b.presencePenalty === undefined ? state.sampling.presencePenalty : Number(b.presencePenalty),
      };
      sendJson(res, 200, state.sampling);
      return;
    }

    if (p === '/api/effort' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      state.reasoningEffort = String(body.effort || '').trim();
      sendJson(res, 200, { effort: state.reasoningEffort });
      return;
    }

    // /v1/* 透传（供 Cherry Studio 等客户端直连控制台，自动注入 reasoning_effort）
    if (p.startsWith('/v1/')) {
      let body = null;
      let rec = null;
      if (req.method === 'POST' || req.method === 'PUT') {
        body = await readBody(req);
        if (p.includes('chat/completions')) {
          // 记录请求摘要，便于排查客户端兼容问题（截断避免刷屏）
          try {
            const j = JSON.parse(body);
            const keys = Object.keys(j).join(',');
            const msgs = (j.messages || []).map(m => m.role).join('>');
            const firstUser = (j.messages || []).find(m => m.role === 'user');
            const fu = firstUser ? String(typeof firstUser.content === 'string' ? firstUser.content : JSON.stringify(firstUser.content)).slice(0, 40).replace(/\n/g, ' ') : '-';
            appendLog(`[req] ${p} msgs=[${msgs}](${(j.messages||[]).length}条) model=${j.model || '-'} stream=${j.stream} tools=${(j.tools || []).length} max_tokens=${j.max_tokens ?? '-'} 首条用户消息="${fu}"`);
            // 建请求记录：主 UI 的请求表 + 独立监控页都吃这条数据
            rec = strata.beginRequest({
              path: p,
              model: j.model,
              stream: !!j.stream,
              responseFormat: (j.response_format && j.response_format.type) || 'text',
              input: body,
            });
          } catch {
            appendLog(`[req] ${p} (非 JSON，${body.length} 字节)`);
          }
          body = injectEffort(body);
        }
      }
      proxyAny(req, res, p, url.search, body, rec);
      return;
    }

    if (p === '/api/chat' && req.method === 'POST') {
      const body = injectEffort(await readBody(req));
      proxyChat(req, res, body, state.servePort);
      return;
    }
    if (req.method === 'GET') { serveStatic(req, res, p); return; }
    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    sendJson(res, 500, { error: String(e && e.message ? e.message : e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Strata Mac Console 已启动： http://127.0.0.1:${PORT}`);
  console.log(`llama.cpp： ${LLAMA_BIN}`);
  console.log(`模型目录： ${MODEL_ROOTS.join('  ')}`);
  console.log('按 Control+C 退出');
});

process.on('SIGINT', () => {
  if (state.proc) { console.log('\n正在停止 llama-server...'); state.proc.kill('SIGTERM'); }
  process.exit(0);
});
