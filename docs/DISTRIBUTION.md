# 分发与校验（第 8 阶段）

## 生成清单

```bash
npm run manifest
```

产出：

| 文件 | 内容 |
|---|---|
| `dist/SHA256SUMS` | 每个发布文件的 `sha256  相对路径`，共 144 项 |
| `dist/manifest.json` | 版本号、文件数、总字节、聚合 sha256、生成时间 |

## 校验

```bash
shasum -a 256 -c dist/SHA256SUMS
```

全部 `OK` 才算完整。聚合哈希（`manifest.json.sha256`）用于一句话比对：

```
5c8cceb74574e2a6acb9fb01f9b95978a2a3eb9806bc8c7688aa80be7d10c29f
```

## 发布检查表

1. `node tools/test/run-all.mjs` —— 10/10
2. `node tools/test/patch-locate.test.mjs` —— 定位率 ≥ 86.0%
3. `npm run manifest` —— 重新生成清单
4. 把 `dist/` 与包一起上传
5. 在 Release 说明里贴聚合哈希

## 签名（Ed25519，纯 Node，不依赖 gpg）

```bash
node scripts/keygen.mjs     # 生成密钥（只跑一次）
npm run release             # 清单 → 签名 → 校验
```

| 东西 | 位置 |
|---|---|
| 私钥 | `~/.dsh/coco-signing-key.pem`（600，**永不入库**） |
| 公钥 | 仓库根 `PUBLIC-KEY.txt` + `dist/dsh-coco.pub`（跟着发布走） |
| 签名 | `dist/SHA256SUMS.sig`（JSON：alg/keyid/at/sha256/sig） |

当前 keyid：`ebc59d981723df4d`

**安全边界**：这把是「项目钥匙」，由本机生成、私钥只在你这台机器上。谁拿到 PEM 谁就能冒充发布者。
要给别人的机器装，让他们用 `PUBLIC-KEY.txt` 验签；要多人发布，各自生成、公钥都放进 `PUBLIC-KEY.txt`（多签）。

验证：
```bash
node scripts/verify.mjs      # 验签 + 逐个核对文件哈希
```

## 还没做的

- **自动发布流水线**：目前本地手动跑，等仓库地址确定后接 Actions。
