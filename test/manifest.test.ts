import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  loadManifests,
  ManifestError,
  manifestDirectory,
  parseManifestText,
  validateManifest,
} from "../src/manifest";
import { fakeHarness, fakeManifest } from "./fakeHarness";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

function manifest(overrides: Record<string, unknown> = {}) {
  return fakeManifest("/bin/echo", overrides);
}

function refusal(value: unknown): string {
  try {
    validateManifest(value);
  } catch (error) {
    expect(error).toBeInstanceOf(ManifestError);
    return (error as Error).message;
  }
  throw new Error("manifest was accepted");
}

describe("validateManifest", () => {
  test("accepts a complete manifest and fills defaults", () => {
    const parsed = validateManifest(manifest());
    expect(parsed).toMatchObject({
      name: "fake",
      locate: { kind: "path", value: "/bin/echo" },
      runsTurn: false,
      reply: "stdout",
      cwd: "run",
      discover: { parse: { format: "tsv", skipLines: 0 } },
    });
    const minimal = validateManifest(
      manifest({ reply: undefined, cwd: undefined }),
    );
    expect(minimal).toMatchObject({ reply: "none", cwd: "run" });
  });

  test("classifies locate as binary name, path or glob", () => {
    expect(
      validateManifest(manifest({ locate: "opencode-cli" })).locate,
    ).toEqual({ kind: "binary", value: "opencode-cli" });
    expect(validateManifest(manifest({ locate: "~/a/*/b" })).locate.kind).toBe(
      "glob",
    );
    expect(validateManifest(manifest({ locate: "~/a/b" })).locate.kind).toBe(
      "path",
    );
  });

  test("accepts a json discover rule with dotted paths", () => {
    const parsed = validateManifest(
      manifest({
        discover: {
          argv: ["{bin}", "ls", "--json"],
          parse: {
            format: "json",
            items: "data.sessions",
            fields: { id: "id", title: "name", updated: "time.updated" },
          },
        },
      }),
    );
    expect(parsed.discover.parse).toEqual({
      format: "json",
      items: ["data", "sessions"],
      fields: { id: ["id"], title: ["name"], updated: ["time", "updated"] },
    });
  });

  test("names the field when a required one is missing or mistyped", () => {
    expect(refusal(manifest({ name: undefined }))).toContain("name:");
    expect(refusal(manifest({ runs_turn: undefined }))).toContain(
      "runs_turn: is required",
    );
    expect(refusal(manifest({ runs_turn: "yes" }))).toContain("runs_turn");
    expect(refusal(manifest({ send: undefined }))).toContain("send:");
    expect(refusal("nope")).toContain("manifest: must be a mapping");
  });

  test("rejects unknown fields so a typo is not silently ignored", () => {
    expect(refusal(manifest({ runsturn: true }))).toContain(
      "manifest.runsturn",
    );
    expect(
      refusal(
        manifest({
          send: { argv: ["{bin}", "{session}", "{message}"], shell: true },
        }),
      ),
    ).toContain("send.shell");
  });

  test("rejects reserved and malformed names", () => {
    expect(refusal(manifest({ name: "codex" }))).toContain("reserved");
    expect(refusal(manifest({ name: "Open Code" }))).toContain("lowercase");
  });

  test("rejects a locate that is neither a name, an absolute path nor ~/", () => {
    expect(refusal(manifest({ locate: "./bin/tool" }))).toContain("locate");
  });

  test("templates must start with {bin}", () => {
    expect(
      refusal(manifest({ send: { argv: ["sh", "{session}", "{message}"] } })),
    ).toContain('send.argv[0]: must be exactly "{bin}"');
    expect(
      refusal(manifest({ send: { argv: ["{message}", "{session}"] } })),
    ).toContain("send.argv[0]");
  });

  test("a placeholder must be a whole argument, never part of a string", () => {
    const error = refusal(
      manifest({ send: { argv: ["{bin}", "--to={session}", "{message}"] } }),
    );
    expect(error).toContain("send.argv[1]");
    expect(error).toContain("whole argument");
    expect(error).toContain("never put through a shell");
  });

  test("rejects an unknown or unavailable placeholder", () => {
    expect(
      refusal(manifest({ send: { argv: ["{bin}", "{sesion}", "{message}"] } })),
    ).toContain("unknown placeholder {sesion}");
    expect(
      refusal(
        manifest({
          discover: {
            argv: ["{bin}", "{message}"],
            parse: { format: "tsv", columns: ["id"] },
          },
        }),
      ),
    ).toContain("unknown placeholder {message}");
  });

  test("send must carry both the session and the message", () => {
    expect(
      refusal(manifest({ send: { argv: ["{bin}", "run", "{message}"] } })),
    ).toContain("{session}");
    expect(
      refusal(manifest({ send: { argv: ["{bin}", "run", "{session}"] } })),
    ).toContain("{message}");
  });

  test("tsv columns need exactly one id and known names", () => {
    const rule = (parse: unknown) =>
      refusal(manifest({ discover: { argv: ["{bin}", "ls"], parse } }));
    expect(rule({ format: "tsv", columns: ["title"] })).toContain(
      "id exactly once",
    );
    expect(rule({ format: "tsv", columns: ["id", "id"] })).toContain(
      "id exactly once",
    );
    expect(rule({ format: "tsv", columns: ["id", "name"] })).toContain(
      "columns[1]",
    );
    expect(rule({ format: "tsv" })).toContain("discover.parse.columns");
    expect(rule({ format: "tsv", columns: ["id"], items: "x" })).toContain(
      "format json only",
    );
  });

  test("json rule needs an id path made of plain keys", () => {
    const rule = (parse: unknown) =>
      refusal(manifest({ discover: { argv: ["{bin}", "ls"], parse } }));
    expect(rule({ format: "json", fields: {} })).toContain(
      "discover.parse.fields.id",
    );
    expect(rule({ format: "json", fields: { id: "a b" } })).toContain(
      "dotted path",
    );
    expect(rule({ format: "json", fields: { id: "$.id" } })).toContain(
      "dotted path",
    );
  });
});

