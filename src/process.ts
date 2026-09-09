export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ProcessRunner {
  run(argv: string[], options?: { cwd?: string }): Promise<ProcessResult>;
}

export class NativeCommandError extends Error {
  constructor(
    readonly argv0: string,
    readonly exitCode: number,
    readonly detail: string,
  ) {
    super(`${argv0} exited ${exitCode}${detail ? `: ${detail}` : ""}`);
  }
}

export const nativeProcessRunner: ProcessRunner = {
  async run(argv, options = {}) {
    const child = Bun.spawn(argv, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) {
      throw new NativeCommandError(
        argv[0] ?? "command",
        exitCode,
        stderr.trim(),
      );
    }
    return { stdout, stderr, exitCode };
  },
};
