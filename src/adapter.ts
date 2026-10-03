import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { formatAddress, parseAddress } from "./addresses";
import type { Env } from "./env";
import { BridgeError } from "./errors";
import type { HarnessManifest, Locate, ParseRule } from "./manifest";
import {
  NativeCommandError,
  nativeProcessRunner,
  type ProcessRunner,
} from "./process";
import { redactText, truncateText } from "./safety";

const TITLE_LIMIT_BYTES = 200;
const REPLY_LIMIT_BYTES = 4_000;
const GLOB_CHARACTERS = /[*?[]/;

export interface DiscoveredSession {
  id: string;
  address: string;
  title?: string;
  updated?: string;
}

/**
 * Fills a template. A placeholder is a whole argument by construction (the
 * manifest validator enforces it), and its value replaces that one element,
 * so whatever the value contains stays a single literal argument.
 */
export function expandTemplate(
  argv: string[],
  values: Record<string, string>,
): string[] {
  return argv.map((arg) => {
    const name = /^\{([a-z_]+)\}$/.exec(arg)?.[1];
    if (name === undefined) return arg;
    const value = values[name];
    if (value === undefined)
      throw new Error(`template needs {${name}} but no value was given`);
    return value;
  });
}

function expandHome(path: string, home: string): string {
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function newestMatch(pattern: string): Promise<string | undefined> {
  const segments = pattern.split("/");
  const firstGlob = segments.findIndex((segment) =>
    GLOB_CHARACTERS.test(segment),
  );
  const root = segments.slice(0, firstGlob).join("/") || "/";
  const rest = segments.slice(firstGlob).join("/");
  const found: Array<{ path: string; modified: number }> = [];
  try {
    for await (const path of new Bun.Glob(rest).scan({
      cwd: root,
      absolute: true,
      onlyFiles: true,
    })) {
      if (!(await executable(path))) continue;
      found.push({ path, modified: (await stat(path)).mtimeMs });
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
  found.sort((a, b) => b.modified - a.modified || (a.path < b.path ? 1 : -1));
  return found[0]?.path;
}

/**
 * Resolves a harness binary. A glob picks the newest match, which is how a
 * desktop app's versioned CLI directory is followed across updates.
 */
export async function locateBinary(
  locate: Locate,
  options: { env?: Env; home?: string } = {},
): Promise<string | undefined> {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  if (locate.kind === "binary")
    return (
      Bun.which(locate.value, {
        ...(env.PATH !== undefined ? { PATH: env.PATH } : {}),
      }) ?? undefined
    );
  const expanded = expandHome(locate.value, home);
  if (locate.kind === "path")
    return (await executable(expanded)) ? expanded : undefined;
  return newestMatch(expanded);
}

function lookup(value: unknown, path: string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function scalar(value: unknown): string | undefined {
  if (typeof value === "string") return value === "" ? undefined : value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function describe(
  harness: string,
  id: string | undefined,
  title: string | undefined,
  updated: string | undefined,
  where: string,
): DiscoveredSession {
  if (id === undefined) throw new Error(`${where} has no session id`);
  let address: string;
  try {
    address = formatAddress(parseAddress(`${harness}:${id}`));
  } catch {
    throw new Error(
      `${where} has session id "${id}", which cannot be used in an address (letters, digits, . _ - only)`,
    );
  }
  return {
    id,
    address,
    ...(title ? { title: truncateText(title, TITLE_LIMIT_BYTES) } : {}),
    ...(updated ? { updated } : {}),
  };
}

export function parseSessions(
  harness: string,
  output: string,
  rule: ParseRule,
): DiscoveredSession[] {
  if (rule.format === "tsv") {
    const lines = output.split("\n").slice(rule.skipLines);
    return lines.flatMap((raw, index) => {
      const line = raw.replace(/\r$/, "");
      if (line.trim() === "") return [];
      const cells = line.split("\t");
      const where = `discover output line ${index + 1 + rule.skipLines}`;
      if (cells.length < rule.columns.length)
        throw new Error(
          `${where} has ${cells.length} tab-separated columns, expected ${rule.columns.length}`,
        );
      const cell = (name: string) => {
        const value = cells[rule.columns.indexOf(name as never)]?.trim();
        return value === "" ? undefined : value;
      };
      return [
        describe(harness, cell("id"), cell("title"), cell("updated"), where),
      ];
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("discover output is not valid JSON");
  }
  const items = lookup(parsed, rule.items);
  if (!Array.isArray(items))
    throw new Error(
      `discover output has no list at "${rule.items.join(".") || "(top level)"}"`,
    );
  return items.map((item, index) =>
    describe(
      harness,
      scalar(lookup(item, rule.fields.id)),
      rule.fields.title ? scalar(lookup(item, rule.fields.title)) : undefined,
      rule.fields.updated
        ? scalar(lookup(item, rule.fields.updated))
        : undefined,
      `discover item ${index + 1}`,
    ),
  );
}

function childOptions(manifest: HarnessManifest, cwd: string) {
  return manifest.cwd === "run" ? { cwd } : {};
}

async function runAdapter(
  runner: ProcessRunner,
  argv: string[],
  options: { cwd?: string },
): Promise<string> {
  try {
    return (await runner.run(argv, options)).stdout;
  } catch (error) {
    if (error instanceof NativeCommandError)
      throw new Error(redactText(error.message));
    throw error;
  }
}

export async function discoverSessions(
  manifest: HarnessManifest,
  binary: string,
  options: { cwd?: string; runner?: ProcessRunner } = {},
): Promise<DiscoveredSession[]> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const stdout = await runAdapter(
    options.runner ?? nativeProcessRunner,
    expandTemplate(manifest.discover.argv, { bin: binary, cwd }),
    childOptions(manifest, cwd),
  );
  return parseSessions(manifest.name, stdout, manifest.discover.parse);
}

/**
 * A message that begins with `-` would be read as an option by the harness CLI.
 * It is refused unless the template puts a literal `--` ahead of the message,
 * which is the manifest author saying the CLI treats what follows as data.
 */
function guardMessage(manifest: HarnessManifest, message: string): void {
  if (message.includes("\0"))
    throw new Error("a message cannot contain a NUL byte");
  if (!message.startsWith("-")) return;
  const argv = manifest.send.argv;
  const separator = argv.indexOf("--");
  if (separator >= 0 && separator < argv.indexOf("{message}")) return;
  throw new Error(
    `the message starts with "-", which ${manifest.name} would read as an option; reword it, or add a literal "--" before {message} in the ${manifest.name} manifest if its CLI supports that`,
  );
}

export interface AdapterSend {
  session: string;
  message: string;
  cwd?: string;
}

export async function sendThroughAdapter(
  manifest: HarnessManifest,
  binary: string,
  input: AdapterSend,
  runner: ProcessRunner = nativeProcessRunner,
): Promise<{ reply?: string }> {
  guardMessage(manifest, input.message);
  const cwd = resolve(input.cwd ?? process.cwd());
  const stdout = await runAdapter(
    runner,
    expandTemplate(manifest.send.argv, {
      bin: binary,
      session: input.session,
      message: input.message,
      cwd,
    }),
    childOptions(manifest, cwd),
  );
  if (manifest.reply !== "stdout") return {};
  const reply = truncateText(redactText(stdout.trim()), REPLY_LIMIT_BYTES);
  return reply === "" ? {} : { reply };
}

/**
 * Runs the manifest's optional health command. Any failure to start it or a
 * non-zero exit counts as unhealthy, so a harness that cannot take a turn is
 * refused before anything is sent to it.
 */
export async function checkHealth(
  manifest: HarnessManifest,
  binary: string,
  options: { cwd?: string; runner?: ProcessRunner } = {},
): Promise<void> {
  if (!manifest.health) return;
  const cwd = resolve(options.cwd ?? process.cwd());
  try {
    await (options.runner ?? nativeProcessRunner).run(
      expandTemplate(manifest.health, { bin: binary, cwd }),
      childOptions(manifest, cwd),
    );
  } catch (error) {
    const detail = redactText(
      error instanceof Error ? error.message : "health command failed",
    );
    throw new BridgeError(
      "harness_unhealthy",
      `${manifest.name}: health check failed, so nothing was sent (${detail})`,
    );
  }
}
