import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  discoverSessions,
  expandTemplate,
  locateBinary,
  parseSessions,
  sendThroughAdapter,
} from "../src/adapter";
import { validateManifest } from "../src/manifest";
import { type FakeHarness, fakeHarness, fakeManifest } from "./fakeHarness";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function harness(): Promise<FakeHarness> {
  const fake = await fakeHarness();
  roots.push(fake.root);
  return fake;
}

describe("expandTemplate", () => {
  test("replaces whole-argument placeholders and leaves literals alone", () => {
    expect(
      expandTemplate(["{bin}", "run", "-s", "{session}", "{message}"], {
        bin: "/b",
        session: "ses_1",
        message: "hello world",
      }),
    ).toEqual(["/b", "run", "-s", "ses_1", "hello world"]);
  });

  test("a hostile message stays one literal element", () => {
    const message = "; rm -rf ~ && echo $(whoami) `id` | tee /tmp/x\n--flag";
    const argv = expandTemplate(["{bin}", "send", "{session}", "{message}"], {
      bin: "/b",
      session: "ses_1",
      message,
    });
    expect(argv).toHaveLength(4);
    expect(argv[3]).toBe(message);
  });

  test("a value that looks like a placeholder is not expanded again", () => {
    expect(
      expandTemplate(["{bin}", "{message}", "{session}"], {
        bin: "/b",
        message: "{session}",
        session: "real",
      }),
    ).toEqual(["/b", "{session}", "real"]);
  });

  test("refuses a placeholder with no value", () => {
    expect(() => expandTemplate(["{bin}", "{cwd}"], { bin: "/b" })).toThrow(
      "needs {cwd}",
    );
  });
});

describe("locateBinary", () => {
  test("a glob picks the newest match and skips non-executables", async () => {
    const { root } = await harness();
    for (const [version, seconds] of [
      ["1.0.0", 1_000],
      ["1.1.0", 3_000],
      ["1.0.5", 2_000],
    ] as const) {
      await mkdir(join(root, "cli", version), { recursive: true });
      const binary = join(root, "cli", version, "tool");
      await writeFile(binary, "#!/bin/sh\n");
      await chmod(binary, 0o755);
      await utimes(binary, seconds, seconds);
    }
    await mkdir(join(root, "cli", "9.9.9"), { recursive: true });
    await writeFile(join(root, "cli", "9.9.9", "tool"), "not executable");
    await utimes(join(root, "cli", "9.9.9", "tool"), 9_000, 9_000);
    expect(
      await locateBinary({ kind: "glob", value: join(root, "cli/*/tool") }),
    ).toBe(join(root, "cli", "1.1.0", "tool"));
  });

  test("a glob expands ~ and handles spaces in the directory", async () => {
    const { root } = await harness();
    await mkdir(join(root, "Application Support", "v1"), { recursive: true });
    const binary = join(root, "Application Support", "v1", "tool");
    await writeFile(binary, "#!/bin/sh\n");
    await chmod(binary, 0o755);
    expect(
      await locateBinary(
        { kind: "glob", value: "~/Application Support/*/tool" },
        { home: root },
      ),
    ).toBe(binary);
  });

  test("returns undefined when nothing matches", async () => {
    const { root } = await harness();
    expect(
      await locateBinary({ kind: "glob", value: join(root, "none/*/tool") }),
    ).toBeUndefined();
    expect(
      await locateBinary({ kind: "path", value: join(root, "missing") }),
    ).toBeUndefined();
    expect(
      await locateBinary(
        { kind: "binary", value: "definitely-not-installed-agentplus" },
        { env: { PATH: root } },
      ),
    ).toBeUndefined();
  });

  test("a bare name is looked up on the given PATH", async () => {
    const { root, binary } = await harness();
    expect(
      await locateBinary(
        { kind: "binary", value: "fake-agent" },
        { env: { PATH: root } },
      ),
    ).toBe(binary);
  });
});

describe("parseSessions", () => {
  const tsv = validateManifest(fakeManifest("/bin/echo")).discover.parse;

  test("maps tab-separated columns to id, title and updated", () => {
    expect(
      parseSessions(
        "fake",
        "ses_a\tFirst\t2026-10-01\nses_b\tSecond\t2026-10-02\n",
        tsv,
      ),
    ).toEqual([
      {
        id: "ses_a",
        address: "fake:ses_a",
        title: "First",
        updated: "2026-10-01",
      },
      {
        id: "ses_b",
        address: "fake:ses_b",
        title: "Second",
        updated: "2026-10-02",
      },
    ]);
  });

  test("skips blank lines and honors skip_lines and skipped columns", () => {
    const rule = validateManifest(
      fakeManifest("/bin/echo", {
        discover: {
          argv: ["{bin}", "ls"],
          parse: { format: "tsv", columns: ["skip", "id"], skip_lines: 1 },
        },
      }),
    ).discover.parse;
    expect(parseSessions("fake", "HEADER\n\nx\tses_a\r\n", rule)).toEqual([
      { id: "ses_a", address: "fake:ses_a" },
    ]);
  });

  test("a short line is an error, not a silently dropped session", () => {
    expect(() => parseSessions("fake", "only-id\n", tsv)).toThrow(
      "line 1 has 1 tab-separated columns, expected 3",
    );
  });

  test("an id that cannot be addressed is an error", () => {
    expect(() => parseSessions("fake", "bad id\tT\tU\n", tsv)).toThrow(
      'session id "bad id"',
    );
  });

  test("reads a json list through dotted paths", () => {
    const rule = validateManifest(
      fakeManifest("/bin/echo", {
        discover: {
          argv: ["{bin}", "ls"],
          parse: {
            format: "json",
            items: "data.rows",
            fields: { id: "id", title: "meta.name", updated: "time" },
          },
        },
      }),
    ).discover.parse;
    const output = JSON.stringify({
      data: {
        rows: [
          { id: "s1", meta: { name: "One" }, time: 5 },
          { id: 2, meta: {} },
        ],
      },
    });
    expect(parseSessions("fake", output, rule)).toEqual([
      { id: "s1", address: "fake:s1", title: "One", updated: "5" },
      { id: "2", address: "fake:2" },
    ]);
    expect(() => parseSessions("fake", "{}", rule)).toThrow(
      'no list at "data.rows"',
    );
    expect(() => parseSessions("fake", "<html>", rule)).toThrow(
      "not valid JSON",
    );
  });
});

