#!/usr/bin/env bun
// CLI over the DeepSeek Harness desktop bridge socket, shaped for an agent+ harness manifest.
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const USAGE = `usage:
  agentplus-deepseek ping
  agentplus-deepseek sessions [cwd]           # tsv: id, title, updated
  agentplus-deepseek self [cwd]               # the running session in cwd: a DeepSeek agent's own address
  agentplus-deepseek create [cwd]             # prints the new session id
  agentplus-deepseek send <session> [--steer] [--no-wait] [--timeout <s>] -- <message>`;

export function socketPath(
  env: Record<string, string | undefined> = process.env,
): string {
  return (
    env.AGENTPLUS_DEEPSEEK_SOCKET ||
    join(env.DSH_HOME || join(homedir(), ".dsh"), "agentplus.sock")
  );
}

const MAX_SOCKET_PATH_BYTES = 103;

export function request(
  path: string,
  body: object,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  if (Buffer.byteLength(path) > MAX_SOCKET_PATH_BYTES) {
    return Promise.reject(
      new Error(`socket path is longer than the 104-byte unix limit: ${path}`),
    );
  }
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let data = "";
    let failure: Error | undefined;
    const timer = setTimeout(() => {
      failure = new Error(
        `no answer from DeepSeek Harness within ${Math.round(timeoutMs / 1000)}s`,
      );
      socket.destroy();
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(body)}\n`));
    socket.on("data", (chunk) => {
      data += chunk;
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      const down = error.code === "ENOENT" || error.code === "ECONNREFUSED";
      failure ??= new Error(
        down
          ? `DeepSeek Harness is not running or the agentplus-bridge plugin is not loaded (${path})`
          : error.message,
      );
    });
    socket.on("close", () => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(data.trim());
      } catch {
        return reject(
          new Error(`bad answer from DeepSeek Harness: ${data.slice(0, 200)}`),
        );
      }
      if (parsed.error) reject(new Error(String(parsed.error)));
      else resolve(parsed);
    });
  });
}

export interface SendArgs {
  session: string;
  message: string;
  mode: "queue" | "steer";
  wait: boolean;
  timeoutSeconds: number;
}

export function parseSend(args: string[]): SendArgs {
  const dash = args.indexOf("--");
  if (dash < 0) throw new Error("send needs `--` before the message");
  const flags = args.slice(0, dash);
  const message = args.slice(dash + 1).join(" ");
  const session = flags.shift();
  if (!session || session.startsWith("-"))
    throw new Error("send needs a session id");
  const out: SendArgs = {
    session,
    message,
    mode: "queue",
    wait: true,
    timeoutSeconds: 900,
  };
  while (flags.length) {
    const flag = flags.shift();
    if (flag === "--steer") out.mode = "steer";
    else if (flag === "--no-wait") out.wait = false;
    else if (flag === "--timeout") out.timeoutSeconds = Number(flags.shift());
    else throw new Error(`unknown flag ${flag}`);
  }
  if (!Number.isFinite(out.timeoutSeconds) || out.timeoutSeconds <= 0)
    throw new Error("--timeout must be seconds > 0");
  return out;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  const path = socketPath();
  if (command === "ping") {
    await request(path, { op: "ping" }, 5000);
    console.log("ok");
    return 0;
  }
  if (command === "sessions") {
    const { sessions } = (await request(path, { op: "list" }, 30000)) as {
      sessions: {
        id: string;
        title: string;
        cwd: string | null;
        updated: string;
      }[];
    };
    const cwd = args[0];
    for (const s of sessions) {
      if (cwd && s.cwd !== cwd) continue;
      console.log([s.id, s.title.replace(/\s+/g, " "), s.updated].join("\t"));
    }
    return 0;
  }
  if (command === "self") {
    const { sessions } = (await request(path, { op: "list" }, 30000)) as {
      sessions: { id: string; cwd: string | null; running: boolean }[];
    };
    const cwd = args[0] ?? process.cwd();
    const running = sessions.filter((s) => s.running && s.cwd === cwd);
    if (running.length !== 1)
      throw new Error(
        `${running.length} running DeepSeek sessions in ${cwd}; pass the id instead`,
      );
    console.log(`deepseek:${running[0].id}`);
    return 0;
  }
  if (command === "create") {
    const { id } = await request(path, { op: "create", cwd: args[0] }, 30000);
    console.log(id);
    return 0;
  }
  if (command === "send") {
    const send = parseSend(args);
    const timeoutMs = send.timeoutSeconds * 1000;
    const out = await request(
      path,
      { op: "send", ...send, timeoutMs },
      timeoutMs + 30000,
    );
    if (out.reason === "timeout")
      throw new Error(
        `no reply within ${send.timeoutSeconds}s; the turn may still be running`,
      );
    if (typeof out.reply === "string" && out.reply) console.log(out.reply);
    return out.reason === undefined || out.reason === "completed" ? 0 : 3;
  }
  console.error(USAGE);
  return 2;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`agentplus-deepseek: ${error.message}`);
      process.exit(1);
    },
  );
}
