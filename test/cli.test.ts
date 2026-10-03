import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fakeHarness, fakeManifest } from "./fakeHarness";

const roots: string[] = [];
const cli = resolve(import.meta.dir, "../src/cli.ts");

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function run(cwd: string, command: string): Promise<number> {
  const child = Bun.spawn([process.execPath, cli, command], {
    cwd,
    env: { ...process.env, HOME: cwd },
    stdout: "pipe",
    stderr: "pipe",
  });
  await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return child.exited;
}

test("install and uninstall commands preserve unrelated user hooks", async () => {
  const root = (await Bun.$`mktemp -d /tmp/bridge-cli.XXXXXX`.text()).trim();
  roots.push(root);
  await mkdir(join(root, ".claude"));
  await writeFile(
    join(root, ".claude", "settings.json"),
    `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "keep" }] }] } })}\n`,
  );

  expect(await run(root, "install-hooks")).toBe(0);
  expect(await run(root, "install-hooks")).toBe(0);
  const installed = await readFile(
    join(root, ".claude", "settings.json"),
    "utf8",
  );
  expect(installed.match(/claude-codex-bridge hook/g)).toHaveLength(2);
  expect(installed).toContain("keep");

  expect(await run(root, "uninstall-hooks")).toBe(0);
  const removed = await readFile(
    join(root, ".claude", "settings.json"),
    "utf8",
  );
  expect(removed).not.toContain("claude-codex-bridge hook");
  expect(removed).toContain("keep");
});

test("send refuses an empty message instead of submitting nothing", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      cli,
      "send",
      "--thread",
      "t1",
      "--steer",
      "--message",
      "  ",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stderr = await new Response(child.stderr).text();
  expect(await child.exited).toBe(2);
  expect(stderr).toContain("send needs a message");
});

test("the legacy claude-codex-bridge name reaches the same entry point", async () => {
  const root = (await Bun.$`mktemp -d /tmp/bridge-alias.XXXXXX`.text()).trim();
  roots.push(root);
  const alias = join(root, "claude-codex-bridge");
  await symlink(cli, alias);
  for (const command of ["inbox", "notify"]) {
    const child = Bun.spawn([alias, command, "--help"], {
      env: { ...process.env, AGENTPLUS_HOME: root },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(stdout).toContain("agent+ (agentplus");
    expect(stdout).toContain("inbox [--watch]");
  }
});

async function runCli(
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    env: { ...process.env, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout, stderr };
}

test("harnesses, sessions and the runs_turn gate work end to end", async () => {
  const fake = await fakeHarness("agentplus-cli-");
  roots.push(fake.root);
  const config = join(fake.root, "config");
  const dir = join(config, "agentplus", "harnesses");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "fake.json"),
    JSON.stringify(fakeManifest(fake.binary)),
  );
  await writeFile(
    join(dir, "turns.json"),
    JSON.stringify(
      fakeManifest(fake.binary, { name: "turns", runs_turn: true }),
    ),
  );
  const env = {
    XDG_CONFIG_HOME: config,
    AGENTPLUS_HOME: join(fake.root, "home"),
  };

  const harnesses = await runCli(["harnesses"], env);
  expect(harnesses.code).toBe(0);
  expect(
    (
      JSON.parse(harnesses.stdout) as { harnesses: Array<{ name: string }> }
    ).harnesses.map((h) => h.name),
  ).toEqual(["codex", "claude", "fake", "turns"]);

  const sessions = await runCli(["sessions", "--harness", "fake"], env);
  expect(sessions.code).toBe(0);
  expect(sessions.stdout).toContain("fake:ses_a");

  const refused = await runCli(
    ["send", "--to", "turns:ses_a", "--message", "hi"],
    env,
  );
  expect(refused.code).toBe(5);
  expect(JSON.parse(refused.stderr)).toMatchObject({
    ok: false,
    code: "turn_requires_run",
  });
  expect(await Bun.file(fake.argsFile).exists()).toBe(false);

  const sent = await runCli(
    ["send", "--to", "turns:ses_a", "--message", "hi", "--run", "--from", "t"],
    env,
  );
  expect(sent.code).toBe(0);
  expect(JSON.parse(sent.stdout)).toMatchObject({ ok: true, reply: "replied" });
});

test("notify accepts an address and an envelope kind", async () => {
  const root = (
    await Bun.$`mktemp -d /tmp/bridge-notify-cli.XXXXXX`.text()
  ).trim();
  roots.push(root);
  const env = {
    AGENTPLUS_HOME: root,
    CLAUDE_SESSIONS_DIR: join(root, "none"),
  };
  const sent = await runCli(
    ["notify", "--to", "claude:abc", "--message", "hi", "--kind", "fyi"],
    env,
  );
  expect(sent.code).toBe(0);
  const read = await runCli(["inbox", "--to", "claude:abc"], env);
  expect(JSON.parse(read.stdout).messages[0]).toMatchObject({
    message: "hi",
    kind: "fyi",
    to: "abc",
  });
  const wrong = await runCli(
    ["notify", "--to", "codex:abc", "--message", "hi"],
    env,
  );
  expect(wrong.code).toBe(4);
  expect(wrong.stderr).toContain("not a Claude session");
  const badKind = await runCli(
    ["notify", "--message", "hi", "--kind", "shout"],
    env,
  );
  expect(badKind.code).toBe(2);
});
