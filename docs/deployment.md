# 部署说明

后端只监听 `127.0.0.1`，默认端口 `3010`。要从别的设备访问，外层用 HTTPS 反向代理或
私有网络入口，不要把 Node 监听地址直接暴露到局域网或公网。

`deploy/` 下有 systemd 与 launchd 的通用样例，里面全部是 `__占位符__`。它们只是起点，
不是线上配置：服务名、账户、路径、端口映射和网络入口由各部署环境自己管理，填好的文件
不进 Git。

## 1. 准备

- Node.js 24 或更高版本
- 一个项目根目录：新建群时，工作目录从它下面的第一层文件夹里选
- 一个至少 32 字符的随机登录令牌

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
| `DATA_DIR` | 群和群聊记录的存放目录，默认 `./data` |
| `ALLOWED_ORIGINS` | 额外允许的浏览器 Origin，逗号分隔 |

`config.json` 提供项目根目录：

```json
{
  "projectRoot": "/absolute/path/to/projects"
}
```

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