describe("a fake adapter", () => {
  test("discovers sessions by running the binary", async () => {
    const fake = await harness();
    const manifest = validateManifest(fakeManifest(fake.binary));
    const sessions = await discoverSessions(manifest, fake.binary);
    expect(sessions.map((s) => s.address)).toEqual([
      "fake:ses_a",
      "fake:ses_b",
    ]);
  });

  test("send passes a hostile message as exactly one argument and runs nothing", async () => {
    const fake = await harness();
    const manifest = validateManifest(fakeManifest(fake.binary));
    const canary = join(fake.root, "pwned");
    const message = `done; touch ${canary}; $(touch ${canary}2) \`touch ${canary}3\` && rm -rf ~`;
    const sent = await sendThroughAdapter(manifest, fake.binary, {
      session: "ses_a",
      message,
      cwd: fake.root,
    });
    expect(sent.reply).toBe("replied");
    const lines = (await readFile(fake.argsFile, "utf8")).trimEnd().split("\n");
    expect(lines.slice(0, 4)).toEqual([
      "<run>",
      "<-s>",
      "<ses_a>",
      `<${message}>`,
    ]);
    expect(lines).toHaveLength(5);
    for (const suffix of ["", "2", "3"])
      expect(await Bun.file(`${canary}${suffix}`).exists()).toBe(false);
  });

  test("send runs in --cwd when the manifest says run, and not otherwise", async () => {
    const fake = await harness();
    const elsewhere = join(fake.root, "project");
    await mkdir(elsewhere);
    const manifest = validateManifest(fakeManifest(fake.binary));
    await sendThroughAdapter(manifest, fake.binary, {
      session: "ses_a",
      message: "hi",
      cwd: elsewhere,
    });
    const ran = (await readFile(fake.argsFile, "utf8")).trimEnd().split("\n");
    expect(ran.at(-1)?.endsWith("project")).toBe(true);

    const ignoring = validateManifest(
      fakeManifest(fake.binary, { cwd: "none" }),
    );
    await sendThroughAdapter(ignoring, fake.binary, {
      session: "ses_a",
      message: "hi",
      cwd: elsewhere,
    });
    const again = (await readFile(fake.argsFile, "utf8")).trimEnd().split("\n");
    expect(again.at(-1)?.endsWith("project")).toBe(false);
  });

  test("{cwd} reaches the harness as one resolved argument", async () => {
    const fake = await harness();
    const manifest = validateManifest(
      fakeManifest(fake.binary, {
        send: { argv: ["{bin}", "run", "{cwd}", "{session}", "{message}"] },
      }),
    );
    await sendThroughAdapter(manifest, fake.binary, {
      session: "s",
      message: "m",
      cwd: fake.root,
    });
    expect(await readFile(fake.argsFile, "utf8")).toContain(`<${fake.root}>`);
  });

  test("reply none returns no reply", async () => {
    const fake = await harness();
    const manifest = validateManifest(
      fakeManifest(fake.binary, { reply: "none" }),
    );
    expect(
      await sendThroughAdapter(manifest, fake.binary, {
        session: "s",
        message: "m",
      }),
    ).toEqual({});
  });

  test("a failing harness surfaces its error with secrets redacted", async () => {
    const fake = await harness();
    const manifest = validateManifest(
      fakeManifest(fake.binary, {
        send: { argv: ["{bin}", "fail", "{session}", "{message}"] },
      }),
    );
    const error = await sendThroughAdapter(manifest, fake.binary, {
      session: "s",
      message: "m",
    }).catch((e: Error) => e);
    expect((error as Error).message).toContain("exited 3");
    expect((error as Error).message).not.toContain("sk-abcdefghijklmnop");
  });

  test("a message starting with - is refused unless the template has --", async () => {
    const fake = await harness();
    const plain = validateManifest(fakeManifest(fake.binary));
    await expect(
      sendThroughAdapter(plain, fake.binary, {
        session: "s",
        message: "--yolo",
      }),
    ).rejects.toThrow('starts with "-"');
    const separated = validateManifest(
      fakeManifest(fake.binary, {
        send: { argv: ["{bin}", "run", "{session}", "--", "{message}"] },
      }),
    );
    await sendThroughAdapter(separated, fake.binary, {
      session: "s",
      message: "--yolo",
    });
    expect(await readFile(fake.argsFile, "utf8")).toContain("<--yolo>");
  });

  test("a NUL byte in the message is refused", async () => {
    const fake = await harness();
    const manifest = validateManifest(fakeManifest(fake.binary));
    await expect(
      sendThroughAdapter(manifest, fake.binary, {
        session: "s",
        message: "a\0b",
      }),
    ).rejects.toThrow("NUL");
  });
});
