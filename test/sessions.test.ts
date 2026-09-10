import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findClaudeSessions,
  listClaudeSessions,
  pushToSession,
} from "../src/sessions";

const roots: string[] = [];
const sessionA = "11111111-1111-4111-8111-111111111111";
const sessionB = "22222222-2222-4222-8222-222222222222";

async function registry(
  records: Array<Record<string, unknown>>,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bridge-sessions-"));
  roots.push(root);
  for (const record of records) {
    await writeFile(
      join(root, `${record.pid}.json`),
      JSON.stringify(record),
      "utf8",
    );
  }
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe("claude session discovery", () => {
  test("reads the published records", async () => {
    const root = await registry([
      {
        pid: 101,
        sessionId: sessionA,
        cwd: "/repo/aurora",
        kind: "interactive",
        status: "idle",
        name: "aurora work",
      },
    ]);
    const sessions = await listClaudeSessions(root);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe(sessionA);
    expect(sessions[0]?.kind).toBe("interactive");
  });

  test("returns nothing when the registry is absent", async () => {
    expect(await listClaudeSessions("/nonexistent/sessions")).toEqual([]);
  });

  test("skips a record being rewritten instead of failing the listing", async () => {
    const root = await registry([
      { pid: 101, sessionId: sessionA, cwd: "/repo/a", kind: "interactive" },
    ]);
    await writeFile(join(root, "102.json"), '{"pid":102,"sess', "utf8");
    expect(await listClaudeSessions(root)).toHaveLength(1);
  });

  test("ignores a record missing the fields routing depends on", async () => {
    const root = await registry([
      { pid: 101, cwd: "/repo/a", kind: "interactive" },
    ]);
    expect(await listClaudeSessions(root)).toEqual([]);
  });

  test("finds a session by the directory it is working in", async () => {
    const root = await registry([
      {
        pid: 101,
        sessionId: sessionA,
        cwd: "/repo/aurora",
        kind: "interactive",
      },
      {
        pid: 102,
        sessionId: sessionB,
        cwd: "/repo/platform",
        kind: "interactive",
      },
    ]);
    const found = await findClaudeSessions({ cwd: "/repo/platform" }, root);
    expect(found.map((s) => s.sessionId)).toEqual([sessionB]);
  });

  test("normalises the directory before comparing it", async () => {
    const root = await registry([
      {
        pid: 101,
        sessionId: sessionA,
        cwd: "/repo/aurora",
        kind: "interactive",
      },
    ]);
    const found = await findClaudeSessions(
      { cwd: "/repo/aurora/../aurora" },
      root,
    );
    expect(found.map((s) => s.sessionId)).toEqual([sessionA]);
  });

  test("reports every session sharing a directory so the caller can disambiguate", async () => {
    const root = await registry([
      { pid: 101, sessionId: sessionA, cwd: "/repo/a", kind: "interactive" },
      { pid: 102, sessionId: sessionB, cwd: "/repo/a", kind: "background" },
    ]);
    expect(await findClaudeSessions({ cwd: "/repo/a" }, root)).toHaveLength(2);
  });
});

describe("pushToSession", () => {
  test("declines a session that publishes no socket", async () => {
    const result = await pushToSession(
      { pid: 101, sessionId: sessionA, cwd: "/repo/a", kind: "interactive" },
      "hello",
    );
    expect(result.delivered).toBe(false);
    expect(result.detail).toMatch(/no socket/);
  });

  test("declines when no peer key has been published", async () => {
    const root = await registry([
      { pid: 101, sessionId: sessionA, cwd: "/repo/a", kind: "interactive" },
    ]);
    const result = await pushToSession(
      {
        pid: 101,
        sessionId: sessionA,
        cwd: "/repo/a",
        kind: "interactive",
        messagingSocketPath: join(root, "missing.sock"),
      },
      "hello",
      1_000,
      root,
    );
    expect(result.delivered).toBe(false);
    expect(result.detail).toMatch(/no peer key/);
  });

  test("refuses a key whose process start no longer matches the record", async () => {
    const root = await registry([]);
    await writeFile(
      join(root, "101.abcdef.key"),
      JSON.stringify({ peerToken: "t", procStart: "Mon Jan 1 00:00:00 2020" }),
      "utf8",
    );
    const result = await pushToSession(
      {
        pid: 101,
        sessionId: sessionA,
        cwd: "/repo/a",
        kind: "interactive",
        procStart: "Thu Sep 10 17:53:59 2026",
        messagingSocketPath: join(root, "s.sock"),
      },
      "hello",
      1_000,
      root,
    );
    expect(result.delivered).toBe(false);
    expect(result.detail).toMatch(/stale/);
  });

  test("reports a failure rather than throwing when the socket is dead", async () => {
    const root = await registry([]);
    await writeFile(
      join(root, "101.abcdef.key"),
      JSON.stringify({ peerToken: "t" }),
      "utf8",
    );
    const result = await pushToSession(
      {
        pid: 101,
        sessionId: sessionA,
        cwd: "/repo/a",
        kind: "interactive",
        messagingSocketPath: join(root, "dead.sock"),
      },
      "hello",
      1_000,
      root,
    );
    expect(result.delivered).toBe(false);
    expect(result.detail).toBeDefined();
  });
});