describe("manifestDirectory", () => {
  test("honors an absolute XDG_CONFIG_HOME", () => {
    expect(manifestDirectory({ XDG_CONFIG_HOME: "/x" }, "/h")).toBe(
      "/x/agentplus/harnesses",
    );
  });

  test("falls back to ~/.config when unset, blank or relative", () => {
    for (const XDG_CONFIG_HOME of [undefined, " ", "relative"]) {
      expect(manifestDirectory({ XDG_CONFIG_HOME }, "/h")).toBe(
        "/h/.config/agentplus/harnesses",
      );
    }
  });
});

describe("loadManifests", () => {
  async function directory(files: Record<string, string>): Promise<string> {
    const { root, manifestDir } = await fakeHarness("agentplus-manifests-");
    roots.push(root);
    await mkdir(manifestDir, { recursive: true });
    for (const [name, body] of Object.entries(files))
      await writeFile(join(manifestDir, name), body);
    return manifestDir;
  }

  test("an absent directory is simply empty", async () => {
    expect(await loadManifests("/nonexistent/agentplus-test")).toEqual([]);
  });

  test("loads yaml and json, reporting a broken file without hiding the rest", async () => {
    const dir = await directory({
      "fake.json": JSON.stringify(manifest()),
      "yamlish.yaml": [
        "name: yamlish",
        "locate: /bin/echo",
        "discover:",
        '  argv: ["{bin}", "ls"]',
        "  parse: { format: tsv, columns: [id] }",
        "send:",
        '  argv: ["{bin}", "{session}", "{message}"]',
        "runs_turn: false",
        "",
      ].join("\n"),
      "broken.yaml": "name: broken\nlocate: [unclosed",
      "badfield.json": JSON.stringify({
        ...manifest({ name: "badfield" }),
        runs_turn: 1,
      }),
      "notes.txt": "ignored",
    });
    const loaded = await loadManifests(dir);
    expect(loaded.map((entry) => entry.name)).toEqual([
      "badfield",
      "broken",
      "fake",
      "yamlish",
    ]);
    const byName = Object.fromEntries(loaded.map((e) => [e.name, e]));
    expect(byName.fake?.manifest?.name).toBe("fake");
    expect(byName.yamlish?.manifest?.runsTurn).toBe(false);
    expect(byName.broken?.error).toContain("not valid YAML");
    expect(byName.badfield?.error).toContain("runs_turn");
  });

  test("the name inside must match the file name", async () => {
    const dir = await directory({
      "other.json": JSON.stringify(manifest({ name: "fake" })),
    });
    const [entry] = await loadManifests(dir);
    expect(entry?.error).toContain('must match the file name "other"');
  });

  test("a name defined by two files is flagged rather than picked", async () => {
    const dir = await directory({
      "fake.json": JSON.stringify(manifest()),
      "fake.yaml": "name: fake",
    });
    const loaded = await loadManifests(dir);
    expect(loaded).toHaveLength(2);
    expect(loaded.filter((entry) => entry.error)).toHaveLength(1);
  });

  test("a json file that is not json reports a clear error", async () => {
    const dir = await directory({ "fake.json": "{nope" });
    const [entry] = await loadManifests(dir);
    expect(entry?.error).toContain("not valid JSON");
  });
});

test("the shipped OpenCode example is a valid manifest", async () => {
  const path = join(import.meta.dir, "../examples/harnesses/opencode.yaml");
  const parsed = validateManifest(
    parseManifestText(await Bun.file(path).text(), path),
  );
  expect(parsed).toMatchObject({
    name: "opencode",
    runsTurn: true,
    locate: { kind: "glob" },
    send: { argv: ["{bin}", "run", "-s", "{session}", "{message}"] },
  });
});

describe("health", () => {
  test("accepts a literal program or {bin} and keeps it", () => {
    const curl = ["curl", "-sf", "-m", "5", "http://localhost:8888/v1/models"];
    expect(validateManifest(manifest({ health: curl })).health).toEqual(curl);
    expect(
      validateManifest(manifest({ health: ["{bin}", "ping"] })).health,
    ).toEqual(["{bin}", "ping"]);
    expect(validateManifest(manifest()).health).toBeUndefined();
  });

  test("rejects a placeholder program, message placeholders and bad shapes", () => {
    for (const health of [
      ["{session}", "x"],
      ["{bin}", "{message}"],
      ["curl", "http://{cwd}/x"],
      [],
      "curl -sf",
      ["curl", ""],
    ]) {
      expect(() => validateManifest(manifest({ health }))).toThrow(/health/);
    }
  });
});
