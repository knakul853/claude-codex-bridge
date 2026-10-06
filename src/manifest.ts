import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join } from "node:path";
import { isHarnessName } from "./addresses";
import type { Env } from "./env";
import { absent } from "./store";

const MAX_MANIFEST_BYTES = 64 * 1024;
const RESERVED_NAMES = ["claude", "codex", "broadcast"];
const MANIFEST_EXTENSIONS = [".yaml", ".yml", ".json"];

export const DISCOVER_COLUMNS = ["id", "title", "updated", "skip"] as const;
type DiscoverColumn = (typeof DISCOVER_COLUMNS)[number];

export interface Locate {
  kind: "binary" | "glob" | "path";
  value: string;
}

export type ParseRule =
  | { format: "tsv"; columns: DiscoverColumn[]; skipLines: number }
  | {
      format: "json";
      items: string[];
      fields: { id: string[]; title?: string[]; updated?: string[] };
    };

export interface HarnessManifest {
  name: string;
  locate: Locate;
  discover: { argv: string[]; parse: ParseRule };
  send: { argv: string[] };
  /** Run before a send; a non-zero exit means the harness cannot take a turn. */
  health?: string[];
  reply: "stdout" | "none";
  runsTurn: boolean;
  cwd: "run" | "none";
}

export interface LoadedManifest {
  /** File stem; the harness name the file claims. */
  name: string;
  path: string;
  manifest?: HarnessManifest;
  error?: string;
}

export class ManifestError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(`${field}: ${message}`);
    this.name = "ManifestError";
  }
}

type Fields = Record<string, unknown>;

const PLACEHOLDER = /\{[^{}]*\}/g;
const DISCOVER_PLACEHOLDERS = ["bin", "cwd"];
const HEALTH_PLACEHOLDERS = ["bin", "cwd"];
const SEND_PLACEHOLDERS = ["bin", "session", "message", "cwd"];

function fields(value: unknown, field: string, known: string[]): Fields {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ManifestError(field, "must be a mapping");
  const record = value as Fields;
  for (const key of Object.keys(record)) {
    if (!known.includes(key))
      throw new ManifestError(
        `${field}.${key}`,
        `unknown field (expected one of ${known.join(", ")})`,
      );
  }
  return record;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new ManifestError(field, "must be a non-empty string");
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 0)
    throw new ManifestError(field, "must be a whole number, 0 or more");
  return value as number;
}

function choice<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
  fallback: T,
): T {
  if (value === undefined) return fallback;
  if (
    typeof value === "string" &&
    (allowed as readonly string[]).includes(value)
  )
    return value as T;
  throw new ManifestError(field, `must be one of ${allowed.join(", ")}`);
}

