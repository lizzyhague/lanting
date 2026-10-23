# AGENTS.md

Guidance for coding agents working in this repository.

## Running and checking

- Node.js 24 runs the `.ts` sources directly. There is no build step.
- Before committing, run `npm run typecheck` and `npm test`.

## Code

- The server serves frontend files from an allowlist, not a directory. Register every new file the
  page loads from `public/` in `STATIC_FILES` in `src/server/http-server.ts`, or it returns 404.
- Tests that involve a CLI put a fake executable in a temporary directory. They must not call a CLI
  installed on the machine or use a real project directory.

## Repository

- Do not commit `.env`, `config.json` or `data/`. Files under `deploy/` are generic templates;
  keep them free of real deployment values and do not commit filled-in copies.
- Write code comments, test titles and commit messages in English.
