![DSH-bot 原创鲸鱼主题横幅，非产品截图](<docs/assets/banner.svg>)

# DSH-bot · 让 QQ 机器人更像一位群友

不是换一句系统提示词，而是让机器人知道：**这是哪个群、谁在说话、什么值得记住、什么时候最好别插嘴。**

DSH-bot 是基于 **DeepSeek Harness（DSH）与上游 `@tencent-connect/dsh-qqbot`** 的 QQ 机器人增强体系。上游负责机器人宿主、QQ 接入和基础会话；本仓库提供群聊增强补丁、可视化控制台、示例配置与部署工具，**不是从零原创的 QQ 宿主，也不包含模型服务**。

## 它有什么不一样？

| 你想要的体验 | 这里的做法 |
| --- | --- |
| 同一个机器人，在不同群有不同性格 | 按群组织人格模块；针对当前说话人启用话题、风格与角色技能，不必把所有设定塞进每一轮对话 |
| 记得住事情，但不是每句话都记 | 记忆门控筛选有价值的信息；可选语义检索，用模糊描述找回旧事 |
| 对话不总像第一次见面 | 关系状态、心情和事件线索参与回应；这些是可检查的程序状态，不是机器人真的有情感 |
| 能接梗，也能安静待着 | 唤醒词、对话窗口、按群唤醒指数和静默回应共同控制打扰程度 |
| 群友发过的图，不必反复翻聊天记录 | 媒体归档、搜图、收藏和发回当前会话；启用前请先获得成员理解与同意 |
| 明确说“画一张”，才使用生图 | 可选单张生图与 QQ 回传（OpenAI 付费，或硅基流动 Kolors / Cloudflare flux 免费额度）；默认关闭，只发本次新 prompt，不附群历史，不自动重试 |
| 每条消息都送主模型，很贵 | 先用便宜的**判断模型**做门控与分类，主模型只处理真正值得回的消息，大幅节省 Token |
| 配置不想手改一大堆 JSON | 本机网页管理 API Key、模型、人格、成员模块、唤醒指数与图库 |
| 切模型，联网行为也跟着切 | 搜索/读取按实际请求路由选择后端；读不到就明确说读不到，不把搜索摘要伪装成文章原文 |

这些能力有配置和隐私边界，不是每项都默认开启。**日记与向量检索默认关闭；群 scope 也不是严格的数据安全隔离。** 特别是人物卡存在跨群汇总路径，上游记忆库默认可能由多个 profile 共享。见[隐私说明](<docs/privacy.md>)。

## API Key：打开面板，填上就好

**核心流程很简单：终端初始化一次，此后在面板填 Key、选模型、调人格。**

运行 `npm run panel`，打开终端打印的 **http://127.0.0.1:7791**，在凭据区域配置：

- **象信 API Key（判断模型，强烈建议先配）**；
- OpenAI / DeepSeek 聊天 API Key；
- QQ 机器人的 `QQBOT_APPID`、`QQBOT_SECRET`；
- 可选的 `OPENCODE_GO_API_KEY`（部分辅助功能的后备路由）。

**不需要为了填 Key 先学 YAML。** 面板不回显已保存的密码；留空表示保留，删除要显式操作，保存后需重启机器人。继承的非空环境变量优先于面板值。

> 密钥存放在所选 profile 的 `.bot-secrets.json`，使用 `0600` 权限，**是本地明文，不是加密保险箱**。同一操作系统账号、备份软件及具有相应权限的进程仍可能读取。通过 `npm run bot` 启动，才会由本项目启动器加载它。详见[配置指南](<docs/configuration.md>)。

## 为什么建议配一个「判断模型」？

群聊里大部分消息并不需要主模型逐条读完：要不要回、值不值得记、是不是在骂人，都是高频的小判断。本项目先交给一个便宜的**判断模型（system-1）**，只把真正值得处理的消息送进主模型，**Token 消耗会明显下降**。

- **象信（推荐）**：结构化判断，一次请求返回多个是非/评分，最省。在面板填 `XIANGXIN_API_KEY` 即可；内置的回复门控、记忆门控、事件与主语判断都走它。
- **Jev 这类免费模型**：Our Free Model 提供 `jev-1.13-free` 等免费聊天模型，适合承担便宜的辅助生成（日报、人物卡、事件摘要），也可以直接当主聊天模型。把对应的 `QQBOT_*_PROVIDER` / `QQBOT_*_MODEL` 指向可用路由即可。

不配判断模型也能跑：判断失败时门控会自动放行（宁可多说），但每条消息都更容易送进主模型，**更贵也更吵**。判断模型本身也可能按次计费或受额度限制，详见[配置指南](<docs/configuration.md>)。

## 免费模型，也能纳入同一套选择器