function locate(value: unknown): Locate {
  const raw = text(value, "locate").trim();
  if (!raw.includes("/") && !raw.startsWith("~") && !/[*?[]/.test(raw))
    return { kind: "binary", value: raw };
  if (!raw.startsWith("/") && !raw.startsWith("~/"))
    throw new ManifestError(
      "locate",
      `"${raw}" must be a bare binary name, an absolute path or glob, or start with ~/`,
    );
  return { kind: /[*?[]/.test(raw) ? "glob" : "path", value: raw };
}

/**
 * A template is an argv array. The first element is always `{bin}`, so
 * neither a session id nor a message can ever name the program. Every other
 * placeholder must be a whole argument: the value then reaches the harness as
 * exactly one argument, never through a shell and never glued into a longer
 * string.
 */
function template(
  value: unknown,
  field: string,
  allowed: string[],
  required: string[],
  literalProgram = false,
): string[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new ManifestError(field, "must be a non-empty list of arguments");
  const argv = value.map((item, index) => {
    if (typeof item !== "string" || item === "")
      throw new ManifestError(
        `${field}[${index}]`,
        "must be a non-empty string",
      );
    return item;
  });
  if (argv[0] !== "{bin}" && !(literalProgram && !/[{}]/.test(argv[0] ?? "{")))
    throw new ManifestError(
      `${field}[0]`,
      literalProgram
        ? 'must be "{bin}" or a literal program name without placeholders'
        : 'must be exactly "{bin}"',
    );
  argv.forEach((arg, index) => {
    const found = arg.match(PLACEHOLDER) ?? [];
    if (found.length === 0 && !/[{}]/.test(arg)) return;
    const name = found.length === 1 ? found[0]?.slice(1, -1) : undefined;
    if (found.length !== 1 || arg !== `{${name}}`)
      throw new ManifestError(
        `${field}[${index}]`,
        `a placeholder must be a whole argument, not part of "${arg}"; the value is passed as a single argument and is never put through a shell`,
      );
    if (!name || !allowed.includes(name))
      throw new ManifestError(
        `${field}[${index}]`,
        `unknown placeholder {${name}} (allowed: ${allowed.map((a) => `{${a}}`).join(", ")})`,
      );
  });
  for (const name of required) {
    if (!argv.includes(`{${name}}`))
      throw new ManifestError(field, `must contain {${name}} as an argument`);
  }
  return argv;
}

function path(value: unknown, field: string): string[] {
  const raw = text(value, field);
  const segments = raw.split(".");
  if (segments.some((segment) => !/^[A-Za-z0-9_-]+$/.test(segment)))
    throw new ManifestError(
      field,
      `"${raw}" is not a dotted path of plain keys (for example time.updated)`,
    );
  return segments;
}

function parseRule(value: unknown): ParseRule {
  const rule = fields(value, "discover.parse", [
    "format",
    "columns",
    "skip_lines",
    "items",
    "fields",
  ]);
  const format = choice(
    rule.format,
    "discover.parse.format",
    ["tsv", "json"] as const,
    "tsv",
  );
  if (format === "tsv") {
    for (const key of ["items", "fields"]) {
      if (rule[key] !== undefined)
        throw new ManifestError(
          `discover.parse.${key}`,
          "applies to format json only",
        );
    }
    if (!Array.isArray(rule.columns) || rule.columns.length === 0)
      throw new ManifestError(
        "discover.parse.columns",
        `must list the tab-separated columns, each one of ${DISCOVER_COLUMNS.join(", ")}`,
      );
    const columns = rule.columns.map((column, index) =>
      choice(
        column,
        `discover.parse.columns[${index}]`,
        DISCOVER_COLUMNS,
        "skip",
      ),
    );
    if (columns.filter((column) => column === "id").length !== 1)
      throw new ManifestError(
        "discover.parse.columns",
        "must contain id exactly once",
      );
    for (const name of ["title", "updated"] as const) {
      if (columns.filter((column) => column === name).length > 1)
        throw new ManifestError(
          "discover.parse.columns",
          `${name} appears more than once`,
        );
    }
    return {
      format: "tsv",
      columns,
      skipLines:
        rule.skip_lines === undefined
          ? 0
          : nonNegativeInteger(rule.skip_lines, "discover.parse.skip_lines"),
    };
  }
  for (const key of ["columns", "skip_lines"]) {
    if (rule[key] !== undefined)
      throw new ManifestError(
        `discover.parse.${key}`,
        "applies to format tsv only",
      );
  }
  const mapped = fields(rule.fields, "discover.parse.fields", [
    "id",
    "title",
    "updated",
  ]);
  return {
    format: "json",
    items:
      rule.items === undefined ? [] : path(rule.items, "discover.parse.items"),
    fields: {
      id: path(mapped.id, "discover.parse.fields.id"),
      ...(mapped.title !== undefined
        ? { title: path(mapped.title, "discover.parse.fields.title") }
        : {}),
      ...(mapped.updated !== undefined
        ? { updated: path(mapped.updated, "discover.parse.fields.updated") }
        : {}),
    },
  };
}

export function validateManifest(value: unknown): HarnessManifest {
  const record = fields(value, "manifest", [
    "name",
    "locate",
    "discover",
    "send",
    "health",
    "reply",
    "runs_turn",
    "cwd",
  ]);
  const name = text(record.name, "name");
  if (!isHarnessName(name))
    throw new ManifestError(
      "name",
      `"${name}" must be lowercase letters, digits, - or _, starting with a letter`,
    );
  if (RESERVED_NAMES.includes(name))
    throw new ManifestError("name", `"${name}" is reserved for a built-in`);
  if (typeof record.runs_turn !== "boolean")
    throw new ManifestError(
      "runs_turn",
      "is required and must be true or false: say whether a send starts a model turn",
    );
  const discover = fields(record.discover, "discover", ["argv", "parse"]);
  const send = fields(record.send, "send", ["argv"]);
  const health =
    record.health === undefined
      ? undefined
      : template(record.health, "health", HEALTH_PLACEHOLDERS, [], true);
  return {
    name,
    locate: locate(record.locate),
    discover: {
      argv: template(discover.argv, "discover.argv", DISCOVER_PLACEHOLDERS, []),
      parse: parseRule(discover.parse),
    },
    send: {
      argv: template(send.argv, "send.argv", SEND_PLACEHOLDERS, [
        "session",
        "message",
      ]),
    },
    ...(health ? { health } : {}),
    reply: choice(record.reply, "reply", ["stdout", "none"] as const, "none"),
    runsTurn: record.runs_turn,
    cwd: choice(record.cwd, "cwd", ["run", "none"] as const, "run"),
  };
}

export function parseManifestText(source: string, file: string): unknown {
  try {
    return extname(file) === ".json"
      ? JSON.parse(source)
      : (Bun.YAML.parse(source) as unknown);
  } catch (error) {
    throw new ManifestError(
      "manifest",
      `not valid ${extname(file) === ".json" ? "JSON" : "YAML"}: ${error instanceof Error ? error.message : "unreadable"}`,
    );
  }
}

export function manifestDirectory(
  env: Env = process.env,
  home: string = homedir(),
): string {
  const configured = env.XDG_CONFIG_HOME?.trim();
  const base =
    configured && isAbsolute(configured) ? configured : join(home, ".config");
  return join(base, "agentplus", "harnesses");
}

async function loadOne(path: string): Promise<LoadedManifest> {
  const stem = basename(path, extname(path));
  const entry: LoadedManifest = { name: stem, path };
  try {
    const file = Bun.file(path);
    if (file.size > MAX_MANIFEST_BYTES)
      throw new ManifestError("manifest", "is larger than 64 KiB");
    const manifest = validateManifest(
      parseManifestText(await file.text(), path),
    );
    if (manifest.name !== stem)
      throw new ManifestError(
        "name",
        `"${manifest.name}" must match the file name "${stem}"`,
      );
    return { ...entry, manifest };
  } catch (error) {
    return {
      ...entry,
      error: error instanceof Error ? error.message : "unreadable manifest",
    };
  }
}

/**
 * Every manifest in the directory, valid or not: a broken file is reported by
 * `harnesses` rather than hiding the others or being silently skipped.
 */
export async function loadManifests(
  directory: string = manifestDirectory(),
): Promise<LoadedManifest[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (absent(error)) return [];
    throw error;
  }
  const files = names
    .filter((name) => MANIFEST_EXTENSIONS.includes(extname(name)))
    .sort();
  const loaded: LoadedManifest[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const entry = await loadOne(join(directory, file));
    if (seen.has(entry.name)) {
      loaded.push({
        name: entry.name,
        path: entry.path,
        error: `${entry.name} is defined by more than one file; keep one`,
      });
      continue;
    }
    seen.add(entry.name);
    loaded.push(entry);
  }
  return loaded;
}
