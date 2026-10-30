# Our Free Model：可选的免费模型接入

[返回首页](<../README.md>) · [配置](<configuration.md>) · [隐私](<privacy.md>)

## 它与本项目的关系

**Our Free Model** 是 [`dsh-our-free-model`](https://github.com/Ebony-Vinyl/dsh-our-free-model) 提供的 DSH 模型插件，常用 provider ID 为 `our-free-model`。本项目让模型选择与路由逻辑识别它，但**不复制它的源码、发布包、渠道凭据或账号状态**。安装、升级、许可和上游来源仍以该插件官方说明为准。

它不是运行 QQ 机器人的硬性前提：也可使用自己有权限的 OpenAI、DeepSeek 等模型路由。

## 先看这几个边界

- 免费渠道受上游额度、地区、限流、网络和服务条款影响，模型可以变更或下线。**本项目不承诺永久免费、无限额度、稳定速度或服务连续性。**
- 免费聊天不意味着整套增强无费用。搜索、网页读取、象信判定、人物卡或其它辅助模型可能另行计费；官方付费 API 始终按各自账号计费。
- 免费不等于私密。官方 README 披露部分 Kilo 免费池可能记录 prompt 并用于改进服务；请勿发送敏感信息。
- 本项目跨服务商兜底默认关闭，免费渠道失败不会默认转送付费后端。只有 `QQBOT_MODEL_FAILOVER=on` 才启用；管理员应显式核对 `QQBOT_FALLBACK_PROVIDER` / `QQBOT_FALLBACK_MODEL` 与对应路由 Key，接受该轮上下文外发和可能收费。
- Our Free Model 自己的 combo 降级链由插件管理，与上述开关不同；链可能向不止一家上游发送请求，使用前看清链上提供商、隐私政策和付费风险。
- 不要绕过登录/授权、地区或额度限制，不共享和转售渠道访问权。

## 已核对的官方发布

2026-10-30 核对结果：本机观察版本为 **2.7.3**，官方 [v2.7.3 Release](https://github.com/Ebony-Vinyl/dsh-our-free-model/releases/tag/v2.7.3) 公开列有：

- `dsh-our-free-model-2.7.3.tgz`；
- `plugin-2.7.3.json`；
- `SHA256SUMS`。

GitHub Releases API 在核对时给出的 tarball digest 为：

```text
sha256:9e0c215c580e76dd952205b875e1bf71b269ed24344517c85b158ba51f2202db
```

这说明发布制品存在，不代表本项目已经在每个平台完成安装、所有渠道和所有模型的真实调用验收。后续版本应重新核对官方 Release、校验信息与安装说明，不把这里的哈希套到别的文件。

## 不要安装 npm 上同名包

官方 [README 的安装节](https://github.com/Ebony-Vinyl/dsh-our-free-model#安装) 明确表示：**npm 上同名 `dsh-our-free-model` 不是该仓库的官方发布包，内容与官方不一致。** 因此本指南不提供 `npm install dsh-our-free-model` 或将同名 npm 包传给 DSH 的命令。

请从官方 Release 获取完整发布包，或使用你审核过的官方源码目录。不要从不明镜像、聊天附件或另一个“整合版”复制凭据与脚本。

## 路径 A：官方 Release 解压目录

1. 在上面的官方 Release 下载完整 `.tgz` 和校验信息，按官方说明核对完整性。
2. 解压到**本仓库外**你自己管理的目录，确认该目录包含完整插件与包元数据，而不是只拷 `index.js`。tarball 解压后的实际包根目录以内容为准。
3. 将真实绝对路径传给 DSH；以下是占位路径，必须替换：

```bash
dsh plugin --profile "$QQBOT_PROFILE_NAME" add /绝对路径/完整的-dsh-our-free-model-包目录
```

先在该终端设置 `QQBOT_PROFILE_NAME` 为正在部署的真实名字，例如 `qqbot-demo`；不要让环境变量为空。CLI 格式是 `dsh plugin --profile <name> add <pkg-or-path>`，不猜测其它子命令。

4. 重启所选 profile，检查 DSH 的 Our Free Model 设置与模型清单，再打开本项目控制台选择 provider。

官方 README 也支持在可信源码目录执行 `npm pack --ignore-scripts`，然后通过宿主管理本地 tarball 依赖。部分桌面发行版不允许符号链接/junction，必须使用真实目录或官方说明的 tarball 安装流程。**遇到宿主闸门不要用绕过检查的办法**，按你所用发行版与官方插件 README 操作。

## 路径 B：可信官方源码目录

如你熟悉 Git，可自行取得官方源码并核对目标版本，再执行官方文档的本地目录安装：

```bash
dsh plugin --profile "$QQBOT_PROFILE_NAME" add /绝对路径/dsh-our-free-model
```

不要把目录放到 DSH-bot 仓库内或提交到 Git。由包管理器拥有安装字节时，上游建议使用 `distribution: managed` 统一更新，避免插件自更新与包管理器同时写同一目录；具体字段与效果随官方版本核对。

## 装完之后

- 安装到**同一个 DSH profile**，不是只在默认 GUI profile 里安装一次。
- 插件自身负责可用性探测、模型清单、登录/授权、降级链及其状态；本项目不伪造可用性。
- 本项目控制台读取插件落盘清单和设置；菜单仍不出现时，检查 profile 依赖和插件是否激活，不手工填假的模型行。
- 不要在 `cordis.patch.yml` 中重复添加已有 bundle 注册。官方 README 警告这会触发 `duplicate loader entry id: our-free-model`。
- 如果链路失败，去插件自己的设置检查错误，尊重 429/地区/授权提示；必要时换自己获授权的付费路由，而非无限重试。
- 路由感知搜索不等于为每个免费上游实现原生搜索。其它既有路由仍可能使用 DeepSeek 搜索后端，需要独立凭据与费用。

## 出网与第三方条款

来源会演变，安装时应重新阅读官方 README 中“上游是哪些源”“免责声明”“安全与隐私”各节。请求内容会发送给所选模型的上游；插件可能有独立公告、升级、地区探测及账号授权网络活动。

本项目不把“免密”“本地设置”写成“数据永不出电脑”。模型服务、账号渠道与本地网关的边界不同，不应为了尝鲜默认开启局域网转发或把敏感群接到未知渠道。

官方源码与第三方内含组件各自保留权利；见[第三方说明](<../THIRD_PARTY_NOTICES.md>)，本项目的许可不会替它们授权。
