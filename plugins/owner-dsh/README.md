# 小易委派到主人的 DSH

在独立测试 QQ 机器人中，以配置的主人账号私聊：

- `/dsh 回复测试标记 7341`，或「小易，让我的 DSH 回复测试标记 7341」，或「小易，你用 DSH，回复测试标记 7341」
- `/dsh status <任务号>` 查询
- `/dsh cancel <任务号>` 请求取消当前由该委派发起的运行

未点名工作区的任务在测试工作区的独立任务子目录中新建一条桌面会话；主人点名已有工作区时，DSH 车道直接在该工作区根目录新建会话。会话标题为「小易委派」加任务号前八位。QQ 首先用小易的人格播报执行情况（能否执行、已接单排队或已开始执行）和任务号，再在结果回来时用人格播报；结果较长时保留原始正文，避免技术细节被改写。任务需要批准或回答问题时，在桌面处理。QQ 消息去重和任务状态存在测试进程内，任务结果保留一小时。宿主重启后，可从桌面会话查看已存内容。

## 执行车道

桥接层按任务选择一条或两条车道，执行端互不代调：

- `codex`：Codex CLI 在独立任务目录中完整制作、写入和验收；没有 DSH 回退。
- `dsh`：DSH 使用当前 profile 的默认模型完整制作；成员会话不再暴露 Codex 工具。主人点名已有工作区（如「在 SIMDM 工作区」）时，DSH 会话直接运行在该工作区根目录，不再套 `task-*` 隔离目录；未点名时仍在隔离任务目录中运行。
- `both`：Codex 和 DSH 在同一任务的两个独立子目录中同时制作，结果合并回传。一条失败不会静默转给另一条。

模型不在代码里写死：默认使用各 profile 的默认模型；用户在自然语言里点名模型时，路由层把 Codex 模型提示和 DSH 模型提示分别交给对应车道。

## 隔离配置

使用全新的 DSH 数据根、私有测试根（权限 `0700`）和独立 QQ 测试机器人。测试根中创建 `.owner-dsh-test` 空文件，把 QQ 应用的测试 profile 和工作区设在该根下。Unix 套接字路径用短绝对路径，两个进程须为同一本机账号。

主人的 DSH 桌面测试 profile 在 `cordis.patch.yml` 添加以下条目。路径替换为自己的测试值：

```yaml
- insert:
    - id: qqbot-owner-dsh
      name: "/absolute/path/to/DSH-bot/plugins/owner-dsh/index.js"
      config:
        socket: "/tmp/private-test/dsh.sock"
        workspace: "/tmp/private-test/workspace"
```

也可以在这个桌面测试进程的启动环境传入 `QQBOT_OWNER_DSH_SOCKET` 和 `QQBOT_OWNER_DSH_WORKSPACE`。桌面测试 profile 需要有可用的模型路由。本次验证使用只返回固定测试文本的本机模型。

QQ 测试端使用 `@tencent-connect/dsh-qqbot@0.5.2`。对测试根里实际安装的 QQ 插件目录接入适配器：

```sh
node /absolute/path/to/DSH-bot/plugins/owner-dsh/attach-test-qq.mjs \
  /absolute/test-root /absolute/test-root/path/to/installed/dsh-qqbot
```

以该测试 profile 启动 QQ 机器人，传入和桌面一致的 `QQBOT_OWNER_DSH_SOCKET`，以及测试机器人上主人的私聊 `QQBOT_OWNER_DSH_OPENID`。独立测试 AppID 对应的 OpenID 以该机器人实际收到的私聊事件为准。正常 QQ 文本和群消息仍进入原消息链路，只有明确委派指令会走该适配器。

## 验收

1. 用测试机器人私聊发送任务，确认小易返回任务号。
2. 在桌面测试工作区打开同号会话，确认收到原委派文字。
3. 等 DSH 完成本轮，确认原私聊收到匹配的最终回复。模拟回放可覆盖重复投递、非主人身份、群消息及桌面输入合批，真实发送需额外通过 QQ 网关验收。

## 在现有小易上试用

在同一台机器的 `DSH_HOME/owner-dsh-bridge`（默认在 `~/.dsh` 下）准备权限为 `0700` 的目录。将 `index.js` 和 `qq.js` 分别复制成 `host.mjs` 和 `qq.mjs`，并准备 `qq.json`。其中 `owner` 是小易收到的主人私聊 OpenID，`socket` 与桌面端配置一致。为第一次试用单独创建一个工作区目录。

在已有桌面 profile 的 `cordis.patch.yml` 按上面的格式加载 `host.mjs`，检查套接字上线。然后对已有小易的 QQ profile 定向执行：

```sh
node patch-qqbot.mjs --plan --only=owner-dsh-bridge
node patch-qqbot.mjs --only=owner-dsh-bridge
node patch-qqbot.mjs --check --only=owner-dsh-bridge
```

让原 QQ 服务管理器重新加载小易，确认 QQ 网关就绪。给主人私聊发送 `/dsh 回复测试通过`。测试工作区会随第一条任务出现，桌面会话和 QQ 任务号的前八位相同。

## 群技能与工作区

