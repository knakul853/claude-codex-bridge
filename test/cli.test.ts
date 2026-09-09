import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const roots: string[] = [];
const cli = resolve(import.meta.dir, "../src/cli.ts");

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function run(cwd: string, command: string): Promise<number> {
  const child = Bun.spawn([process.execPath, cli, command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return child.exited;
}

test("install and uninstall commands preserve unrelated project hooks", async () => {
  const root = (await Bun.$`mktemp -d /tmp/bridge-cli.XXXXXX`.text()).trim();
  roots.push(root);
  await Bun.$`git init -q ${root}`;
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
