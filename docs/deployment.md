# 部署指南：先隔离测试，再接真实群

[返回首页](<../README.md>) · [配置](<configuration.md>) · [故障排查](<troubleshooting.md>)

## 1. 环境与边界

- 已安装 DSH，终端可找到 `dsh`；安装 DSH 请遵循你使用的官方发行渠道，不要执行来源不明的一键脚本。
- 版本观察基线：DSH **0.2.1-rc.3**、`@tencent-connect/dsh-qqbot` **0.5.2**、`@tr1v3r/dsh-ltm` **0.3.4**。补丁不保证兼容后续任意版本。
- 推荐 **Node 24 LTS**。本机 macOS 已使用 **Node 24.22.2 与 25.8.1** 分别通过离线回归；Node 24/25 × Ubuntu/macOS 四组远端 CI 也已通过，但不等于真实 QQ/API 或 Linux 守护部署验收。
- 需要腾讯 QQ 机器人应用、AppID/Secret、相应平台权限和测试环境。遵守腾讯及模型服务条款。
- 当前进程管理路径以 macOS 为基线；不承诺 Linux systemd、Windows 服务或各类容器守护配置已验证。

尚未取得源码或宿主时，可使用：

```bash
git clone https://github.com/icewindwillow/DSH-bot.git
cd DSH-bot
npm install
# 已安装合适的官方 DSH 发行版可跳过，不要混用多个运行时：
npm install -g @deepseek-ai/dsh@0.2.1-rc.3
```

