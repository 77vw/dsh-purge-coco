# scripts/ · 发布链与构建

| 脚本 | 作用 |
|---|---|
| `keygen.mjs` | 生成 Ed25519 签名密钥（私钥写 `$DSH_HOME`，不进仓库） |
| `manifest.mjs` | 生成 `dist/SHA256SUMS` 与 `manifest.json` |
| `sign.mjs` | 用私钥签清单 |
| `verify.mjs` | 验签 + 逐文件核对哈希 |
| `privacy-scan.mjs` | 发布前扫描本机痕迹（路径、用户名、密钥、邮箱） |
| `embed-default-prompt.mjs` | 把本地提示词密封进 `asset-table.js` |
| `build-client.mjs` | 客户端构建 |
| `redteam-setup.sh` / `export-engagement-report.mjs` | 演练台辅助 |

一键发布：`npm run release`（清单 → 签名 → 验签）。
