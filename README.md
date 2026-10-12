# Qwen3.8-Flash-Next on a 48GB Mac

在 **48GB 统一内存**的 Apple Silicon 上跑 125B MoE 大模型 —— **llama.cpp + Metal** 的图形化控制台。

一个零依赖的 Node 控制台：管理 `llama-server` 进程、实时调参、代理聊天请求，
并内置了对**低比特量化模型**的几个关键适配（前缀缓存、思考等级注入、防重复采样）。

---

## 与同类项目的区别

同样在 Mac 上跑 Qwen3.8-Flash-Next，现有方案的内存门槛都更高：

| 项目 | 跑 Flash-Next 需要 | 技术路线 |
|---|---|---|
| [MTPLX](https://github.com/youssofal/MTPLX) | **96GB+** | 原生 MTP 推测解码 |
| [qwen3.8-flash-next-recipe](https://github.com/arnavprabhu/qwen3.8-flash-next-recipe) | 64GB | llama.cpp + Metal |
| [Strata-macOS](https://github.com/jinzy0623/Strata-macOS) | — | 移植 Strata UI，但**只能跑 ≤32B 小模型** |
| **本项目** | **48GB** | Q2_0 低比特量化 + `--lazy-mode` |

**差异化的核心是内存门槛**：用 2.4 bpw 的 Q2_0 量化把 66GB 模型压进 48GB，
再用 `--lazy-mode on` 把 28.8GB 的 n-gram 表留在磁盘按需读取。
实测 **34 tok/s** —— 比 64GB 那套方案（约 30 tok/s）还略快。

---

## 与 Strata 的关系

**本项目不是 [Strata](https://github.com/Niko1221/Strata) 的 fork —— 两者的引擎完全不同：**

| | Strata | 本项目 |
|---|---|---|
| 推理引擎 | 自研 C++ / CUDA | llama.cpp + Metal |
| 平台 | Windows / Linux + NVIDIA / AMD 独显 | macOS + Apple Silicon 统一内存 |
| 量化 | 自研 GSQ-RCO 打包 | 现成的 GGUF |

**但界面用的是 Strata 的前端。** `public/web/` 下的 Chat / Monitor / About 三页
（`app.js`、`app.css`、`components.css`、`tokens.css`、`sprite.svg`、`monitor.*`、`favicon.svg`）
**逐字节取自** Strata 仓库的 `serve/web/`，遵循其 MIT 许可 —— 见
[`public/web/LICENSE-strata`](public/web/LICENSE-strata)。字体 Outfit 为 SIL OFL 1.1。

原版那套前端对接的是 Strata 自己的 Python 服务端。本项目写了适配层
（`strata-api.mjs`），把 llama-server 和 macOS 的数据组装成它期望的格式，
于是同一套界面可以跑在 llama.cpp 之上。

思路上的启发也来自 Strata：与其把模型压到 4-bit 再硬塞进内存，
不如选更激进的低比特量化（2–3 bpw），让整个模型真正装得下。

引擎依赖只有 [llama.cpp](https://github.com/ggml-org/llama.cpp)（MIT）。

---

## 为什么需要它

以 Qwen3.8-Flash-Next 为例，同一台 48GB 机器上：

| 方案 | 量化 | 体积 | 速度 |
|---|---|---|---|
| 常规 4-bit | 4.0 bpw | 103.8 GB | ~11 tok/s |
| **本项目** | **Q2_0 / 2.4 bpw** | **66.4 GB** | **~34 tok/s** |

**体积小 37 GB，速度快 3 倍。** 差别不在引擎（两者都是 llama.cpp 系），
而在**量化档位**——模型小一半，能驻留内存的比例大得多，SSD 读取大幅减少。

而低比特量化有两个副作用，正是这个控制台要解决的：

1. **容易陷入复读** —— 客户端通常不传 `repeat_penalty`，llama.cpp 默认 1.0（等于不惩罚）
2. **客户端不支持思考等级** —— 很多 GUI 只有「开/关」两档，不传 `reasoning_effort`

控制台作为中间层，把这两件事补上。

---

## 特性

| 能力 | 说明 |
|---|---|
| **模型自动发现** | 递归扫描配置的目录，自动识别 GGUF 分片、跳过 mmproj |
| **图形化调参** | `-ngl` / `-c` / `-np` / KV 量化 / Flash Attention / 批处理，实时生成等价命令行 |
| **前缀缓存注入** | 强制 `cache_prompt: true`，多轮对话只 prefill 新增部分（实测提速 2–6×） |
| **思考等级注入** | 把 `reasoning_effort` 注入每个转发请求，绕开客户端限制 |
| **防重复采样** | 自动补 `repeat_penalty` / `repeat_last_n`，压住低比特量化的复读倾向 |
| **全局监控** | 聚合 llama-server 的 `/slots` + `/metrics`，**任何客户端**的请求进度都能看到 |
| **OpenAI 兼容代理** | 客户端填控制台地址即可，自动获得上述所有能力 |
| **MCP 服务器** | 把本地模型暴露成工具，供支持 MCP 的 AI 客户端调用 |
| **纯内存缓存** | 不落盘、不占 SSD；进程重启即清空，只服务当前会话 |

零第三方依赖 —— 只用 Node 内置模块。

---

## 界面

浏览器打开 <http://127.0.0.1:8791> 就是 Strata 的原生 UI（**已汉化**），三个标签页：

| 页 | 内容 |
|---|---|
| **对话** | 对话、附件、Markdown 渲染、思考链折叠；采样抽屉可调思考等级（关闭 / 低 / 中 / 高，映射 `reasoning_effort`）、temperature、top-p、top-k、seed、max tokens |
| **监控** | 实时状态（读取中 / 生成中 / 排队）、三张指标卡（速度 / GPU 核心数 / 内存总量）、上下文占用圆环、请求表格（含缓存命中率、prefill / decode 速度）、MCP 服务器列表 |
| **关于** | 模型与引擎信息、硬件信息、API 地址（可直接复制给其它客户端）、API key、模型参数 |

明暗主题可切换，设置存在浏览器本地。

**指标卡为什么只有三张**：Apple Silicon 是统一内存，显存和内存本来就是同一块；
GPU 温度、功耗、PCIe 在 macOS 上需要 `sudo powermetrics` 或根本不适用，
显示成 `–` 只是噪音。所以只保留了真正有信息量的三项。

> 上游 Strata 还有一张独立的 `web/monitor.html`（API 监控页），它依赖 Strata 自己的
> `/api/requests` 端点，本项目未实现——该页可以打开但拿不到数据。

### 数据来源

这套界面原本对接 Strata 的 Python 服务端。本项目实现了它需要的 6 个端点：

| 端点 | 数据来源 |
|---|---|
| `POST /v1/chat/completions` | llama-server 原生（代理层注入 `cache_prompt` / `reasoning_effort` / `repeat_penalty`） |
| `GET /health` | llama-server `/props` |
| `GET /metrics` | llama-server `/slots` + `/metrics` + macOS 系统指标 |
| `GET /mcp` | `~/.workbuddy-ai/mcp.json`（只列出，不代管进程） |
| `GET/POST /config` | `runconfig.json`（`serve.sh` 启动时读取） |
| `GET/POST /settings` | 控制台内存态 |

**macOS 上的硬件指标来源**（均在 Apple Silicon 上实测）：

| 指标 | 来源 | 状态 |
|---|---|---|
| GPU 利用率 / 显存 | `ioreg -c IOAccelerator` 的 `Device Utilization %` / `In use system memory` | ✅ |
| 内存 | `vm_stat`（可用 = free + inactive + speculative） | ✅ |
| CPU | `os.cpus()` 两次采样的差值 | ✅ |
| 磁盘吞吐 | `iostat` | ✅ |
| GPU 温度 / 功耗 | 需 `sudo powermetrics` | ❌ 显示 `–` |
| PCIe 带宽 | Apple Silicon 统一内存，无此概念 | ❌ 显示 `–` |

采样在后台每 1.5 秒刷新一次并缓存，请求路径零阻塞（`iostat` 单次要 1 秒）。

### 旧控制台

模型选择、服务启停、参数调节仍在 <http://127.0.0.1:8791/console>。

---

## 实测数据

**硬件**：Apple Silicon（M3 / M4 / M5 的 Max 或 Ultra）/ 48GB 统一内存起步
**模型**：Qwen3.8-Flash-Next（GSQ-RCO GGUF，Q2_0 量化，66.4 GB）

### 速度

| 测试 | 输出 tokens | 耗时 | 速率 |
|---|---|---|---|
| 短输出 | 600 | 19.1 s | 31.4 tok/s |
| 长输出 | 1500 | 43.9 s | **34.1 tok/s** |

**Prefill**（随长度递增，固定开销被摊薄）：

| 输入 tokens | 预填充速率 |
|---|---|
| 3,613 | 449 tok/s |
| 14,280 | 584 tok/s |
| 28,502 | **814 tok/s** |

### 前缀缓存

| 场景 | 缓存命中 | 耗时 | 提速 |
|---|---|---|---|
| 同前缀第 1 次（冷） | 0 | 17.3 s | — |
| 同前缀第 2 次 | 5,192 tokens | 2.7 s | **6.4×** |
| 多轮对话第 2 轮 | 2,876 tokens | 1.7 s | **5.3×** |

服务端日志证据：`selected slot by LCP similarity, f_sim_best = 0.993`、`graphs reused = 93`。

### 参数调优

四组参数（基线 / 大 batch / KV q8_0 / 16 线程）都在 30–33 tok/s，**差异在噪声内**。
最终采纳 `-b 4096 -ub 1024` + KV 量化 —— 略快且省内存。

---

## 安装

### 1. 编译 llama.cpp（含 Metal 后端）

```sh
git clone --depth 1 https://github.com/ggml-org/llama.cpp
cd llama.cpp
cmake -B build -DGGML_METAL=ON -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release -j 8 --target llama-server llama-cli
```

产物在 `build/bin/`。

> **踩过的坑**：`llama-server` 会硬依赖 Web UI 资源，而 UI 资源需要从 HuggingFace 下载。
> 网络不通时构建失败。绕过办法是给 `tools/ui/` 提供一个空的 `ui.cpp` / `ui.h` 实现
> （`llama_ui_get_assets()` 等三个符号），并改掉 `tools/ui/CMakeLists.txt` 里的资源下载步骤。
> 纯命令行使用不需要 Web UI。

### 2. 下载模型

以 Qwen3.8-Flash-Next 的 GSQ-RCO 量化为例子：

```sh
pip install -U "huggingface_hub[cli]"

hf download ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF \
  --include "Q2_0/*" --local-dir ~/models
```

| 量化 | 下载体积 | 权重分片 | 说明 |
|---|---|---|---|
| `IQ3_S` | 84.5 GB | 54.8 GB | 质量最好（≈ base） |
| `IQ3_XXS` | 76.8 GB | 47.0 GB | 质量/体积最佳平衡 |
| `IQ2_XS` | 68.9 GB | 39.2 GB | 偏代码 |
| `Q2_0` | 67.3 GB | 37.6 GB | **最快**，适合 48GB |

国内可用 ModelScope 镜像。

> 这类模型通常分两个分片：**权重分片** + **n-gram 表分片**。
> 后者可以用 `--lazy-mode on` 留在磁盘按需读取，不必常驻内存 —— 这是能在 48GB 上跑起来的关键。

### 3. 配置

```sh
git clone https://github.com/cyrusfyzhang-droid/flash-next-48gb.git
cd flash-next-48gb
cp config.local.sh.example config.local.sh
$EDITOR config.local.sh        # 填你的 LLAMA_BIN 和 MODEL_DIRS
```

`config.local.sh` 已被 `.gitignore` 排除，个人路径不会进版本库。

### 4. 启动

```sh
./serve.sh          # 只启动 llama-server（自动发现模型）
./start.sh          # 启动控制台（会一并管理 llama-server）
```

界面：<http://127.0.0.1:8791>

---

## 接入客户端

控制台暴露 OpenAI 兼容接口，并自动注入缓存 / 思考等级 / 防重复参数：

| 项 | 值 |
|---|---|
| 提供方类型 | **OpenAI** |
| API 地址 | `http://127.0.0.1:8791/v1` |
| API Key | 界面「API 访问」里生成，或留空不鉴权 |
| 模型 ID | 任意（llama-server 只加载一个模型，不校验名称） |

**务必用 `8791`（控制台）而不是 `8080`（llama-server 直连）** ——
注入逻辑都在控制台这一层，直连就享受不到缓存与采样修正。

### MCP 接入

`mcp-server.mjs` 把本地模型暴露成三个工具（`local_chat` / `local_status` / `local_models`），
供支持 MCP 的客户端调用。配置示例：

```json
{
  "mcpServers": {
    "strata-mac": {
      "command": "node",
      "args": ["/path/to/flash-next-48gb/mcp-server.mjs"],
      "env": { "SERVE_URL": "http://127.0.0.1:8080" }
    }
  }
}
```

---

## 配置项

全部通过环境变量（`env.sh` 里给默认值，`config.local.sh` 里覆盖）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `APP_HOME` | 脚本所在目录 | 项目根 |
| `LLAMA_BIN` | `$HOME/llama.cpp/build/bin` | llama.cpp 产物目录 |
| `MODEL_DIRS` | `$HOME/models:$HOME/.cache/llama.cpp` | 模型扫描目录（冒号分隔） |
| `MODEL_PATH` | 空 | 直接指定模型文件，跳过自动发现 |
| `MMPROJ_PATH` | 空 | 视觉投影器，留空则自动找同目录 `mmproj*.gguf` |
| `WEB_PORT` | 8791 | 控制台端口 |
| `SERVE_PORT` | 8080 | llama-server 端口 |
| `NODE_BIN` | 自动探测 | Node 可执行文件 |
| `MACHINE_NAME` | 空 | 覆盖界面上显示的机型名；留空则按 `sysctl` 实际读取 |

> `MACHINE_NAME` 只影响**界面显示**，不改变任何实际行为（硬件信息仍按真实硬件采样）。
> 典型用途是演示截图时不想暴露具体机型：
> ```sh
> export MACHINE_NAME="Apple M5 Max"
> ```

---

## 内存账（48GB 机型参考）

```
权重（Metal）            35.9 GB
KV cache (q4_0 @ 65536)   3.0 GB
系统 + 其他               8.0 GB
────────────────────────────────
合计                    ≈ 47 GB
```

**上下文为什么开 65536**：大型客户端（系统提示词 + 工具描述 + 对话历史）
的请求轻松超过 50K token。实测 65536 + q4_0 可处理 59,489 token 的输入。

**KV 为什么用 q4_0**：48GB 下 `65536 + q8_0` 会 OOM。内存更宽裕的机器可以换回 `q8_0` 或 `f16`。

---

## 目录结构

```
flash-next-48gb/
├── server.mjs               控制台后端（零依赖）
├── strata-api.mjs           Strata UI 适配层（把 llama-server 数据组装成界面期望的格式）
├── mcp-server.mjs           MCP 服务器
├── public/
│   ├── index.html           Strata UI 入口
│   ├── console.html         旧控制台（模型选择 / 启停 / 调参）
│   └── web/                 Strata 前端（取自上游，MIT，见 LICENSE-strata）
├── env.sh                   环境变量（通用默认值）
├── config.local.sh.example  本机配置模板
├── start.sh / stop.sh       启停控制台
├── serve.sh                 单独启停 llama-server（会读 runconfig.json）
├── run-console.sh           前台运行（调试用）
└── assets/                  图标
```

运行时产物（`logs/`、`run/`、`config.local.sh`、`runconfig.json`）均在 `.gitignore` 中。

---

## 已知限制

- **速度受内存容量约束**：模型装不下时会退化为 SSD 流式读取，速度掉一个量级。
  48GB 上跑 66GB 模型属于「刚好够用」，换更大内存收益显著。
- **低比特量化有质量损失**：Q2_0 的 5 项任务均分约为 base 的 95.6%。
  代码类任务对量化更敏感，追求质量请选 `IQ3_XXS` 以上。
- **`-np 1` 是单槽位**：省内存，但所有对话共享一个 KV 槽，前缀相同的会话之间必然复用缓存。
- **视觉需显式加载 mmproj**：启动时未带 `--mmproj` 则 `/props` 返回 `vision: false`。
- **前端状态块需要页面开着**：它是控制台页面里的可视化，不会出现在第三方客户端界面中。

---

## 许可

本项目自己的代码：MIT —— 见 [LICENSE](LICENSE)。

**前端界面（`public/web/`）取自 [Strata](https://github.com/Niko1221/Strata)，
Copyright (c) 2026 Niko1221 and the Strata contributors，同样为 MIT。**
完整许可见 [`public/web/LICENSE-strata`](public/web/LICENSE-strata)。

Outfit 字体为 SIL Open Font License 1.1（见 `public/web/fonts/OFL.txt`）。

## 致谢

- [llama.cpp](https://github.com/ggml-org/llama.cpp) —— 推理引擎与 Metal 后端
- [ISTA-DASLab](https://huggingface.co/ISTA-DASLab) —— GSQ-RCO 非均匀量化 GGUF
- [Strata](https://github.com/Niko1221/Strata) —— **前端界面取自该项目**，设计思路也受其启发
- [SC117](https://huggingface.co/SC117) —— abliterated 量化权重（可选）
