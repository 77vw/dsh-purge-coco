# 更新日志

## 1.4.0-coco.1（进行中）

### 阶段 1 · 可诊断
- 新增 `lib/engine/errors.js`：`COCO-E0xx` 错误码表 + `toWire()`，路由错误统一带码
- 新增 `lib/engine/log.js`：JSONL 落盘 `$DSH_HOME/dsh-coco/coco.log`（1MB 翻滚）+ 内存环形缓冲 + verbose 开关
- 补丁写入/回滚失败、守卫布防失败等 9 处关键 catch 已插桩
- `/dsh-coco/status` 新增 `logs` 字段（最近 20 条）

### 阶段 2 · 稳定性
- 新增 `lib/engine/nudge.js`：降级检测（空回答/软拒绝/只有替代/无结构短文）
- 在 `agent/pre-step` 检测上一轮回答，命中则本轮追加「直接交付」提醒（config `nudgeRetry`）
- 实测：25 条探针首轮 13 交付，补救后 16，救回 3 条（约 25% 转化率）

### 阶段 3 · 提示词
- 禁词表（约 50 条枚举）→ 判据 + 技术术语白名单，删 1566 字符
- 装配 token：6669 → **6304**
- 顶部加版本标记 `<!-- dsh-coco prompt v1.4.0 -->`
- A/B：精简版 84% vs 原版 80%（N=2，在噪声内），但消除了「禁 unauthorized 又用 unauthorized」的自相矛盾

### 借鉴上游 1.6.47 的四项
- **流层重试 `lib/engine/stream-retry.js`**：包 `llm/stream`，缓冲前 160 字，命中拒答特征就丢弃重跑一次（追加提醒）；只对主对话生效，内部调用不重试；第二次失败回放原输出
- **旁路层 `lib/engine/layers.js`**：86 条补丁按「拆掉哪层防线」归为 **33 层**（工作区前言 / 宿主身份句 / 审批 / 沙箱 / 围栏 / 升级阶梯 / hooks / 工具表 / 子代理 / 桌面打包 …），每层带 `title + why + ids`；`/dsh-coco/status` 输出分层状态，页面显示缺口层，启动自检多一项
- **锚点覆盖 `lib/engine/anchor-overrides.js`**：`$DSH_HOME/dsh-coco/anchor-overrides.json` 钉住本地 find/replace，引擎优先用覆盖、失败退回原规则；配 `GET/POST/DELETE /dsh-coco/anchor`
- **尾部强化 `lib/inject/boost.js`**：order 99999 的短段，长对话防漂移；lite 档不带（省预算）
- **注入探针 `lib/engine/probe.js`**：生成一次性校验码，要求模型首行回显，证明注入真到达；配套 `POST /dsh-coco/probe` 与页面按钮，一轮后自动解除

### 阶段 4 · 工程
- 新增 `tools/test/i18n.test.mjs`：zh/en 键集合必须一致（实测 363/363，锁定）

### 修复（重启后暴露的两个事故）
- **流层重试返回 Promise**：`ctx.on("llm/stream")` 必须同步返回 async iterable，写成 async 函数会报 `stream is not async iterable`。已改为同步返回生成器，`await next()` 放进生成器内部。
- **尾部强化漏进用户消息**：boost 通过 `systemPrompt.context()` 注册，被渲染进运行时上下文块，直接出现在用户消息里。已改为拼进注入正文；探针同理。
- **TDZ**：`skipSnapshot: subagent` 在 `let subagent` 之前引用，装配时必抛。改为就地调用 `isChildAgentContext()`，并新增 `assembly-path.test.mjs` 兜住。

### 测试
- 测试文件 13 → 16，全绿
- 定位率 87.2% 不变

## 1.3.0-coco.1

体系升级（八阶段），全部带回归测试。

### 新增

- **运行时代理层**（`lib/runtime/`）：包住宿主 `approval` 服务，审批一律放行，不再依赖源码文本。覆盖 `#9 #10`，装好后自动标记为「已被接管」。
  > 经核查，`#35`（升级）是 `dsh-sandbox` 的模块级函数、`#17`（文件观察）是 `ctx.on("fs/write-intent")` 事件，**都不是服务实例**，无法在运行时包装，仍留在文本层。台账已如实标注。
- **注入档位**（`lib/inject/tiers.js`）：`lite / standard / full / redteam / auto` 五档，按 `##` 标题切块装配，带 token 预算与超预算丢弃。实测 `lite` 2289 tok、`full` 6521 tok。
- **hooks 策略层**（`lib/hooks/policy.js`）：`bypass / enforce` 两档 + 逐条白名单，存 `$DSH_HOME/dsh-coco/hooks-policy.json`。
- **启动自检**（`lib/engine/startup-check.js`）：补丁 / 注入 / 运行时 / 预设 / 守卫五项，结果落盘并在页面与设置页显示横幅。
- **私钥口令加密**：`COCO_SIGN_PASSPHRASE=xxx node scripts/keygen.mjs` 生成 AES-256-CBC 保护的 PKCS#8，签名时读同一变量
- **公开仓库边界**：提示词与人设稿（`lib/default-prompt-inject*`、`lib/asset-table.js`）已 gitignore 并从发布清单排除；`table-read.js` 改为「缺失即降级」，没有密封稿插件照常运行
- **Ed25519 签名链**：`scripts/keygen.mjs` 生成密钥、`scripts/sign.mjs` 签 `SHA256SUMS`、`scripts/verify.mjs` 验签并逐个核对文件；`lib/engine/sign.js` 是原语，含 5 条单测
- **发布清单**（`scripts/manifest.mjs`）：`dist/SHA256SUMS` + `dist/manifest.json`，支持 `shasum -c` 校验。
- **签名支持**（`scripts/sign.mjs`）：优先 minisign、其次 gpg；当前机器无密钥，脚本会在缺工具时给出明确指引。
- **UI 设计令牌**（`lib/ui/tokens.js`）：两套样式共用 18 个变量。

### 改进

- **架构拆包**：17 个模块归入 `engine / inject / hooks / runtime / ui` 五个域。
- **补丁元数据**：`#21` 补上 marker，86/86 可事后验证（定位率的「不可验证」归零）。
- **回归闸门**：定位率低于 85% 或出现新的匹配失败，测试直接失败。

### 修复

- **注入档位丢段**：`splitBlocks` 把未登记的 `##` 标题归到 `other`，而 `BLOCK_ORDER` 不含该桶，导致新增段落被整段丢弃（实测丢了 5 行）。改为并入 `core`，并加断言「非空行数必须相等」。
- **插件加载失败**：拆包搬迁后 `lib/engine/host.js` 等 4 个文件的相对导入没改全（`./desktop.js` 应为 `../desktop.js`），宿主启动时 404、整个插件不激活。已修复，并新增 `plugin-load` + `imports` 两条测试专门兜这类死链。
- CLI `--recover` 因模块搬迁导致的导入失效。
- 启动自检对异步异常未捕获的问题。
- 运行时层原先把 `escalation` / `fsObservationPolicy` 当作服务名——宿主没有这两个服务，现改为默认只装 `approval`，另两条走 `enableExperimentalWrappers` 开关。

### 数据

- 测试 **11 项全绿**
- 定位率 **87.2%**（基线 86.0%，`#21` 补标记后提升）
- 发布清单 **145 文件 / 4.1 MB**
