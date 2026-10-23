# lib/ · 插件主体

| 文件 / 目录 | 作用 |
|---|---|
| `core.js` | 补丁表与补丁引擎：86 条补丁的定义、定位、应用、回滚，四态状态 |
| `index.js` | 插件入口：路由注册、启动自检、注入装配、运行时安装 |
| `engine/` | 无状态的引擎件：错误码、日志、分层表、锚点覆盖、面判定、重启守卫、重试 |
| `inject/` | 注入链：档位切块与预算、尾部强化 |
| `runtime/` | 运行时代理：包住宿主的 `approval` 等服务实例 |
| `hooks/` | 自带的 hooks 子系统（宿主 0.2.1 删掉了官方实现） |
| `identity.js` | 提示词装配：把注入折进 system prompt |
| `desktop.js` | 桌面端适配：asar 解包、签名、路径 |
| `redteam/` | 红队演练台后端：目标库、目标编排、评分 |
| `update*.js` | 版本检查与更新 |

`asset-table.js`、`default-prompt-inject*` 是本地密封的出厂提示词，**不进仓库**（见根目录 `.gitignore`）。
