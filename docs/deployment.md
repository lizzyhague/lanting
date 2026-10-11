# 部署说明

后端只监听 `127.0.0.1`，默认端口 `3010`。要从别的设备访问，外层用 HTTPS 反向代理或
私有网络入口，不要把 Node 监听地址直接暴露到局域网或公网。

`deploy/` 下有 systemd 与 launchd 的通用样例，里面全部是 `__占位符__`。它们只是起点，
不是线上配置：服务名、账户、路径、端口映射和网络入口由各部署环境自己管理，填好的文件
不进 Git。

## 1. 准备

- Node.js 24 或更高版本
- 一个项目根目录：新建群时，工作目录从它下面的第一层文件夹里选
- 要拉进群的 AI 的 CLI，已安装并登录：Claude Code、Codex、Grok、Pi、Cursor，至少一个。
  Pi 还要用它自己的包管理命令安装权限扩展 `pi-minimal-permission-system`，lanting 才能把工具确认接到网页审批。
  Cursor 用 Cursor Agent CLI，按 Cursor 官方说明安装后运行 `cursor-agent login` 登录；
  lanting 不切换 Cursor 的模型，用的是 Cursor 当前的默认模型。
- 一个至少 32 字符的随机登录令牌
- 要发附件的话：同一个系统账户下运行的 ai-remote-upload，
  版本要认得调用方 `lanting`。不装也能用，只是不能发附件

## 2. 装代码和配置

```bash
npm ci
cp deploy/lanting.env.example .env
cp config.example.json config.json
chmod 600 .env config.json
```

编辑 `.env`，至少设置登录令牌。可用的环境变量：

| 变量 | 作用 |
| --- | --- |
| `ACCESS_TOKEN` | 浏览器登录凭据，至少 32 字符 |
| `PORT` | 监听端口，默认 `3010` |
| `CONFIG_PATH` | JSON 配置路径，默认 `./config.json` |
| `DATA_DIR` | 群、群聊记录和设置的存放目录，默认 `./data` |
| `AI_REMOTE_UPLOAD_SOCKET` | ai-remote-upload 的 Unix socket，默认 `~/.local/share/ai-remote/upload.sock` |
| `ALLOWED_ORIGINS` | 额外允许的浏览器 Origin，逗号分隔 |

`config.json` 提供项目根目录和各 AI 的 CLI 路径：

```json
{
  "projectRoot": "/absolute/path/to/projects",
  "agents": {
    "claude": { "executable": "/absolute/path/to/claude" },
    "codex": { "executable": "/absolute/path/to/codex" },
    "grok": { "executable": "/absolute/path/to/grok" },
    "pi": { "executable": "/absolute/path/to/pi" },
    "cursor": { "executable": "/absolute/path/to/cursor-agent" }
  }
}
```

`agents` 只决定这台机器能用哪几种 CLI，没写的种类在设置页里显示为不可选。路径可以用
`~/` 开头。

群里有哪些 AI，在页面的设置里管理：每个 AI 选一种 CLI 和一个主色，同一种 CLI 可以给
多个 AI 用。第一次启动时，会按 `config.json` 里已配置的 CLI 各生成一个 AI；之后不再
自动添加。

`.env`、`config.json` 和 `data/` 都是本机数据，不提交。

## 3. 先前台跑一次

应用本身不读 `.env`，交互式测试时要先把变量导进环境：

```bash
set -a
. ./.env
set +a
npm start
```

就绪后健康检查应返回 `{"status":"ok"}`：

```bash
curl --fail --silent --show-error http://127.0.0.1:3010/healthz
```

改过 `PORT` 就换成实际端口。

## 4. 常驻运行

Linux 用 systemd，macOS 用 launchd。不管哪种进程管理器，都要明确设置：

- 工作目录为仓库根目录；
- `HOME`、完整 `PATH` 和上面那些环境变量；
- 启动命令是 Node.js 直接运行 `src/server/main.ts`；
- 异常退出后的重启策略；
- 给 `SIGTERM` 留足正常停止的时间（样例为 15 秒）。

### Linux / systemd

以 `deploy/lanting.service.example` 为起点，把 `__RUN_USER__`、`__RUN_GROUP__`、
`__APP_DIR__`、`__RUN_HOME__`、`__RUNTIME_PATH__`、`__ENV_FILE__` 和 `__NODE_BIN__`
换成本机实际值，再装进 systemd 单元目录。`__RUNTIME_PATH__` 要写完整，服务环境不会
继承交互式 shell 的 `PATH`。

### macOS / launchd

以 `deploy/launchd/lanting.plist.example` 为起点。它是系统级 LaunchDaemon，但通过
`UserName` / `GroupName` 以普通服务用户运行，不用 root。除上面那几个占位符外，还要
换掉 `__LANTING_SERVICE_LABEL__` 和 `__LOG_DIR__`。`ProgramArguments` 里的 Node 路径和
源码入口都必须是绝对路径。

## 5. 更新

Node 直接运行 `.ts`，没有构建步骤。更新代码后重启服务即可生效，再刷新页面。

服务器在提供页面时自动生成带版本地址的脚本和样式，保存在 `public/.web-assets/`。
运行账户必须能写这个目录；它已被 Git 忽略。新增前端文件要登记到
`src/server/http-server.ts` 的静态文件白名单，并重启后端。

## 6. 新增 CLI

部署后再装了新的 CLI，先在本机装好并登录，然后在 `config.json` 的 `agents` 里补上它的
路径，例如：

```json
"codex": { "executable": "/absolute/path/to/codex" }
```

`config.json` 只在启动时读一次，改完要重启 lanting。重启后，这种 CLI 在设置页的下拉里
变为可选，再到设置里添加 AI 或给已有的 AI 选上它。

从 `config.json` 去掉某种 CLI 并重启后，用它的 AI 在设置里显示为不完整，不能拉进新群；
已有的群里点到它时，会在群里如实报错。
