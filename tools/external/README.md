# external/ — 宿主外部守护工具

这些脚本**不属于 coco 插件本体**，而是从外部看护 DSH（Electron 宿主）的一组工具。
放在这里是为了让它们进版本管理 —— 它们原先散落在 `~/.dsh/tools/`，无版本、无文档。

## 为什么要在外部做

coco 只能改 `resources/app` 里的代码（Node 侧和快照的 renderer 代码）。
但下面这些事改内部代码做不到，或者代价太大：

| 需求 | 内部方案的代价 | 外部方案 |
|---|---|---|
| 操作宿主时不抢焦点 | 要改 Electron 主进程的窗口逻辑 | `open -g` 后台启动 + 记住/还原前台 |
| 宿主崩了自动拉起 | 无（宿主已经死了） | launchd 定时检查 + 拉起 |
| 重启后自动点掉崩溃框 | 要改 main.js 的崩溃检测（易白屏） | AX 找到 sheet 里的「重启」按钮点掉 |
| 会话被中断后自动继续 | 无 | CDP 读页面状态 + 往输入框打字 |

**结论：改内部代码风险高（白屏、崩溃框），外部操作不碰宿主内部，出事只影响外部脚本。**

## 脚本清单

### 启动 / 重启
- `dsh-common.sh`    公共函数：日志、路径、CDP 探测、焦点守卫
- `dsh-launch.sh`    后台启动宿主（`open -g` 不抢焦点），保证传入 `--remote-debugging-port`
- `dsh-restart.sh`   重启：杀进程 → 清崩溃日志 → 重新启动 → 点掉弹框

### 守护
- `dsh-guard.sh`     三层检查（进程 / CDP / 白屏），launchd 每 120 秒跑一次
                     带熔断：1 小时内重启 6 次就停 30 分钟
                     不碰用户手动启动的实例（没有调试端口就不管）

### CDP 操作（不抢焦点）
- `dsh-cdp.mjs`      连 CDP 的底层封装
- `dsh-eval.mjs`     在宿主页面里执行一段 JS，打印返回值
- `dsh-actions.mjs`  常用动作集（读状态、点元素、定位输入框）
- `dsh-status.sh`    一句话打印宿主状态

### 会话干预
- `dsh-say.mjs`      往会话输入框打字并回车（已验证可唤醒会话）
- `dsh-continue.mjs` 检测会话是否中断，中断则发继续
- `dsh-continue-run.sh`  continue 的启动包装
- `dsh-signal.mjs`   信号/提示注入
- `dsh-reload.mjs`   重载页面
- `dsh-dismiss.mjs`  点掉弹框
- `dsh-click.sh`     AX/坐标点击兜底

## 依赖

- `node`（用 `command -v node`，不要写死 `/usr/bin/node`，那个路径在 macOS 上不存在）
- 宿主必须带 `--remote-debugging-port=9223` 启动，否则 CDP 全不可用
- 辅助功能授权（点弹框、读 AX）
- launchd 任务：`~/Library/LaunchAgents/ai.dsh.guard.plist`

## 已知边界

1. **第一次重启必弹崩溃框** —— Electron 内存里还是旧代码，外部只能点掉它，无法阻止
2. **`open -a --args` 对已运行进程无效** —— 传调试端口必须走 `open -g -a ... --args`（冷启动）或直接执行二进制
3. **Web GUI 的 token 拿不到** —— 内存随机生成，只能走 CDP
4. **别改 `resources/app/lib/main.js`** —— 那是 Electron 主进程，改错会导致白屏

## 手动使用

```bash
# 看状态
bash ~/.dsh/tools/dsh-status.sh

# 手动重启（会自己点弹框）
bash ~/.dsh/tools/dsh-restart.sh

# 读页面状态
node ~/.dsh/tools/dsh-eval.mjs 'document.body.innerText.length'

# 往会话发一句话
node ~/.dsh/tools/dsh-say.mjs "继续"

# 临时停用守护
touch ~/.dsh/tools/.dsh-quit-intentional
# 恢复
rm ~/.dsh/tools/.dsh-quit-intentional
```