在群里 @ 小易后发送 `群技能 DSH 任务内容`、`/dsh 任务内容`、「小易，你用 DSH，在 SIMDM 工作区 任务内容」、「小易，帮我用 DSH 给 SIMDM 工作区发个任务，提交并推送到 GIT」，或「小易，帮我把 DSH 的机器人工作区，当前的修改分批提交并推送到 git」。初始配置只允许主人的 QQ OpenID。请求在群里回执任务号，结果正文回到发起人的 QQ 私聊。普通主人私聊继续支持 `/dsh` 和自然语言入口。自然语言里的「在 X 工作区」「给 X 工作区发个任务」会把工作区交给桌面 Host 解析为已有工作区；显式 `--workspace 别名` 仍然优先。

主人用 `/dsh --workspace 别名 任务内容` 显式操作已登记的成员工作区。成员发起的任务默认进入自己的工作区，查询和取消也只接受本人发起的任务号。不同成员的目录以已核验的私聊 OpenID 为基础，别名用于显示和路由，不用于定位文件目录。

生产的 `qq.json` 默认只有 `owner` 和 `socket`。需要开放某个成员时，在 `members` 增加该成员的已验证私聊 OpenID 和实际群成员 OpenID。群里身份和私聊身份不同的主人，可以用 `ownerGroupOpenids` 登记可信的群内身份。示例中的值均为虚构：

```json
{
  "owner": "owner-c2c",
  "socket": "/absolute/private/group.sock",
  "ownerGroupOpenids": { "group-id": "owner-group-id" },
  "members": [
    { "name": "甲", "dmOpenid": "member-c2c", "groups": { "group-id": "member-group-id" } }
  ]
}
```

成员的委派使用 `qqbot-member` 预设，只挂载限定工作区的文件工具和 Blender 工具；主人自己的群委派使用主人默认预设，才能操作目标仓库；DSH 车道不再暴露 Codex 工具。将 `access.mjs`、`member-files.mjs` 和 `member-preset.mjs` 放在 Host 模块同目录，并在桌面 profile 插入预设：

```yaml
- insert:
    - id: qqbot-member-preset
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: qqbot-member
        order: 90
        plugins:
          - id: workspace-mask
            name: "/absolute/private/member-preset.mjs"
```

## 主人私聊操作现有 DSH 会话

- 「小易，看一下当前在推进的任务对话」，或 `/dsh list [SIMDM]`；优先列出运行中的会话，没有运行中时列出近 24 小时活跃的会话，并带最近一条回复摘要。
- 「小易，盯一下 SIMDM 里正在跑的任务，结束了叫我」，或 `/dsh watch SIMDM`。
- 「小易，给 SIMDM 工作区的『回归检查』发消息：先看日志」，会话名用 `「」`。也支持 `/dsh send SIMDM "回归检查" -- 先看日志`。工作区名含空格时也用引号。
- 有多个目标时回复「选 1」一类的序号。同时有两份列表时，按提示带上列表码。选择五分钟有效。

监听固定到当前一轮，待审批时提醒一次，之后继续等这一轮结束。提醒只含工作区、会话名和状态。监听和待送达状态存于桥接目录，支持桌面或 QQ 进程重启后的续接；最长七天。发送使用现有会话的 DSH 输入队列，等审批仍需在桌面处理。

部署此扩展时，随 Host 模块部署 `owner-sessions.mjs`，随 QQ 模块部署 `qq-owner-actions.mjs`，并使用最新版 `owner-dsh-bridge` 定向补丁开启提醒轮询。

## 授予群友 DSH 个人技能

在小易控制面板打开「群员档案 → 互动设置 → 角色模块」，按群开启 DSH 工作区权限。也可以在「工作技能 → 个人技能 → DSH 工作区」设置。权限默认关闭，匹配 QQ 实际发送者的 OpenID。如果档案缺少群身份，让成员在档案关联的群里 @ 小易发送 `/dsh 身份`。管理员在角色模块填入小易回复的 12 位身份码并保存，再开启该群授权。

授权后，成员直接在群里 @ 小易发送 `/dsh 任务内容`。小易把任务号和状态发回原群。任务发起人可以在同一个群用 `/dsh result 任务号` 主动把结果正文发到群里，也可用 `/dsh status 任务号` 查询或用 `/dsh cancel 任务号` 取消。成员工作区按 QQ 群成员身份隔离。

桌面 Host 需指向与 QQ 相同的 profile。设置桥接 Host 的 `qqProfile` 和 `qq.json` 的 `qqProfile`，部署 `personal-access.mjs`、`personal-profile.mjs`，并把同仓库已有的 `qqbot-patches/profile-document-reader.js` 安装为同目录的 `profile-documents.mjs`。控制面板的「工作技能」页在 profile 的 `role-skills` 中识别 `id: owner-dsh, scope: personal, kind: access` 条目。

桌面热更新时，把新版 Host 及其本地依赖放在一个新目录，并用新的插件条目 ID 指向该入口。这样桌面不会继续使用同路径下缓存的旧模块。工作区和监听数据库仍由桥接 socket 所在目录定位。
