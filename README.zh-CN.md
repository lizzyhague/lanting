# lanting

[English](README.md) | 中文

lanting 是一个面向单用户、自托管场景的编程 AI 群聊。它把 Claude Code、Codex、Grok 等几个编程
AI 的 CLI 拉进同一个群，让你在手机或电脑的网页上，同时和它们讨论一个项目。每个 AI 仍然以
它自己的 CLI 在主机上运行，在群的工作目录里，用它自己的工具和权限。

后端是一个只监听 `127.0.0.1` 的 Node.js 服务。浏览器通过受限的 WebSocket 协议和它通信；后端
再用各个 CLI 自己的 SDK 或协议驱动它们。浏览器不能直接连到 CLI，也不能指定任意工作目录。

> 本项目不是任何 AI 厂商的官方产品，也不是多用户账户系统。它假定部署者本人是唯一可信的
> 用户。不要把实例作为公开注册服务提供给陌生人。

## 功能

- 支持的 CLI：Claude Code、Codex、Grok、Pi、Cursor Agent、Antigravity ACP Server；
- 一个群里可以有多个 AI，同一种 CLI 也可以有多个 AI，各有自己的名字和颜色；
- 每一轮点名一个或几个 AI，按你定的顺序依次发言；每个 AI 收到的是它上次发言以来群里的全部内容；
- 每个群的工作目录从配置的项目根目录的第一层子目录里选；
- 每个 AI 在每个群里可以分别选择 CLI 提供的模型、推理强度和权限模式；
- 工具调用显示在页面上，工具审批也在页面上处理；无人处理的审批 120 秒后自动拒绝；
- 在设置里写的协作规则，会传给所有群里的每个 AI；
- 可通过加号选择附件，把文件拖到输入区，或在输入框里粘贴文件和截图；附件通过独立的 [ai-remote-upload](https://github.com/lizzyhague/ai-remote-upload) 服务收发；
- AI 可以交付文件，用户在聊天中的文件卡片上下载；
- 登录后可以查看项目根目录和 `~/preview` 里的 Markdown 文档和图片；预览页不提供源码查看、下载按钮或目录浏览；
- 群可以置顶、移入回收站，30 天内可以恢复；永久删除时，在 CLI 支持的情况下一并删除各个 AI 的原生会话；
- 中英文界面，浅色和深色主题，可以作为 PWA 安装。

## 数据路径

```text
手机或电脑浏览器
  -> HTTPS 入口（私有网络或反向代理）
  -> 127.0.0.1:<PORT> 上的 lanting
  -> Unix socket 上的 ai-remote-upload（附件，可选）
  -> 群里每个 AI 各一个 CLI 进程或 SDK 会话
```

## 环境要求

- Linux 或 macOS 主机；
- Node.js 24 或更新版本，以及 npm；
- 至少一个支持的 AI CLI，已在运行 lanting 的账户下安装并登录；
- 要发附件的话，在同一个账户下运行 [ai-remote-upload](https://github.com/lizzyhague/ai-remote-upload)。
  没有它也能正常纯文字聊天。

用一个非 root 用户运行 lanting，这个用户要能访问你想让 AI 处理的项目。AI 以这个账户的权限行事。

## 快速开始

下面的命令只用于本地试运行。长期运行的服务和远程访问，见[部署说明](docs/deployment.zh-CN.md)。

```bash
npm ci
cp deploy/lanting.env.example .env
cp config.example.json config.json
chmod 600 .env config.json
```

把 `.env` 里的 `ACCESS_TOKEN` 设成至少 32 个字符的随机值，比如用 `openssl rand -hex 32` 生成。
在 `config.json` 里设置 `projectRoot` 和已安装的各个 CLI 的绝对路径；没装的删掉。

lanting 自己不读取 `.env`，启动前先导出：

```bash
set -a
. ./.env
set +a
npm start
```

健康检查：

```bash
curl http://127.0.0.1:3010/healthz
```

然后通过 HTTPS 入口打开页面，用令牌登录。首次启动时，lanting 为 `config.json` 里的每个 CLI
各建一个 AI；之后在设置页管理。

## 数据与浏览器存储

群、聊天记录和设置存放在 `DATA_DIR`（默认 `./data`）。聊天记录包含对话内容，请按各个 CLI
自身会话数据的级别保护这个目录。各个 CLI 仍然在它们原来的位置保存自己的原生会话和历史。

登录时浏览器把访问令牌交给服务端，之后只保留一个 `HttpOnly` 的签名 cookie；令牌本身不写入
浏览器存储。更换令牌会让所有已签发的 cookie 失效。界面语言和外观只保存在浏览器里。

信任模型见[安全策略](SECURITY.zh-CN.md)。

## 开发与检查

```bash
npm run typecheck
npm test
```

Node.js 直接运行 TypeScript 源码，没有构建步骤。

## 许可与商标

代码以 [Apache License 2.0](LICENSE) 发布。Copyright (c) 2026 lizzyhague。

项目名称 "lanting"、logo 和其他品牌素材**不**在 Apache License 2.0 授权范围内，版权人保留
全部权利（见许可证第 6 条：许可证不授予商标权）。你可以自由使用、修改和再发布代码，但请给
衍生版本使用你自己的名称和标识。

本项目与 Anthropic、OpenAI、xAI、Anysphere（Cursor）、Google 及其他 AI 工具厂商均无关联，
也未获得它们的认可或赞助。各产品名称归其各自所有者，这里只用来说明本软件连接的对象。

内置的 Marck Script 字体以 SIL Open Font License 1.1 授权。详见 [NOTICE](NOTICE)。
