import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newestStateDatabase, SqliteThreadStore } from "../src/threads";

const roots: string[] = [];

interface ThreadRow {
  id: string;
  name?: string | null;
  title?: string | null;
  first?: string | null;
  cwd: string;
  updated: number;
  archived?: number;
}

async function stateDatabase(
  rows: ThreadRow[],
  projects: Array<{ id: string; name: string; path: string }> = [],
  fileName = "state_5.sqlite",
): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "bridge-threads-"));
  roots.push(home);
  const db = new Database(join(home, fileName));
  db.run(
    `create table threads (id text, name text, title text, first_user_message text,
       cwd text, updated_at_ms integer, rollout_path text, archived integer)`,
  );
  db.run("create table projects (id text, name text, position integer)");
  db.run(
    "create table project_roots (project_id text, path text, position integer)",
  );
  for (const row of rows) {
    db.run(
      `insert into threads (id, name, title, first_user_message, cwd, updated_at_ms, rollout_path, archived)
       values (?, ?, ?, ?, ?, ?, null, ?)`,
      [
        row.id,
        row.name ?? null,
        row.title ?? null,
        row.first ?? null,
        row.cwd,
        row.updated,
        row.archived ?? 0,
      ],
    );
  }
  for (const [index, project] of projects.entries()) {
    db.run("insert into projects (id, name, position) values (?, ?, ?)", [
      project.id,
      project.name,
      index,
    ]);
    db.run(
      "insert into project_roots (project_id, path, position) values (?, ?, 0)",
      [project.id, project.path],
    );
  }
  db.close();
  return home;
}

afterEach(async () => {
  for (const home of roots.splice(0))
    await rm(home, { recursive: true, force: true });
});

describe("newestStateDatabase", () => {
  test("selects the highest schema version rather than a pinned one", async () => {
    const home = await stateDatabase([], [], "state_5.sqlite");
    new Database(join(home, "state_11.sqlite")).close();
    new Database(join(home, "state_9.sqlite")).close();
    expect(newestStateDatabase(home)).toBe(join(home, "state_11.sqlite"));
  });

  test("says so when Codex has published no state file", async () => {
    const home = await mkdtemp(join(tmpdir(), "bridge-threads-empty-"));
    roots.push(home);
    expect(() => newestStateDatabase(home)).toThrow(/no state_<n>\.sqlite/);
  });
});

describe("thread labels", () => {
  test("bounds a title that holds an entire generated prompt", async () => {
    const home = await stateDatabase([
      {
        id: "t1",
        title: "x".repeat(9_000),
        cwd: "/repo/a",
        updated: 10,
      },
    ]);
    const [thread] = SqliteThreadStore.open(home).threads();
    // An unbounded label floods every caller's output, and a Claude caller's
    // context along with it.
    expect(thread?.label.length).toBe(120);
  });

  test("flattens newlines so one thread stays one line", async () => {
    const home = await stateDatabase([
      {
        id: "t1",
        title: "first\nsecond\r\nthird",
        cwd: "/repo/a",
        updated: 10,
      },
    ]);
    const [thread] = SqliteThreadStore.open(home).threads();
    expect(thread?.label).not.toContain("\n");
    expect(thread?.label).toBe("first second  third");
  });

  test("prefers a name, then a title, then the opening message", async () => {
    const home = await stateDatabase([
      { id: "named", name: "chosen", title: "ignored", cwd: "/r", updated: 3 },
      { id: "titled", title: "fallback", cwd: "/r", updated: 2 },
      { id: "bare", first: "opening words", cwd: "/r", updated: 1 },
    ]);
    const labels = SqliteThreadStore.open(home)
      .threads()
      .map((thread) => thread.label);
    expect(labels).toEqual(["chosen", "fallback", "opening words"]);
  });

  test("names an untitled thread instead of returning an empty label", async () => {
    const home = await stateDatabase([
      { id: "t1", name: "", title: "", first: "", cwd: "/r", updated: 1 },
    ]);
    expect(SqliteThreadStore.open(home).threads()[0]?.label).toBe("(untitled)");
  });
});

describe("thread selection", () => {
  test("returns newest first", async () => {
    const home = await stateDatabase([
      { id: "old", name: "old", cwd: "/r", updated: 1 },
      { id: "new", name: "new", cwd: "/r", updated: 99 },
    ]);
    expect(
      SqliteThreadStore.open(home)
        .threads()
        .map((t) => t.id),
    ).toEqual(["new", "old"]);
  });

  test("filters to the given directories", async () => {
    const home = await stateDatabase([
      { id: "a", name: "a", cwd: "/repo/aurora", updated: 2 },
      { id: "b", name: "b", cwd: "/repo/platform", updated: 1 },
    ]);
    expect(
      SqliteThreadStore.open(home)
        .threads({ roots: ["/repo/platform"] })
        .map((t) => t.id),
    ).toEqual(["b"]);
  });

  test("hides archived threads", async () => {
    const home = await stateDatabase([
      { id: "live", name: "live", cwd: "/r", updated: 2 },
      { id: "gone", name: "gone", cwd: "/r", updated: 3, archived: 1 },
    ]);
    expect(
      SqliteThreadStore.open(home)
        .threads()
        .map((t) => t.id),
    ).toEqual(["live"]);
  });

  test("groups a project's roots even when two projects share one", async () => {
    const home = await stateDatabase(
      [{ id: "a", name: "a", cwd: "/repo/shared", updated: 1 }],
      [
        { id: "p1", name: "aurora", path: "/repo/shared" },
        { id: "p2", name: "aurora-nuclei", path: "/repo/shared" },
      ],
    );
    const projects = SqliteThreadStore.open(home).projects();
    expect(projects.map((p) => p.name).sort()).toEqual([
      "aurora",
      "aurora-nuclei",
    ]);
    expect(projects.every((p) => p.roots.includes("/repo/shared"))).toBe(true);
  });
});
