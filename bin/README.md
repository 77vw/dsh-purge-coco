# bin/ · 命令行入口

| 命令 | 作用 |
|---|---|
| `dsh-coco --recover --app <path>` | 宿主起不来时回滚到应用前 |
| `dsh-coco --status --app <path>` | 打印当前补丁状态 |
| `dsh-coco --dryrun --app <path>` | 预演：只报告会改什么，不写盘 |

桌面端崩溃后用它救场，等价于设置页的「重启守卫」。
