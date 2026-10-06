import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = `#!/bin/sh
here="$(dirname "$0")"
case "$1" in
  list)
    printf 'ses_a\\tFirst title\\t2026-10-01\\nses_b\\tSecond title\\t2026-10-02\\n'
    ;;
  run)
    : > "$here/args.txt"
    for arg in "$@"; do printf '<%s>\\n' "$arg" >> "$here/args.txt"; done
    pwd >> "$here/args.txt"
    echo "replied"
    ;;
  fail)
    echo "token=sk-$LEAKED_SUFFIX leaked" >&2
    exit 3
    ;;
esac
`;

export interface FakeHarness {
  root: string;
  binary: string;
  argsFile: string;
  manifestDir: string;
}

/**
 * A harness whose binary is a tiny script in a temp directory: it lists two
 * sessions, records the exact argv it receives, and echoes a reply.
 */
export async function fakeHarness(
  prefix = "agentplus-fake-",
): Promise<FakeHarness> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const binary = join(root, "fake-agent");
  await writeFile(binary, SCRIPT);
  await chmod(binary, 0o755);
  return {
    root,
    binary,
    argsFile: join(root, "args.txt"),
    manifestDir: join(root, "harnesses"),
  };
}

export function fakeManifest(
  binary: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: "fake",
    locate: binary,
    discover: {
      argv: ["{bin}", "list"],
      parse: { format: "tsv", columns: ["id", "title", "updated"] },
    },
    send: { argv: ["{bin}", "run", "-s", "{session}", "{message}"] },
    runs_turn: false,
    reply: "stdout",
    cwd: "run",
    ...overrides,
  };
}
