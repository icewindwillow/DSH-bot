# 配置指南

[返回首页](<../README.md>) · [部署](<deployment.md>) · [隐私](<privacy.md>)

## 先选对 profile

`QQBOT_PROFILE_NAME` 默认是 `qqbot`；默认目录按该名字组成为 `$DSH_HOME/profiles/<名字>`，未设置 `DSH_HOME` 时使用 `~/.dsh`。初始化、面板、补丁和启动命令应指向**同一个名字与目录**。`QQBOT_PROFILE_DIR` 可显式指定，但启动器要求它严格等于 `DSH_HOME/profiles/QQBOT_PROFILE_NAME`，因为 DSH 本身按此规则寻找 profile；需要换数据根时设置 `DSH_HOME`，不要把目录单独指到任意位置。

如果已有旧机器人，建议用 DSH 官方方式创建一个新的独立 profile，例如 `qqbot-demo`，再在运行本仓库命令的每个终端设置：

```bash
export QQBOT_PROFILE_NAME=qqbot-demo
# 若要改变整个数据根，在创建profile前选定，后续所有终端保持一致：
# export DSH_HOME="$HOME/.dsh-bot-demo"
# QQBOT_PROFILE_DIR 一般留空自动组成，不要另指任意目录。
```

不要只改面板而忘了补丁和启动器；检查 `npm run doctor` 显示的目标。目录独立也不意味着长期记忆库独立，见[隐私说明](<privacy.md>)。

## 初始化不是覆盖安装

```bash
npm run init
npm run init -- --apply
```

前者仅预览，后者只从公开模板补齐缺失的 `qqbot-*.json` 与独立的 `dsh-bot.patch.yml`，并准备 profile 下的私有 workspace。它**不安装 DSH/插件、不修改包清单、不覆盖原始 profile patch**，也不自动合并已有文件。模板不包含真实 Key、群号、成员资料或消息。

### 独立 overlay：配置不要混着改

新部署使用 [overlay 模板](<../examples/profile/dsh-bot.patch.yml>)，复制到所选 profile 后，由 `npm run bot` 以 `dsh --profile NAME --patch <profile>/dsh-bot.patch.yml` 叠加。原来的 `cordis.patch.yml` 保持不动。

面板启动时**优先编辑此 overlay**；仅在 overlay 不存在时兼容编辑旧 `cordis.patch.yml`。请看面板打印的实际配置路径，别一边在 overlay 改模型、一边又改旧文件。新启动器要求 overlay 存在；创建 overlay 后重启面板，确保两端编辑/加载同一份配置。

机器人工作区默认是 `<profile>/workspace`，`QQBOT_WORKDIR` 可以调整到其它私有目录，但 profile 和 workspace 均不得位于本 Git 源码目录内。源代码目录不是机器人读写群资料的默认位置。

## 用网页填写凭据

```bash
npm run panel
```

请使用终端打印的 `http://127.0.0.1:7791`，不要换成局域网 IP。默认面板只监听回环地址；Host、Origin 与浏览器同站检查是安全围栏的一部分，换成 `localhost` 可能被拒绝。

凭据区支持：

| 字段 | 用途 | 是否人人必填 |
| --- | --- | --- |
| `QQBOT_APPID` | 腾讯机器人应用 ID | 使用 QQ 接入需要 |
| `QQBOT_SECRET` | 腾讯机器人应用 Secret | 使用 QQ 接入需要 |
| `OPENAI_API_KEY` | OpenAI 官方聊天/联网辅助等 | 使用对应服务时 |
| `DEEPSEEK_API_KEY` | DeepSeek 官方 API / 对应搜索读取 | 使用对应服务时 |
| `XIANGXIN_API_KEY` | 象信结构化判定 | 启用对应辅助能力时 |
| `OPENCODE_GO_API_KEY` | OpenCode Go 路由 | 使用对应路由时 |

不是把所有 Key 填满才可运行；也不要以为选了免费主模型，辅助判定就自动免费。所选功能的凭据与预算要一起检查。

### 保存、保留与删除

- 密码输入不回显旧值；接口只返回是否已配置及来源，不返回密钥值。
- **空白输入保留原值**，不是删除；删除需要显式操作。
- 保存写入所选 profile 的 `.bot-secrets.json`，文件权限 `0600`，但内容仍是**本地明文**。
- 非空的继承环境变量优先于本地文件。删掉本地值不会清除终端、launchd 或其它进程管理器注入的环境变量。
- 保存/删除后需要重启机器人。通过 `npm run bot` 才由本项目启动器加载本地文件；直接运行 `dsh` 不应假设会自动加载它。
- 面板看见的环境是面板进程的环境，机器人可能由另一个进程管理器启动。出现不一致时核对两端来源，不要打印全部环境变量来排查。

**不要将密钥写进仓库、示例、截图、终端命令历史或 Issue。** `0600` 不是加密，也不能防止同账号进程或管理员读取。

## 模型与推理强度

控制台的“模型与推理”选择默认模型，保存后按提示重启。主人也可使用 QQ 中受权限控制的 `/model`；旧会话可能保留自己的模型偏好，不能仅凭面板默认值判断当前群实际使用的路由。

推理强度有两层：

1. 默认模型选择上的 `agent-default-model.reasoningEffort`；
2. `llm-pi-ai.providers.<provider>.reasoning` 路由默认值。

不是每个模型都有同一套档位。路由默认会作用于同路由多个模型，给混合模型统一设档可能导致 `does not support reasoning effort`。不确定时留空，按面板能力提示逐个设置；不要把未证实能力标成支持。

