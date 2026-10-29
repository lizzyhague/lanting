# lanting

English | [中文](README.zh-CN.md)

lanting is a single-user, self-hosted group chat for coding AIs. It brings the CLIs of several coding
AIs, such as Claude Code, Codex and Grok, into one group, so you can discuss a project with all of them
from a web page on your phone or computer. Each AI keeps running as its own CLI on the host, in the
group's working directory, with its own tools and permissions.

The backend is a Node.js service that listens only on `127.0.0.1`. The browser talks to it over a
restricted WebSocket protocol; the backend drives each CLI through that CLI's own SDK or protocol. The
browser can neither reach the CLIs directly nor choose an arbitrary working directory.

> This project is not an official product of any AI vendor, and it is not a multi-user account system.
> It assumes the person who deploys it is the only trusted user. Do not offer an instance to strangers as a
> public sign-up service.

## Features

- Supported CLIs: Claude Code, Codex, Grok, Pi, Cursor Agent and Antigravity ACP Server;
- Several AIs in one group, including several AIs of the same CLI type, each with its own name and color;
- In each round you call on one or more AIs, and they reply one at a time in the order you chose; each AI
  receives everything said in the group since it last spoke;
- Each group's working directory is picked from the immediate subdirectories of the configured project root;
- Per AI and per group, pick the model, reasoning effort and permission mode the CLI offers;
- Tool calls are shown on the page, and tool approvals are handled there; an approval nobody answers is
  denied after 120 seconds;
- Collaboration rules written in Settings are passed to every AI in every group;
- Add attachments with the plus menu, drag files onto the composer, or paste files and screenshots into
  the message box; uploads use the separate [ai-remote-upload](https://github.com/lizzyhague/ai-remote-upload)
  service;
- After signing in, view Markdown documents and images inside the project root and `~/preview`; there is
  no source viewing, download or directory browsing;
- Pin groups, move them to trash, and restore them within 30 days; a permanent delete also deletes the
  AIs' native sessions where the CLI supports it;
- Interface in Chinese or English, light and dark themes, installable as a PWA.

## Data path

```text
Phone or computer browser
  -> HTTPS entry point (a private network or a reverse proxy)
  -> lanting on 127.0.0.1:<PORT>
  -> ai-remote-upload on a Unix socket (attachments, optional)
  -> one CLI process or SDK session per AI in the group
```

## Requirements

- A Linux or macOS host;
- Node.js 24 or later, and npm;
- At least one supported AI CLI, installed and signed in under the account that runs lanting;
- For attachments, [ai-remote-upload](https://github.com/lizzyhague/ai-remote-upload) running under the
  same account. Plain-text chat works without it.

Run lanting as a non-root user that can access the projects you want the AIs to work on. The AIs act with
that account's permissions.

## Quick start

These commands are for a local trial run. For a long-lived service and remote access, see the
[deployment guide](docs/deployment.md).

```bash
npm ci
cp deploy/lanting.env.example .env
cp config.example.json config.json
chmod 600 .env config.json
```

Set `ACCESS_TOKEN` in `.env` to a random value of at least 32 characters, for example from
`openssl rand -hex 32`. In `config.json`, set `projectRoot` and the absolute path of each CLI you have
installed; remove the ones you don't have.

lanting does not load `.env` itself, so export it before starting:

```bash
set -a
. ./.env
set +a
npm start
```

Health check:

```bash
curl http://127.0.0.1:3010/healthz
```

Then open the page through an HTTPS entry point and sign in with the token. On first startup, lanting
creates one AI for each CLI in `config.json`; manage them on the Settings page.

## Data and browser storage

Groups, transcripts and settings live in `DATA_DIR` (`./data` by default). Transcripts contain the
conversation, so protect this directory at the same level as the CLIs' own session data. Each CLI still
keeps its native sessions and history in its usual place.

At sign-in the browser hands the access token to the server and afterwards keeps only an `HttpOnly`
signed cookie; the token itself is never written to browser storage. Changing the token invalidates every
issued cookie. Interface language and appearance are kept only in the browser.

See the [security policy](SECURITY.md) for the trust model.

## Development and checks

```bash
npm run typecheck
npm test
```

Node.js runs the TypeScript sources directly; there is no build step.

## License and trademarks

The code is released under the [Apache License 2.0](LICENSE). Copyright (c) 2026 lizzyhague.

The project name "lanting", the logo and other brand assets are **not** covered by the Apache License 2.0;
the copyright holder reserves all rights to them (see section 6 of the license: it grants no trademark
rights). You are free to use, modify and redistribute the code, but please give derived versions your own
name and marks.

This project is not affiliated with, endorsed by, or sponsored by Anthropic, OpenAI, xAI, Anysphere
(Cursor), Google or any other AI tool vendor. Product names belong to their respective owners and are used
here only to describe what this software connects to.

The bundled Marck Script font is licensed under the SIL Open Font License 1.1. See [NOTICE](NOTICE) for
details.
