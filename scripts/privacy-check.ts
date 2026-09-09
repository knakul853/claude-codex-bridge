import { lstat, readFile } from "node:fs/promises";

const forbiddenPaths = [
  ".env",
  ".claude",
  "node_modules",
  "claude-codex-bridge",
];
const forbiddenContent = [
  { name: "local home path", pattern: /\/(?:Users|home)\/[^/\s]+\// },
  { name: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    name: "API key assignment",
    pattern: /\b(?:API_KEY|TOKEN|SECRET|PASSWORD)=[^<\s"'$]+/,
  },
  { name: "provider token", pattern: /\bsk-[A-Za-z0-9_-]{12,}/ },
];

const result = await Bun.$`git ls-files -z`.quiet().nothrow();
if (result.exitCode !== 0)
  throw new Error("privacy-check requires a Git repository");
const files = result.stdout.toString().split("\0").filter(Boolean);
for (const path of files) {
  if (
    forbiddenPaths.some((part) => path === part || path.startsWith(`${part}/`))
  ) {
    throw new Error(`private runtime path is tracked: ${path}`);
  }
  const info = await lstat(path);
  if (!info.isFile()) continue;
  const content = await readFile(path, "utf8");
  for (const rule of forbiddenContent) {
    if (rule.pattern.test(content))
      throw new Error(`${rule.name} found in ${path}`);
  }
}
process.stdout.write(`privacy-check: ${files.length} tracked files clean\n`);