本项目对接 **Our Free Model / `our-free-model`**，对应第三方插件 [`dsh-our-free-model`](https://github.com/Ebony-Vinyl/dsh-our-free-model)。安装到同一 profile 后，可以在控制台选择其模型或插件提供的降级链；**插件源码不内置、不复制到本仓库**。

免费渠道可以不填 OpenAI Key，但 **QQ 的 AppID/Secret 仍然需要**，搜索、读取和辅助功能也有各自凭据要求。它适合先体验，但受上游网络、地区、额度和条款影响：**不承诺永久免费、无限额度或持续可用**。部分渠道可能记录提示词，敏感信息不要发送；官方付费 API 及辅助模型调用仍各自计费。

本项目的跨服务商兜底**默认关闭**，不会在免费渠道故障后默认改送付费后端。只有管理员显式 `QQBOT_MODEL_FAILOVER=on` 并审阅后备模型、路由 Key、上下文外发及费用后才启用；Our Free Model 自己的 combo 另由该插件管理。

官方 README 明确警告：**不要安装 npm 上同名的非官方包**。我们核对了官方 [v2.7.3 Release](https://github.com/Ebony-Vinyl/dsh-our-free-model/releases/tag/v2.7.3) 的发布制品，按[免费模型接入指南](<docs/free-models.md>)安装，而不是猜一条 `npm install`。

## 也能画图，但由你明确开启

可选工具 `generate_image` 使用自己的图片 Key（OpenAI，或硅基流动 Kolors / Cloudflare flux-1-schnell 这类免费或带免费额度的模型），生成单张图片并回传当前 QQ 群聊或 C2C。**默认关闭、可能收费，不自动重试**；与聊天 provider 独立，可以 DeepSeek / 免费模型聊天、OpenAI 生图。只发送本次新 prompt，不自动附带群历史或参考图。

想先零成本试玩，可在[硅基流动](https://cloud.siliconflow.cn/)创建 `SILICONFLOW_API_KEY` 并选择 `Kwai-Kolors/Kolors`（免费模型，通常带 AI 水印）。在“API 密钥 / QQ 连接”页下方配置；填 Key 不会自动启用。建议在群里明确发送 `@机器人 /生图 一只看星星的鲸鱼`。当前范围为 QQ 官方插件 0.5.2 的 group/C2C，不宣称支持频道或 dm。次数限制不是金额预算，真实 QQ/API 仍需管理员授权验收。详见[生图指南与边界](<docs/image-generation.md>)。

## 先跑起来

需要已安装、可执行的 DSH，以及腾讯 QQ 开放平台的机器人应用和所需权限。本项目不替你申请机器人账号，也不会绕过平台审核。

### 1. 克隆与安装

```bash
git clone https://github.com/icewindwillow/DSH-bot.git
cd DSH-bot
npm install
# 若尚未安装 DSH：此固定版本已核对官方 npm 发布信息
npm install -g @deepseek-ai/dsh@0.2.1-rc.3
```

已有 DSH 桌面端或其它官方发行版时，不必盲目再装一份；可按[部署指南](<docs/deployment.md>)选择明确的运行时路径。推荐使用 Node 24 LTS；本机 macOS 已在 Node 24.22.2 与 25.8.1 跑通离线回归。

### 2. 建一个新的测试 profile

脚本默认名仍为 `qqbot`。以下示例特意使用独立的 **`qqbot-demo`**，避免碰到旧机器人：

```bash
export QQBOT_PROFILE_NAME=qqbot-demo
# 先确认目标全新/空白！下面命令会替换目标 profile，不是合并。
dsh --profile "$QQBOT_PROFILE_NAME" --from-default-profile web
dsh plugin --profile "$QQBOT_PROFILE_NAME" add @tencent-connect/dsh-qqbot@0.5.2
dsh plugin --profile "$QQBOT_PROFILE_NAME" add @tr1v3r/dsh-ltm@0.3.4
```

> **已有同名 profile 就换个新名字，不要运行替换命令。** 创建命令可能随后启动宿主；生成配置后先用 `Ctrl+C` 停止，再安装插件，后续统一用 `npm run bot` 启动，避免重复实例。若已通过其它官方方式创建独立 profile，跳过 `--from-default-profile web`。完整步骤见[部署指南](<docs/deployment.md>)。

目录默认按 `DSH_HOME/profiles/QQBOT_PROFILE_NAME` 组成，未设 `DSH_HOME` 时为 `~/.dsh`。启动器要求显式 `QQBOT_PROFILE_DIR` 也匹配该位置；要换数据根请改 `DSH_HOME`，不要单独随意指向另一个目录。

### 3. 预览初始化，检查，再应用

```bash
npm run init                 # 仅预览，不写入
npm run init -- --apply      # 只补缺失 JSON 与独立 overlay
npm run doctor
npm run patch:plan          # 先看补丁是否适用于当前上游版本
npm run patch
npm run patch:check
```

初始化不会安装 DSH/插件，也不修改现有 profile 的包清单或原始 patch；它仅补缺失的虚构资料模板和 `dsh-bot.patch.yml`。启动时用 `--patch` 叠加该 overlay；面板优先编辑它，避免直接改旧配置。

补丁改的是目标 profile 中上游插件的安装产物，不是 DSH 内核。安装版本变化导致锚点不匹配时应停止，不要强行替换。启动器会再检查补丁、获取本地锁与控制 token，并在 profile 的私有 workspace 运行；**不会拿 Git 源码目录当机器人工作区**。

### 4. 用网页配置，启动机器人

```bash
npm run panel
# 在浏览器打开 http://127.0.0.1:7791，填写凭据、模型和群配置
# 另开一个终端，使用相同的 QQBOT_PROFILE_NAME / QQBOT_PROFILE_DIR：
npm run bot
```

先在获同意的测试群里用 `@机器人` 验证一轮普通聊天，再逐步开启其它能力。面板不是机器人进程；关掉面板也不等于停止机器人。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run init` / `npm run init -- --apply` | 初始化预览 / 仅写缺失 profile 模板 |
| `npm run doctor` | 检查本机环境、profile 与依赖，不代表真实 QQ/API 验收 |
| `npm run panel` | 启动仅本机可访问的可视化控制台，默认端口 7791 |
| `npm run bot` | 加载本地凭据并启动所选 profile 的 DSH |
| `npm run patch:plan` / `npm run patch` | 补丁预检 / 部署与备份 |
| `npm run patch:check` / `npm run patch:revert` | 检查补丁 / 从部署备份恢复原件 |
| `npm test` / `npm run security:check` | 回归测试 / 仓库敏感数据检查 |

面板重启功能**默认关闭**；仅可显式配置 macOS launchd，不会在失败时偷偷启动第二个实例。Linux/Windows 的进程管理不在当前承诺范围。

## 兼容性与已知边界

- 已观察的组合：DSH **0.2.1-rc.3**、QQ 插件 **0.5.2**、LTM **0.3.4**、Our Free Model **2.7.3**。这是版本基线，不是对任意未来版本的兼容保证。
- 推荐 **Node 24 LTS**。本机 macOS 的 Node 24.22.2 / 25.8.1 各通过 88/88；[首轮远端 CI](https://github.com/icewindwillow/DSH-bot/actions/runs/41073415994) 的 **Node 24/25 × Ubuntu/macOS 四组全部通过**。这仍不等于真实 QQ/API 或 Linux 守护部署验收。
- 本地 macOS Node 24.22.2 与 25.8.1 离线回归均 **88/88** 通过；干净上游包的补丁部署、检查、幂等与原件回滚已验证。范围与未验项见[验证记录](<docs/deployment.md#验证记录与未验范围>)，这不等于真实 QQ/API 验收。
- 模型调用、搜索与辅助判定可能产生费用；选免费聊天模型不代表整套增强零费用。
- 补丁采用全量预检、原件备份、逐文件提交和失败回滚；**不是跨文件单一原子事务，也不保证断电时自动恢复**。
- 不附带生产群资料、聊天历史、密钥、日志或图片；示例与测试只能使用虚构数据。
- **生图为独立可选能力，默认关闭。** 看图、图库和已有图发送不等于生图；生图需明确请求、独立费用与权限，见[专用指南](<docs/image-generation.md>)。

## 文档导航

[架构与能力边界](<docs/architecture.md>) · [配置](<docs/configuration.md>) · [部署](<docs/deployment.md>) · [免费模型](<docs/free-models.md>) · [生图](<docs/image-generation.md>) · [隐私](<docs/privacy.md>) · [开发](<docs/development.md>) · [故障排查](<docs/troubleshooting.md>)

[Git 协作流程](<docs/git-workflow.md>) · [参与贡献](<CONTRIBUTING.md>) · [安全报告](<SECURITY.md>) · [第三方说明](<THIRD_PARTY_NOTICES.md>)

## 接下来

- 保持 Node 24/25 CI 矩阵持续通过，补齐更多环境的实机验证；
- 持续减少对上游安装产物锚点的依赖，完善补丁升级检查；
- 改进权限、隐私选择和新手引导；
- 完善生图授权和费用提示，补齐管理员授权下的真实 QQ 图片回传验收。

## 授权与致谢

感谢 DSH、`@tencent-connect/dsh-qqbot`、LTM 及 Our Free Model 等上游项目。本仓库不是这些项目或腾讯、OpenAI、DeepSeek 等服务商的官方产品；名称与商标归各权利人。

本项目原创部分采用 **[MIT 许可证](<LICENSE>)**。第三方组件、模型与服务不因本项目采用 MIT 就被重新授权，始终受各自许可与条款约束，详见[第三方说明](<THIRD_PARTY_NOTICES.md>)。
