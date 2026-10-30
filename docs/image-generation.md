# 生图：明确请求、单张回传、默认关闭

[返回首页](<../README.md>) · [配置](<configuration.md>) · [隐私](<privacy.md>) · [排错](<troubleshooting.md#生图没有触发或没有收到图片>)

`generate_image` 用管理员选定的图片接口生成一张图片，再通过 QQ 图片接口发回**当前会话**。目前支持 OpenAI 官方接口（付费）、硅基流动 `Kwai-Kolors/Kolors`（当前免费）和 Cloudflare Workers AI `flux-1-schnell`（每日免费额度）；它与识图、网络搜图、图库和已有图片发送是不同能力。

**生图默认关闭。** 聊天模型不必切到 OpenAI：可以用 DeepSeek 或 Our Free Model 聊天，同时单独使用自己的图片 Key。费用取决于所选模型：OpenAI 按官方规则计费，硅基流动 Kolors 当前免费；免费聊天不等于免费生图，免费模型也不保证长期免费。

当前接线范围是 `@tencent-connect/dsh-qqbot` **0.5.2 的群聊（group）与 C2C**；不宣称支持 QQ 频道或 dm。

## 先用面板配置

1. 按[部署指南](<deployment.md>)建立独立测试 profile，并完整部署当前补丁。已有 profile 可先 `npm run init` 预览，再 `npm run init -- --apply` 补缺失模板；初始化不覆盖现有设置。
2. 运行 `npm run panel`，打开终端打印的本机地址，在“API 密钥 / QQ 连接”中保存图片服务的 Key：OpenAI 用 `OPENAI_API_KEY`，硅基流动用 `SILICONFLOW_API_KEY`（需先在硅基流动控制台完成实名认证再创建 Key），Cloudflare 用 `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`。不要在群消息、命令示例或截图中贴 Key。
3. 在同一页下方找到“生图”，检查模型、尺寸、质量和超时，主动勾选启用并确认费用提示。模型决定服务商与接口：选 `gpt-image-*` 走 OpenAI，选 `Kwai-Kolors/Kolors` 走硅基流动，选 `@cf/black-forest-labs/flux-1-schnell` 走 Cloudflare。**填写 Key 不会自动启用生图；空白 Key 也不会自动启用或发起请求。**
4. 新填或更换 Key 后，先停止旧机器人，再在相同 profile 环境中运行 `npm run bot`。启动器把本地凭据加载进进程环境；只改生图设置时无需重启，下一次调用动态读取。

Key 的读取顺序（按所选模型的凭据名）：进程环境 → DSH 凭据服务 → `~/.dsh/.credentials.yaml`。由 launchd 等进程管理器直接启动、不经过 `npm run bot` 的实例，可用 DSH 凭据文件中的 Key；此时面板保存的 `.bot-secrets.json` 不会被该实例加载，需在对应启动环境或 DSH 凭据里配置。
5. 在自己获授权的测试群中发送明确请求，自己承担并核对该次真实 API 费用（免费模型也请核对服务商的最新条款）。

推荐写法：

```text
@机器人 /生图 一只看星星的鲸鱼
```

“帮我画一只看星星的鲸鱼”等自然表达也会保守识别，但不是开放式意图猜测。识别不了时，重新发送明确的 `/生图 描述`，不要通过让模型绕过权限检查解决。

面板的刷新、保存和 Key 状态查询**不生成图片、不请求付费接口，也不验证账号额度或模型权限**。填了 Key 或看到保存成功，不代表真实调用已经可用。

## 想先零成本试：硅基流动免费模型

在[硅基流动控制台](https://cloud.siliconflow.cn/)创建 `SILICONFLOW_API_KEY`（需按其要求完成实名认证），在面板生图设置里把模型选为 `Kwai-Kolors/Kolors`，尺寸可选 `1024x1024` / `960x1280` / `768x1024`。它是本工具唯一的免费图片模型：

- `quality` 对它不生效，只对 OpenAI 模型有效。
- 免费模型通常带「AI 生成」水印；免费额度、限流、内容规则和是否长期免费都以上游为准，本项目不承诺永久免费。
- 它返回 1 小时有效的图片链接，工具只下载一次并校验 PNG/JPEG 后发送，不会把链接转给聊天模型。
- 与 OpenAI 的 Key 不通用：选 Kolors 时读 `SILICONFLOW_API_KEY`，选 GPT Image 时读 `OPENAI_API_KEY`。

这条路径未在本仓库做真实付费/免费调用验收；首次使用请自己确认上游条款、额度和实际效果。

## Cloudflare Workers AI：每天一万 neurons 免费额度

在 Cloudflare 控制台创建 API Token（权限至少 `Workers AI: Read`），并复制账号 ID（32 位十六进制，控制台右侧栏或 Workers 概览页可见）。面板里把模型选为 `@cf/black-forest-labs/flux-1-schnell`：

- 接口是账号作用域的 `POST https://api.cloudflare.com/client/v4/accounts/<账号ID>/ai/run/@cf/black-forest-labs/flux-1-schnell`，账号 ID 只接受 32 位十六进制，格式不对直接拒绝，不发请求。
- 请求体只有 `prompt` 和 `steps`（固定 4）；**prompt 上限 2048 字**，超长会返回 `prompt_too_long` 且不发起请求、不消耗尝试次数。
- 模型**固定输出 1024×1024**（模型卡没有宽高参数），所以尺寸只开放方形；返回的是 JSON 里的 base64 **JPEG**，不是下载链接。
- 免费额度按 neurons 计（每天 10,000），1024×1024 / 4 步大约每张 57.6 neurons，折合每天约 170 张。免费计划超出后请求直接失败，不会自动扣费；付费计划则按量计费。
- 质量上限明显低于 OpenAI，适合群聊玩梗；中文文字渲染不如 Qwen-Image。

## 独立配置与精确默认值

设置保存在所选 profile 根目录的 `qqbot-image-generation.json`，不写进聊天模型的 YAML。公开[默认模板](<../examples/profile/qqbot-image-generation.json>)为：

```json
{
  "enabled": false,
  "model": "gpt-image-2",
  "size": "1024x1024",
  "quality": "low",
  "timeoutSeconds": 180
}
```

| 字段 | 允许值 / 范围 | 作用 |
| --- | --- | --- |
| `enabled` | 严格布尔值，默认 `false` | 必须显式启用；不是字符串 `"true"` |
| `model` | `gpt-image-2`、`gpt-image-2.5-flare`、`gpt-image-2.5-sunburst`、`gpt-image-1.5`、`gpt-image-1-mini`、`Kwai-Kolors/Kolors`、`@cf/black-forest-labs/flux-1-schnell` | 白名单，不接受任意模型名；默认 `gpt-image-2`。模型同时决定服务商、接口地址与凭据 |
| `size` | OpenAI：`1024x1024`、`1536x1024`、`1024x1536`；Kolors：`1024x1024`、`960x1280`、`768x1024`；Cloudflare：`1024x1024` | 默认方形；这是工具的保守限制，不是服务商 API 的最大能力声明 |
| `quality` | `low`、`medium`、`high` | 默认 `low`；仅对 OpenAI 生效，其余模型忽略该项 |
| `timeoutSeconds` | 整数 `30..300` | API 请求及响应体读取超时，默认 `180` 秒 |

字段必须**完整且恰好是这五项**；缺字段、未知字段、字符串数字、非法枚举都会被拒绝。配置文件上限 16 KiB；面板使用原子替换、`0600` 文件权限写入，并拒绝祖先/目标符号链接及目标硬链接。缺文件按关闭状态的默认值处理；损坏文件不是隐式启用的理由。

`gpt-image-1` 已下线，本工具不接受它，也不支持 DALL·E。模型白名单不保证你的账号拥有全部模型权限、余额或免费额度；调用时仍受对应服务商规则约束。免费模型可能限流或调整价格，本工具不承诺长期免费。

### 紧急禁止

在机器人的启动环境设置：

```bash
export QQBOT_IMAGE_GENERATION=off
```

环境变量需要由实际启动进程继承；更改终端环境后，已运行的旧进程不会自动更新。这个开关可以额外禁止生图，但设置为 `on` **不能越过 JSON 中的 `enabled:false`**。面板里关闭设置会在下一次调用读取时生效，不应把它当作对已提交发送的撤回按钮。

## 谁能生图：主人 / 生图技能 / 好感度

除了“这条消息是明确请求”，发送者还必须满足三种权限之一，否则请求在入站阶段就被拒掉：不产生授权、不计入限流次数、不调用图片接口。

| 放行方式 | 数据来源 | 说明 |
| --- | --- | --- |
| 主人 | `qqbot-command-owners.json` 的 `openids` / `names` | 和 `/new`、`/compact` 共用同一份名单；`names` 会去 `qqbot-people.json` 里查 |
| 生图技能 | `qqbot-role-skills.json` 里 `id` 等于 `imagePermission.skill`（缺省 `image-gen`）的那个技能 | 只认这个技能的 `audiences`；别的技能写了什么权限字段都不算 |
| 好感度 | `qqbot-people.json` 的 `social.affinity` | 达到 `imagePermission.affinityMin`（缺省 60）即放行 |

**生图是一个独立的技能**，和「强者语」这类语言风格技能互不影响：风格技能的受众不会因此获得画图权限，生图技能也不会注入任何提示词。它没有 `SKILL.md`，只是靠 `audiences` 决定谁能用。

```json
{
  "imagePermission": { "affinityMin": 60, "skill": "image-gen" },
  "skills": [
    {
      "id": "image-gen",
      "name": "生图",
      "kind": "capability",
      "enabled": true,
      "audiences": [{ "person": "叶兰舟", "openids": ["…"], "groups": [], "default": true }]
    }
  ]
}
```

- 面板「角色模块 → 允许他让机器人画图」就是这个技能的受众：勾上写入、取消移除；技能不存在时会自动创建一个纯权限技能（没有 `SKILL.md`，不注入提示词）。
- `kind: "capability"` 只用于面板把能力型技能从「语言风格」下拉里排除，权限判定不依赖它。
- 三个文件都是**每次调用现读**，改完不用重启机器人。
- 档案里查不到这个人（没有 openid 记录）时好感度视为不通过，不会默认给 50。
- 被拒时工具返回 `forbidden`，并说明缺的是哪一条；提示词里明确要求模型不要重试、不要换说法绕过。

## 有权限的人直接说话就行，不用打 /生图

授权只和**人**有关，和句式无关：主人、生图技能受众、好感度达标的人，每轮消息都会拿到一次授权，**由模型自己判断这轮是不是真的要画图**。`/生图 描述` 仍然可用，但不再是必要条件。

- 没权限的人说什么都不行（`forbidden`），也不会产生任何请求。
- 授权仍然绑定「真实原始事件 + 本轮 + 当前会话」：伪造/合并/历史的原始事件一律拒绝，轮次结束即撤销。
- 一轮只能画一张；模型重复调用会拿到 `not_authorized`。
- 代价：模型如果误判（把“这张图真好看”当成要画图），会真的画一张。只有授权成员有这个风险，且限流仍然生效。

## 什么消息才授权一次生成

不是“模型想调用工具”就能付费。入站钩子只使用 QQ 收到的**真实当前事件 `msg.raw.content`**，必须核对 `raw.id` 与规范化消息 ID 一致，且原始作者、群标识与当前 scope 匹配，再识别受支持的明确画图语法，避免合并队列串入另一个人的文字：

- 不从历史消息、引用、合并后的 `msg.content` 或语音转写（ASR）推断授权。
- 规则识别出的引用、否认/拒绝画图、询问功能或配置会被拦截，不从这些内容代推许可；自然语句采用保守正则，不能承诺完整理解所有否定、引述和歧义。
- 授权绑定当前 `stableUserMessageId`、根执行 agent 会话、group/C2C 类型及该消息 ID；本轮结束或相应会话事件会撤销。
- 不允许后台任务、缺少执行 agent、复用旧轮授权或把当前群请求拿到另一群调用。

发送前还要复核捕获的原始消息 ID、当前会话记录与授权仍然一致；若轮次/会话已变，即使生成完成也不投递，此时仍可能已经产生费用。回传使用原始 bot 与原消息 ID，不借媒体 sender 自动换消息 ID 或主动推送。

因此不支持靠“照上次的要求再做”“引用之前那条”来自动付费；请在当前消息里重新写完整、明确的请求。**群聊仍需按现有门控明确 @，推荐 `/生图 描述`。** 守卫是保守的程序限制，不是对任意自然语言都能正确判意的承诺。

## 发送给图片服务的内容

请求地址由所选模型唯一决定，没有可配置的 endpoint：

- OpenAI：`POST https://api.openai.com/v1/images/generations`，`n:1`、`output_format:png`，只接受响应中的 `b64_json`。
- 硅基流动：`POST https://api.siliconflow.cn/v1/images/generations`，发送 `model`、`prompt`、`image_size`；响应返回 1 小时有效的图片 URL，工具只下载该 URL 一次，且必须为 https、非内网地址、不超过 8 MiB，再按 PNG/JPEG 魔数校验。
- Cloudflare：`POST https://api.cloudflare.com/client/v4/accounts/<账号ID>/ai/run/@cf/black-forest-labs/flux-1-schnell`，只发送 `prompt` 与 `steps:4`；响应是 `result.image` 里的 base64 JPEG，不走 URL 下载。
- **Cloudflare 的 prompt 会先被聊天模型改写。** `flux-1-schnell` 基本只认英文，直接喂中文会画出不相干的东西（实测「星空鲸鱼」出雪地月亮）。所以发送前会先调一次聊天模型（默认 `opencode-go` / `deepseek-v4.1-flash`，可用 `QQBOT_IMAGE_PROMPT_PROVIDER` / `QQBOT_IMAGE_PROMPT_MODEL` 覆盖）：理解用户的中文意图、补全主体/风格/构图/光线/画幅，输出一条英文提示词，再发给 Cloudflare。改写失败时退回原文并在回执里注明，不会因此扣两次钱。
- 工具 prompt 为 `1..4000` 字且不超过 16 KiB，只发送本次新 prompt 及模型/尺寸/质量等必要参数。
- 不自动附带群历史、参考图片、人设、记忆或聊天附件；**prompt 自己若含隐私，它仍会发给对应服务商**。
- 不接受自定义 URL，不经过自定义聊天网关；没有参考图、编辑、批量生成、付费后端回退或生图自动重试。
- 免费模型默认带「AI 生成」水印（服务商默认行为，本工具不关闭），这也符合生成式 AI 内容标识的要求。

聊天服务商与图片服务商可以不同。主聊天模型仍可能按原有会话流程看到消息；“生图不附历史”不是对整条聊天链路无上下文外发的保证。

## 没有频率限制，只有单张与在途保护

冷却、每会话每小时上限、全进程每小时上限都已移除——**谁能发图由权限名单决定**，不再叠加额度。剩下的只有两个技术约束：

- 一次明确请求只画一张；同一轮的第二次调用拿不到授权。
- 同一时刻最多一张在途；并发生成会直接返回 `busy`，不排队、不自动重试。

失败、取消或结果不确定的 API 尝试不会重试，也不补单：客户端没收到图不代表没产生费用。要控制支出请从权限名单、模型选择和账号额度入手，这里不再提供金额或次数封顶。

## 临时图片、校验与清理

生成结果只落在所选 profile 的私有 `generated-images/request-*` 路径，目录 `0700`、文件 `0600`。模块不把图片加入图库，不另存 prompt；发送完成或失败后，在 `finally` 中立即尽力删除临时文件。

输入限制为**解码后图片最多 8 MiB、响应最多 12 MiB**。校验涵盖 base64（OpenAI）、PNG/JPEG 魔数与尺寸、PNG 的 IEND / JPEG 的 EOI 与大小；这不是完整图像解码、完整格式安全审计或内容安全审核。OpenAI 要求返回尺寸与请求完全一致；硅基流动只要求长边不超过 4096、宽高比与请求相差不超过 5%。

崩溃、强制终止、权限错误或磁盘问题仍可能留下残留文件，需由管理员在确认没有在途发送后检查清理。不要把 `generated-images`、日志或任何临时图片提交 Git。清理本机副本不意味着 QQ、OpenAI、聊天服务商或成员客户端的副本也被删除。

只有 QQ 返回**非空 `message.id` 且没有失败字段**才认定回传成功。生成成功但 QQ 发送失败时，不得说“图片已经发出”；错误或结果不确定时也不自动重试。

## 验收边界与官方参考

相关测试使用离线 mock；不能据此声称已验证真实 QQ 回传、付费 API、全部模型权限或任何免费额度。真实调用必须由管理员在有授权、有预算的测试环境中自行验收。

- [OpenAI 官方图片生成指南](https://developers.openai.com/api/docs/guides/image-generation)
- [OpenAI 官方 Images Generate API 参考](https://developers.openai.com/api/reference/resources/images/methods/generate)
- [硅基流动创建图片生成请求](https://docs.siliconflow.cn/docs/api/images-generations-post)
- [Cloudflare flux-1-schnell 模型卡](https://developers.cloudflare.com/ai/models/%40cf/black-forest-labs/flux-1-schnell/)

官方能力、价格、条款与可用模型会变化。本工具只开放上述受限子集，不通过扩宽 URL、移除限流或猜测模型名来绕过限制。