第三方 `our-free-model` 的清单与降级链由插件维护，面板读取插件可用信息；不要手抄过期的免费模型列表。安装与条款见[免费模型指南](<free-models.md>)。

## 人格、说话人模块与低打扰

- **人格设定**：为默认或某个群组织人格模块。未单独设置的群继承默认配置，保存前确认当前编辑的是默认项还是具体群。
- **按说话人模块**：把话题、回应方式、角色技能分配给成员；当前说话人参与对话时再按条件启用。
- **群成员档案**：仅保存成员同意的信息，允许随时纠正或删除。姓名可能重名，不能当成安全身份凭据。
- **唤醒指数**：控制未被明确点名时的接话倾向；`100` 更积极，降低数值可减少打扰，`0` 偏向仅明确叫到再回应。真 @、唤醒词或特别规则可能不受该随机门控影响。
- **主人指令权限**：仅白名单可使用敏感斜杠命令；普通群友可以发话，不等于获得会话管理权限。初始主人名单为空时，先在面板配置，别在群里靠反复 `/new` 排查。
- **图库与收图**：按需启用收图和收藏，不能因为平台允许下载就默认获得成员授权。

人格、群资料等部分运行数据按下一轮重读；模型和凭据需要重启。以面板返回的“是否需要重启”提示为准。

## 可选功能与安全开关

以下是当前增强层使用的主要环境变量，不是完整 API：

| 变量 | 当前默认/行为 | 提醒 |
| --- | --- | --- |
| `QQBOT_PROFILE_NAME` | `qqbot` | DSH 使用的真实 profile 名字 |
| `DSH_HOME` | `~/.dsh` | 创建 profile 前确定，不能只移动目录不改宿主数据根 |
| `QQBOT_PROFILE_DIR` | 必须匹配 `DSH_HOME/profiles/NAME` 才能启动 | 所有命令统一目标 |
| `QQBOT_WORKDIR` | `<profile>/workspace` | 私有目录，不可位于本 Git 仓库内 |
| `QQBOT_DIARY` | `off` | 日记需主动开启 |
| `QQBOT_DIARY_PUBLISH` | 非 `on` 不发布 | 即便本地日记开启，对外发布还要显式 `on` |
| `QQBOT_DIARY_GUILD` / `QQBOT_DIARY_CHANNEL` | 无目标，不发布 | 需主动配置获授权的频道/子频道 ID |
| `QQBOT_VECTOR` | `off` | 本地向量模型及索引需另行验证 |
| `QQBOT_MEMORY_DB` | 补丁通常回退到 `~/.dsh/memory/ltm.db` | 设置后还要确认上游 LTM 使用同一文件，不是单独改此变量就完成隔离 |
| `QQBOT_MODEL_FAILOVER` | 默认关闭，仅 `on` 启用 | 跨服务商兜底会转发该轮上下文，可能收费 |
| `QQBOT_FALLBACK_PROVIDER` / `QQBOT_FALLBACK_MODEL` | 开启兜底前应显式核对 | 配好对应路由和 Key，不假设免费 |
| `QQBOT_MEMORY_WRITE` | `off` | 限制模型主动使用受保护的记忆写工具，不是关闭全部后台记忆写入 |
| `QQBOT_MEMORY_GATE` | `on`；`off` 关闭门控模块 | 自动门控仍可能写记忆；关闭模块不等于删除旧记忆 |
| `QQBOT_PERSON_CARD` | `on`；`off` 关闭人物卡任务 | 有跨群汇总路径，隐私敏感环境优先关闭并审核存量 |
| `QQBOT_PANEL_RESTART` | 默认关闭；仅 `on` 启用 | 仅显式配置的 macOS launchd |
| `QQBOT_LAUNCHD_LABEL` | 无默认代猜 | 必须匹配管理所选 profile 的真实任务 |
| `QQBOT_CONTROL_PORT` | `7792` | 回环控制口，须 token，不能对外暴露 |

跨服务商兜底是显式 opt-in：只有 `QQBOT_MODEL_FAILOVER=on` 才启用，启用前请明确设置后备 provider/model、对应路由与 Key，并接受该轮上下文外发及费用。Our Free Model 自身 combo 由插件另行管理，不受此开关代管。

“关开关”通常只停止后续行为，不擦除历史记录。日记发布目标、其它辅助模型和调度细节需按对应代码/面板核实；不要把真实 ID 粘贴到公开示例。

## 重启：安全优先于一键

默认手动停止已有机器人，然后在相同环境中运行 `npm run bot`。确认旧实例真的退出，尤其已有 launchd KeepAlive 时不要再手动拉起一份。

面板仅在 `QQBOT_PANEL_RESTART=on`、平台为 macOS、`QQBOT_LAUNCHD_LABEL` 与所选 profile 的任务相符时请求 launchd 重启。没有匹配就报错，**不会 fallback 到新建进程**。返回“已请求重启”不代表机器人已经 ready，需要看本机就绪日志。

## 搜索与网页读取的配置原则

模型感知搜索/读取需要注入、helper、工具注册及 profile 中的 provider 选择一起部署。尤其自定义 `web_fetch` 接管时应停用内置同名 fetch 工具，避免重复注册或绕回错误后端。

不要只部署某一个 helper 然后期待自动接管。完整步骤与错误排查见[开发指南](<development.md>)和[故障排查](<troubleshooting.md>)。OpenAI 搜索和读取以额外辅助请求执行，会产生相应费用；失败不会被伪装成成功读取。
