# 第三方归属与许可说明

## 本仓库是什么，不是什么

DSH-bot 是围绕 **DeepSeek Harness（DSH）**、上游 **`@tencent-connect/dsh-qqbot`** 及其它插件构建的 QQ 机器人增强层。上游 QQ 接入、宿主运行时、基础会话与长期记忆基础并非本仓库从零原创。

本文记录主要归属与使用边界，**不是完整依赖许可审计，也不替代各组件的 LICENSE、NOTICE、版权声明和服务条款**。实际安装版本可能含更多依赖，分发者应检查锁文件与安装产物并保留适用声明。

## 主要组件与服务

| 组件/服务 | 在本项目中的作用 | 归属与分发边界 |
| --- | --- | --- |
| DeepSeek Harness / `@deepseek-ai/dsh` | 宿主、模型路由、工具与 profile 运行环境 | 保留 DSH 上游权利；通过其官方发行渠道安装，不宣称宿主原创 |
| `@tencent-connect/dsh-qqbot` | QQ 机器人接入与基础会话 | 保留腾讯连接器上游版权和许可；本仓库提供安装产物增强补丁，不因此获得整个宿主的授权权利 |
| `@tr1v3r/dsh-ltm` | 长期记忆基础 | 保留该上游作者及依赖权利；增强中的 scope、门控和衍生数据不改变原许可 |
| [`dsh-our-free-model`](https://github.com/Ebony-Vinyl/dsh-our-free-model) / Our Free Model | 可选模型清单、渠道与降级链 | 本仓库不 vendoring，仅文档安装；使用官方 Release 或可信源码，不使用未经官方认可的 npm 同名包 |
| OpenAI、DeepSeek、OpenCode、象信等 API | 聊天、搜索读取与辅助判定 | 服务和商标归各权利人，使用受服务商条款、权限及计费约束 |
| 腾讯 QQ 开放平台 | 机器人消息与媒体服务 | 应用权限、审核、频率与内容规范由腾讯平台决定 |
| Node.js、SQLite、嵌入模型及其它依赖 | 运行、存储与可选语义检索 | 各自许可独立，分发二进制、模型权重或依赖时需另行核实 |

未逐项列出许可证标识的组件，请以**实际安装版本**自带许可为准；不要仅凭包名或印象给它们套用 MIT/Apache 等许可。

## 随增强片段保留的上游版权与 MIT 许可

补丁的匹配上下文、替换片段或衍生部分可能包含以下上游代码。其版权并未转移给本项目：

- [`@tencent-connect/dsh-qqbot` 0.5.2](https://www.npmjs.com/package/@tencent-connect/dsh-qqbot/v/0.5.2)：MIT，`Copyright (c) 2026 Tencent Connect`。
- [`@tr1v3r/dsh-ltm` 0.3.4](https://www.npmjs.com/package/@tr1v3r/dsh-ltm/v/0.3.4)：MIT，`Copyright (c) 2026 tr1v3r`。

对于这些上游部分，保留以下许可通知；它不是本项目向第三方重新授予许可：

```text
MIT License

Copyright (c) 2026 Tencent Connect
Copyright (c) 2026 tr1v3r

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

后续升级应重新核对实际包中的版权和许可，不能把上述版本通知当作所有未来版本的完整许可清单。

## 关于 Our Free Model

2026-10-30 核对官方 README 与 [v2.7.3 Release](https://github.com/Ebony-Vinyl/dsh-our-free-model/releases/tag/v2.7.3)。官方仓库 README 标注项目 MIT，但其发布包还可能包含单独的第三方许可证、NOTICE、渠道组件或其它元数据；**不能据此宣称包内所有代码和渠道均由本仓库许可**。

官方要求完整保留相关发布组件与许可证，且明确警告 npm 上同名包不是其官方发行。安装方法、发布可用性和校验说明见[免费模型指南](<docs/free-models.md>)。

免费额度由上游服务方决定，不由 DSH-bot 提供；服务方可以限流、调整模型、改变价格或停止服务。账号渠道和授权要求仍须遵守，不能因源码可读而绕过授权。

## 本仓库的 MIT 与第三方保留权利

本项目原创部分采用根目录的 [MIT 许可证](<LICENSE>)，仅覆盖维护者有权授权的内容。本文不是对第三方的授权书，也不会替上游组件授予任何额外许可。

第三方代码、模型权重、商标、服务和账号仍分别适用其自身条件。新增或复制第三方代码时，应记录来源、版本、修改范围、版权及许可，不移除原有声明；不得把整个依赖树或免费渠道包装为本项目统一 MIT 授权。

## 无背书关系

本项目与腾讯、OpenAI、DeepSeek、象信、OpenCode 及其它上游服务商无当然的隶属、赞助或官方背书关系。名称与商标仅用于说明兼容性和来源。

本仓库不附送服务商 API 额度、不托管模型、不保证输出正确，也不承诺任何免费渠道永久或无限可用。使用官方付费 API 的费用由用户与服务商按其约定结算。

如发现归属遗漏、权利争议或不适当的第三方内容，请联系仓库维护者；涉及敏感证据时按照[安全报告流程](<SECURITY.md>)私下沟通，不公开真实群资料或凭据。
