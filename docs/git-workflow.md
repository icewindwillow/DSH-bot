# Git 使用与发布约定

[返回首页](<../README.md>) · [参与贡献](<../CONTRIBUTING.md>) · [隐私检查](<privacy.md>)

这个仓库保存**可以公开的代码、文档和虚构示例**，不是机器人运行目录的云备份。你的 profile、Key、群记录、媒体与数据库必须保存在仓库外。

## 第一次取得代码

```bash
git clone https://github.com/icewindwillow/DSH-bot.git
cd DSH-bot
npm ci --ignore-scripts
npm test
```

运行配置按照[部署指南](<deployment.md>)单独建立。不要把已有机器人的整个工作目录复制进克隆目录，也不要从真实资料生成“示例”。

## 修改前建立分支

```bash
git switch -c feat/your-change
# 修改一个有明确范围的问题，并补测试与文档
npm run check
git status --short
git diff --stat
git diff
```

不同版本的上游插件可能覆盖补丁，Git 切换的是本仓库源码，不会自动更新目标 profile 的已安装产物。需要部署时先停机器人，再预检、部署、验收。

## 只暂存你确认过的公开文件

```bash
git add README.md docs scripts tests
# 若实际修改了源码，再明确添加对应文件/目录
# git add patch-qqbot.mjs qqbot-patches bot-config-panel
git diff --cached --stat
git diff --cached
npm run security:check
git commit -m "docs: improve first-run instructions"
git push -u origin feat/your-change
```

以上目录只是命令示例，按你的真实改动选择。**看到意外文件先停下来，不要用 `git add -f` 绕过忽略规则。** 安全扫描会检查已暂存与未忽略的源文件，但它不是“无隐私”的证明。

没有维护权限时，在 GitHub Fork 本项目，将分支推到你的 Fork，再发 Pull Request。说明实际执行过的测试、平台、额外费用、外联目标和行为变化；不要在 PR 中粘贴真实群消息或 Key。

## 拉取更新与机器人升级是两回事

先提交或妥善保存本地源码改动，再更新主分支：

```bash
git switch main
git pull --ff-only
npm ci --ignore-scripts
npm run check
```

如果本地分支已分叉，`--ff-only` 会拒绝，不会替你自动合并。先检查历史和差异，不要用破坏性 reset 覆盖未保存的工作。随后按[部署升级步骤](<deployment.md>)停机、备份、预检、重新应用补丁。

## 维护者发布前清单

- `npm run check` 通过，CI 状态正常；未执行的真实 QQ/API 验收明确标注。
- 人工检查暂存差异、文件清单、示例数据和文档图片，没有真实 Key、群 ID、成员资料、聊天历史、数据库、日志、图片与登录态。
- 更新适用的版本基线、配置说明、默认开关和第三方归属；不把免费渠道写成永久免费无限。
- 确认许可证仅覆盖有权授权的内容。
- `git status` 无意外文件；提交后再推送，不在发布命令中顺便收集整个运行目录。

## 如果误提交敏感数据

1. **先撤销/轮换泄漏凭据**，必要时停止相关服务。删除文件不代表密钥恢复安全。
2. 若含群或成员资料，限制进一步传播，按照实际情况通知相关人员并走[安全报告流程](<../SECURITY.md>)；不要在公开 Issue 再贴一遍原文。
3. `.gitignore` 只影响后续未跟踪文件，不会清除已经进入提交、远端、Fork 或缓存的数据。`git rm --cached` 也不会抹去旧历史。
4. 维护者协调所有协作者后再选择合适的历史清理方案；重写历史和强制推送会影响他人的分支，不要由自动脚本擅自执行。

本项目的默认发布流程不会复制生产 profile、收集本机历史，也不会自动重写远端 Git 历史。