该固定版本已通过[官方 npm 元数据](https://registry.npmjs.org/@deepseek-ai%2fdsh/0.2.1-rc.3)核对包名、版本和 `dsh` 入口；源码来源见 [DeepSeek Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness)。这里核对的是发布信息，不代表在每台机器完成全局安装实测。已有桌面版时，可用 `QQBOT_DSH_BIN` 明确指定对应可执行文件或脚本入口。

首次运行前阅读[隐私说明](<privacy.md>)，不要直接复制原有生产 profile 及真实数据进仓库。

## 2. 准备独立 profile

默认是 `qqbot`。有旧机器人时，建议选新名字，例如 `qqbot-demo`，避免误部署到旧实例。

先在当前终端选好名字，再用你所用 DSH 版本的官方创建流程建立独立 profile。若使用下面的“从默认 web profile 创建”方式，必须先核对目标目录不存在或确为空白：

```bash
export QQBOT_PROFILE_NAME=qqbot-demo
# 仅用于新的 qqbot-demo！此命令会替换目标 profile。
dsh --profile "$QQBOT_PROFILE_NAME" --from-default-profile web
```

> **不可对已有 profile 执行。** `--from-default-profile web` 不是合并操作，会替换目标 profile。已有 QQ 凭据、插件、群配置或历史时，先离线备份，再选择新名字；不要靠初始化脚本替你修复被替换的数据。

之后在所有相关终端保持相同的 `QQBOT_PROFILE_NAME` 与 `DSH_HOME`。默认数据根为 `~/.dsh`；如要使用其它私有数据根，在创建 profile **之前**设置，例如：

```bash
# 可选：在创建profile之前选定，所有后续终端使用同一值
# export DSH_HOME="$HOME/.dsh-bot-demo"
```

启动器要求 `QQBOT_PROFILE_DIR` 严格等于 `DSH_HOME/profiles/QQBOT_PROFILE_NAME`；一般留空自动组成。单独把目录指到其它位置会被拒绝，不能让 DSH 自动改寻址规则。profile 和机器人 workspace 均不可位于本 Git 源码目录内。

如果确定 `qqbot` 是本项目新建目标，也可沿用默认名，以下命令相应改为 `qqbot`。不要同时维护两个名字却共用一份机器人应用凭据启动多个实例。

## 3. 安装上游插件

宿主的插件 CLI 形式是 **`dsh plugin --profile <name> add <pkg>`**：

```bash
dsh plugin --profile qqbot-demo add @tencent-connect/dsh-qqbot@0.5.2
dsh plugin --profile qqbot-demo add @tr1v3r/dsh-ltm@0.3.4
```

本项目不会将它们冒充成原创代码。使用宿主实际插件清单和 `npm run doctor` 核对安装结果；不要把 CLI 文法猜成 `dsh plugins install`。

可选的 Our Free Model 不从同名 npm 包安装，按[专用指南](<free-models.md>)使用官方 Release 或审核后的源码目录。可选本地 tabletop 插件位于本仓库的 `plugins/tabletop/`，不是启动机器人必须项；安装前自行审核权限与依赖。

### 按需添加，而不是一次装满

| 能力 | 观察过的依赖 | 额外要求 |
| --- | --- | --- |
| 免费聊天模型 | Our Free Model 2.7.3 | 仅从官方 Release 安装；渠道、条款与可用性会变化 |
| 语音输出 | `node-edge-tts@1.2.11` | 外部语音服务；只在明确要求时发语音 |
| 语义记忆召回 | `@huggingface/transformers@4.3.2` | 显式 `QQBOT_VECTOR=on`，首次下载模型，可能安装原生组件 |
| 网络搜图 | `dsh-image-hunt@1.4.1` | 外部图片源与其条款；下载后还要真正发送才能在 QQ 显示 |
| 桌游骰子 / 塔罗工具 | 本仓库 `plugins/tabletop/` | 可选本地 bundle，不附带任何群资料 |

普通 npm 依赖也应安装在**目标 DSH profile**，而不是本仓库根目录；按宿主插件/依赖管理流程添加，检查包元数据及安装脚本。核心文本聊天不必预装整套向量/媒体工具。辅助日报、人物卡、事件生成等还有各自的 provider/model 环境变量；没有配置对应路由和额度时不要盲目开启，详见[配置指南](<configuration.md>)。

## 4. 初始化与诊断

```bash
npm run init
npm run init -- --apply
npm run doctor
```

- `init` 预览将写哪些缺失模板；没有 `--apply` 不写，也不安装 DSH、插件或依赖。
- `--apply` 只补缺失的 `qqbot-*.json` 与独立 `dsh-bot.patch.yml`，并准备私有 workspace，不修改包清单或原始 `cordis.patch.yml`。已有模板不会自动合并或覆盖。
- 启动器显式 `--patch` 叠加独立 overlay；面板优先编辑它，无 overlay 时才兼容旧配置。确认面板打印的目标路径，创建 overlay 后重新启动面板。
- `doctor` 只报告本机状态，不会替你修环境或证明 QQ 联通、模型额度有效、隐私获得同意。
- 默认路径与当前 shell 的 `QQBOT_PROFILE_DIR` 应一致，尤其面板、补丁、机器人启动终端不能指向不同地方。

## 5. 停机、预检、部署补丁

先停止该 profile 的机器人；如果是守护进程管理，要从原管理器停止，防止自动拉回旧实例。

```bash
npm run patch:plan
npm run patch
npm run patch:check
```

预检会聚合检查选定补丁及语法，不是直接开始写文件。预检失败时检查上游版本、锚点和所选依赖，不要手删断言继续跑。

应用会保存真实原件和部署清单后逐文件提交，失败尝试回滚。备份留在仓库外，不应提交 Git。它提供恢复依据，**不承诺跨文件单一原子性或断电恢复**。高级的 `--only` 不会自动补齐依赖，完整部署更适合首次安装。

## 6. 打开本机面板并配置

```bash
npm run panel
```

浏览器使用 **http://127.0.0.1:7791**。填写 QQ 凭据与所需 API Key，选择模型、人设、主人指令权限和测试群配置。密码不回显，留空保留，显式删除才清除本地项；具体行为见[配置指南](<configuration.md>)。

面板仅回环访问，Host + Origin 检查与 HttpOnly / SameSite cookie 是安全设计，不要为了远程访问改成 `0.0.0.0` 或开放端口。它不是公网管理后台。

## 7. 启动与首次验证

在设置了相同 `QQBOT_PROFILE_NAME` / `QQBOT_PROFILE_DIR` 的终端中：

```bash
npm run bot
```

启动器读取所选 profile 的 `.bot-secrets.json` 并把缺少的凭据加载到子进程环境，非空继承环境优先。它会先 `--check` 检查全部补丁，校验宿主、获取私有锁与控制 token，再以 `dsh --profile NAME --patch <profile>/dsh-bot.patch.yml` 启动，工作区默认 `<profile>/workspace`，不是 Git 源码目录。

日记、发布、向量和受保护的模型主动记忆写工具默认关闭，可由显式环境设置改变。**`QQBOT_MEMORY_WRITE=off` 不代表禁止全部记忆写入：自动门控和后台衍生任务仍须单独审阅。**

直接 `dsh` 不是等价替代：它不负责加载本项目的本地凭据、overlay、锁及预检流程。启动锁也不是全机唯一实例证明，不能阻止绕过启动器的旧机器人。

建议按顺序验证：

1. 本机日志出现机器人就绪；只在自己机器看日志，不公开上传整份。
2. 在已获同意的测试群里 @ 一次，确认普通文本回复。
3. 改测试群人格，确认下一轮语气变化；检查默认和群配置有没有混淆。
4. 调低唤醒指数，观察是否更安静；明确 @ 与随机门控是不同路径。
5. 使用虚构的内容测试记忆和媒体，确认 scope、删除方式及面板权限。
6. 选择实际模型测试搜索与网页读取；失败必须如实报告，不能看到摘要就认定读取成功。

`npm test`、`doctor`、`patch:check` 都不替代以上真实验收，也不保证某个上游模型今天仍免费可用。

## 8. 日常启动与守护

本项目不自动替你安装系统级服务。前台运行可直接停止再启动；已有 launchd KeepAlive 时，避免另开 `npm run bot` 形成重复连接。

面板的重启能力默认禁用。仅在 macOS、主动设置 `QQBOT_PANEL_RESTART=on`、配置与当前 profile 对应的 `QQBOT_LAUNCHD_LABEL` 后，才通过 `launchctl kickstart` 请求重启。找不到匹配任务就失败，**不 fallback 到直接 spawn**。是否 ready 要看就绪日志，不看按钮返回就下结论。

Linux/Windows 如需进程管理，请自行验证并在贡献中说明测试范围，不照抄 macOS 命令。

## 9. 升级与回滚

升级前：停止机器人，离线备份 profile、记忆数据库、媒体、事件与关系状态，并记录精确上游版本。数据库备份需考虑 WAL/一致性，不能只在运行中随手复制一个 SQLite 主文件。

升级后：重新 `doctor → patch:plan → patch → patch:check → npm test`，最后再真实验收。插件重装可能覆盖补丁安装产物，需要重打。跨版本锚点不匹配时应停止升级，不能忽略错误。

恢复当前部署原件可使用：

```bash
npm run patch:revert
```

这是恢复最近有效部署的备份；工具会校验状态，目标被其它流程修改时可能拒绝覆盖。不要把它当任意版本切换器，或尝试对新版本插件套用旧版本备份。更多说明见[故障排查](<troubleshooting.md>)。

## 验证记录与未验范围

2026-10-30 的验证记录（本地与远端分别列明）：

| 检查 | 已验证范围 | 不能据此推断 |
| --- | --- | --- |
| macOS 隔离离线回归 | Node 24.22.2 / 25.8.1 分别执行完整单元套件：均 88/88 通过，含本机临时目录/桩测试 | 未证明每个真实 QQ/API 场景可用 |
| 官方干净包补丁验证 | 81 个片段、7 个目标文件：部署、完整检查、幂等重打与真实原件回滚 | 不等于多版本通用兼容、断电恢复或线上发送成功 |
| 配置组合 | DSH 0.2.1-rc.3 在无凭据临时环境中 `--dump-config` 成功；QQ、模型路由、web 与 tool-web 原生配置校验通过 | 没有挂载服务或完成全树插件依赖验收；全量 schema 收集因临时环境未安装所有依赖而未通过 |
| 仓库安全检查 | 公开白名单与密钥/运行数据规则扫描通过 | 不是没有秘密、没有漏洞的证明，后续改动仍需重跑 |
| [首轮远端 CI](https://github.com/icewindwillow/DSH-bot/actions/runs/41073415994) | Node 24/25 × Ubuntu/macOS 四组全部通过测试、安全扫描与入口语法检查 | 不构成真实 QQ/API 或 Linux 守护部署验收 |

此轮未用真实群消息、真实 QQ AppID/Secret 或真实模型 Key 做端到端验收，也没有确认免费渠道的所有模型持续可用。请在自己获授权的测试环境完成第 7 节验证后再接真实群。未来测试数随新增用例变化，以当次命令输出为准。
