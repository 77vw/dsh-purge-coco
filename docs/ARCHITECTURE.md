# 架构（第 6 阶段拆包后）

```
lib/
├── index.js            宿主入口（组装一切，仍是 Cordis 插件本体）
├── core.js             补丁引擎（86 条补丁的运行器，最大的单文件）
├── client.js (根目录)   浏览器侧 UI 包
├── engine/             引擎与宿主适配
│   ├── host.js           宿主面适配（web / desktop）
│   ├── surface.js        面判定（web / desktop / gui / tui）
│   ├── preset-lint.js    预设契约检查
│   ├── preset-default.js 默认预设判定
│   ├── restart-guard.js  重启守卫（arm / settle / rollback）
│   ├── startup-check.js  启动自检（五项健康度）
│   ├── settle-policy.js  收尾策略
│   └── net-scope.js      网络白名单
├── inject/             注入链
│   ├── tiers.js          档位与 token 预算
│   ├── phase1-keep.js    phase-1 保留规则
│   ├── mnemon-settings.js mnemon 开关
│   └── capability-protocol.js 工具协议段
├── hooks/              钩子子系统
│   ├── index.js          事件执行器
│   ├── policy.js         策略（bypass / enforce + 白名单）
│   └── deny.js           deny 开关与反向写回
├── runtime/            运行时代理层
│   ├── index.js          安装器（默认只装 approval；另两个需显式开关）
│   ├── state.js          安装状态登记
│   └── ledger.js         迁移台账
├── ui/
│   └── tokens.js         设计令牌
├── redteam/            演练台（未动）
└── …其余为宿主补丁的辅助模块
```

## 拆分原则

1. **index.js 是唯一入口**，宿主只加载它；所有子目录都是内部实现。
2. 每个子目录只依赖更底层的目录，不反向依赖 `index.js`。
3. 搬迁只改路径，不改逻辑；每批搬完跑一次 `node tools/test/run-all.mjs`。

## 还没拆的

| 文件 | 行数 | 为什么不拆 |
|---|---|---|
| `lib/core.js` | ~8700 | 补丁数据与运行器高度耦合，拆它等于重写；风险与收益不成正比 |
| `lib/index.js` | ~2700 | 路由、状态、装配都在这里，等 core 拆完再动 |
| `client.js` | ~9500 | 前端包是手写 bundle，拆分要配构建，属于下一阶段 |

## 文本补丁的退役机制

运行时层装好后，`index.js` 会向 core 注入一个判定：

```js
core.setRuntimeRetired((id) => runtime.isCovered(id));
```

`patchStatus()` 遇到被覆盖的 id 直接标 `superseded`——UI 上显示「已被接管」，不再当作需要维护的文本补丁。
判定依据是「台账里标 runtime **且** 对应代理报告 ok」，两者缺一不可：

```
台账 runtime + 代理 ok   → superseded（已接管）
台账 runtime + 代理失败   → 照常按文本补丁处理
台账 file                → 永远按文本补丁处理
```

## 回归口径

- `node tools/test/run-all.mjs` —— 10 项测试
- `node tools/test/patch-locate.test.mjs` —— 定位率必须 ≥ 86.0%
