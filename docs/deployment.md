# Deployment

English | [中文](deployment.zh-CN.md)

The backend listens only on `127.0.0.1`, using port `3010` by default. To access it from another
device, put it behind an HTTPS reverse proxy or a private-network entry point. Do not expose the
Node.js listener directly to a local network or the public internet.

The `deploy/` directory contains generic systemd and launchd examples whose values are all
`__PLACEHOLDERS__`. They are starting points rather than production configurations. Each deployment
environment manages its own service name, account, paths, port mapping, and network entry point.
Do not commit completed configuration files.

## 1. Prerequisites

- Node.js 24 or later
- A project root directory: when creating a group, its working directory is selected from the
  immediate subdirectories of this root
- At least one supported AI CLI, installed and signed in: Claude Code, Codex, Grok, Pi, Cursor, or
  Antigravity. Pi also requires its permission extension, `pi-minimal-permission-system`, installed
  through Pi's package manager so lanting can route tool confirmations to the web interface.
  Cursor uses the Cursor Agent CLI; install it according to Cursor's documentation and sign in with
  `cursor-agent login`. lanting does not select a Cursor model and uses Cursor's current default.
  Antigravity uses Google's Antigravity ACP Server (`agy_acp_server.par`); install it according to
  Google's documentation. It has no separate login command, so follow section 7. lanting uses its
  default model, does not display context usage, cannot compact its context, and does not delete
  Antigravity's saved session when a group is permanently deleted.
- A random login token of at least 32 characters
- To send attachments, [ai-remote-upload](https://github.com/lizzyhague/ai-remote-upload) running
  under the same system account, at a version that recognizes `lanting` as a caller. lanting works without it, but attachments are unavailable.

## 2. Install and configure

```bash
npm ci
cp deploy/lanting.env.example .env
cp config.example.json config.json
chmod 600 .env config.json
```

Edit `.env` and set at least the login token. The available environment variables are:

| Variable | Purpose |
| --- | --- |
| `ACCESS_TOKEN` | Browser login credential; must be at least 32 characters |
| `PORT` | Listening port; defaults to `3010` |
| `CONFIG_PATH` | Path to the JSON configuration; defaults to `./config.json` |
| `DATA_DIR` | Directory for groups, transcripts, and settings; defaults to `./data` |
| `AI_REMOTE_UPLOAD_SOCKET` | Unix socket for ai-remote-upload; defaults to `~/.local/share/ai-remote/upload.sock` |
| `ALLOWED_ORIGINS` | Additional allowed browser origins, separated by commas |

`config.json` defines the project root and the path to each AI CLI:

```json
{
  "projectRoot": "/absolute/path/to/projects",
  "agents": {
    "claude": { "executable": "/absolute/path/to/claude" },
    "codex": { "executable": "/absolute/path/to/codex" },
    "grok": { "executable": "/absolute/path/to/grok" },
    "pi": { "executable": "/absolute/path/to/pi" },
    "cursor": { "executable": "/absolute/path/to/cursor-agent" },
    "antigravity": { "executable": "/absolute/path/to/agy_acp_server.par" }
  }
}
```

The `agents` object determines which CLI types are available on this machine. Types that are not
listed appear unavailable in Settings. Paths may start with `~/`.

Manage the AIs that can join groups in the web interface's Settings page. Each AI has one CLI type
and one primary color, and multiple AIs may use the same CLI type. On first startup, lanting creates
one AI for each CLI configured in `config.json`; it does not add more automatically afterward.

`.env`, `config.json`, and `data/` contain local data and must not be committed.

## 3. Run in the foreground once

The application does not load `.env` itself. Export its values before an interactive test:

```bash
set -a
. ./.env
set +a
npm start
```

Once ready, the health check should return `{"status":"ok"}`:

```bash
curl --fail --silent --show-error http://127.0.0.1:3010/healthz
```

Use the configured port if you changed `PORT`.

## 4. Run as a service

Use systemd on Linux and launchd on macOS. With either service manager, explicitly set:

- the repository root as the working directory;
- `HOME`, the complete `PATH`, and the environment variables above;
- the command to run `src/server/main.ts` directly with Node.js;
- a restart policy for unexpected exits; and
- enough time for a clean shutdown after `SIGTERM` (the examples use 15 seconds).

### Linux / systemd

Start with `deploy/lanting.service.example`. Replace `__RUN_USER__`, `__RUN_GROUP__`, `__APP_DIR__`,
`__RUN_HOME__`, `__RUNTIME_PATH__`, `__ENV_FILE__`, and `__NODE_BIN__` with values for the target
host, then install the file in the systemd unit directory. `__RUNTIME_PATH__` must contain the full
path because a service does not inherit the interactive shell's `PATH`.

### macOS / launchd

Start with `deploy/launchd/lanting.plist.example`. It defines a system LaunchDaemon that runs as an
unprivileged service account through `UserName` and `GroupName`. In addition to the placeholders
above, replace `__LANTING_SERVICE_LABEL__` and `__LOG_DIR__`. Both the Node.js executable and source
entry point in `ProgramArguments` must use absolute paths.

## 5. Update

Node.js runs the `.ts` files directly, so there is no build step. Restart the service after updating
the source, then refresh the page.

When serving the page, the server generates versioned script and stylesheet URLs in
`public/.web-assets/`. The service account must be able to write to this Git-ignored directory.
Register new frontend files in the static-file allowlist in `src/server/http-server.ts`, then restart
the backend.

## 6. Add a CLI

After installing and signing in to a new CLI, add its path to `config.json`, for example:

```json
"codex": { "executable": "/absolute/path/to/codex" }
```

`config.json` is read only at startup. Restart lanting after editing it. The CLI type then becomes
available in Settings, where you can add an AI or assign it to an existing AI.

If you remove a CLI type from `config.json` and restart, AIs that use it appear incomplete in
Settings and cannot join new groups. Calling one in an existing group produces an error explaining
that it is unavailable.

## 7. Sign in to Antigravity ACP Server

ACP Server uses the login state in the service account's home directory. lanting does not initiate
login or read the credentials. Before deployment, sign in on the server as the same system account
that will run lanting.

ACP Server has no separate login command, so an ACP client must initiate the process:

1. Start `agy_acp_server.par --uid=`. Without `--uid=`, it tries to switch user groups and may exit.
   It reads newline-delimited JSON-RPC 2.0 messages from stdin and writes them to stdout.
2. Send `initialize`, then `authenticate` with `methodId` set to `oauth-personal` for a personal
   Google account.
3. The authorization URL is printed to stderr in the form
   `Open the following link to authenticate the ACP server: <URL>`. Keep the process running until
   authorization finishes. The login attempt expires after about five minutes.

After authorization, the browser redirects to `127.0.0.1:<callback-port>` on the server. The port is
random each time; use the port in the authorization URL's `redirect_uri`. Complete the flow in one
of two ways:

- Open the authorization URL in a browser on the server, such as through a remote desktop session.
- If the server has no graphical environment, forward the callback port from another computer to
  the same port on the server with
  `ssh -L <callback-port>:127.0.0.1:<callback-port> user@server`, then open the authorization URL in
  that computer's browser.

If the login expires and ACP Server cannot refresh it, Antigravity's turn in a group fails with a
message asking you to sign in again. Repeat the steps above; lanting does not need to be restarted.
