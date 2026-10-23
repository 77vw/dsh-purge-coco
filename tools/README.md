# tools/ · 测试与工具

| 文件 / 目录 | 作用 |
|---|---|
| `test/` | 23 项单元测试，`npm test` 跑全部 |
| `test/patch-locate.test.mjs` | 补丁定位率基线（闸门 85%） |
| `safe-apply.mjs` | 端到端演练：在假 bundle 上跑 apply / verify / revert |
| `dryrun.mjs` | 预演：只报告会改哪些文件 |
| `verify-live.mjs` | 对运行中的宿主做真机核对 |
| `eval/` | 提示词评测：探针集、判官、多种手法对照 |
| `asar-read.mjs` / `patch-audit.mjs` | 只读工具：看 asar 内容、审计补丁命中 |
