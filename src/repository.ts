import { resolve } from "node:path";
import { nativeProcessRunner, type ProcessRunner } from "./process";

const CHANGED_FILE_LIMIT = 40;

export interface RepositoryState {
  root: string;
  commonDir: string;
  branch: string;
  head: string;
  clean: boolean;
  changedFiles: string[];
}

export async function readRepositoryState(
  cwd = process.cwd(),
  runner: ProcessRunner = nativeProcessRunner,
): Promise<RepositoryState> {
  const [root, common, branch, head, status] = await Promise.all([
    runner.run(["git", "-C", cwd, "rev-parse", "--show-toplevel"]),
    runner.run([
      "git",
      "-C",
      cwd,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]),
    runner.run(["git", "-C", cwd, "branch", "--show-current"]),
    runner.run(["git", "-C", cwd, "rev-parse", "HEAD"]),
    runner.run(["git", "-C", cwd, "status", "--porcelain"]),
  ]);
  return {
    root: resolve(root.stdout.trim()),
    commonDir: resolve(common.stdout.trim()),
    branch: branch.stdout.trim(),
    head: head.stdout.trim(),
    clean: status.stdout.trim().length === 0,
    changedFiles: status.stdout
      .split("\n")
      .filter(Boolean)
      .slice(0, CHANGED_FILE_LIMIT)
      .map((line) => line.slice(3, 259)),
  };
}
