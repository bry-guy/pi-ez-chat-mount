import { mkdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { ChatMountConfig } from "./config.js";
import type { RepoSpec } from "./repo-spec.js";

export type CloneOptions = {
  force: boolean;
  update: boolean;
};

export type CloneResult = {
  hostPath: string;
  cloned: boolean;
  updated: boolean;
  message: string;
};

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function runGit(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(stdout.trim());
      else reject(new Error((stderr || stdout || `git ${args.join(" ")} exited ${code}`).trim()));
    });
  });
}

function sameOrigin(actual: string, expected: string): boolean {
  const trim = (v: string) => v.replace(/\.git$/i, "").replace(/^https:\/\/github\.com\//i, "git@github.com:");
  return trim(actual) === trim(expected);
}

export async function ensureRepoClone(spec: RepoSpec, config: ChatMountConfig, options: CloneOptions): Promise<CloneResult> {
  const sourceDir = resolve(config.sourceDir);
  const destination = join(sourceDir, spec.repoName);
  if (!destination.startsWith(`${sourceDir}/`) && destination !== sourceDir) throw new Error(`Refusing unsafe clone destination: ${destination}`);

  await mkdir(sourceDir, { recursive: true });
  const exists = await pathExists(destination);
  if (exists) {
    let origin = "";
    try {
      origin = await runGit(["config", "--get", "remote.origin.url"], destination);
    } catch {
      throw new Error(`Clone destination already exists and is not a git repository with origin: ${destination}`);
    }
    if (!sameOrigin(origin, spec.cloneUrl) && !options.force) {
      throw new Error(`Clone destination ${destination} already has origin ${origin}; refusing to treat it as ${spec.cloneUrl} without --force.`);
    }
    let updated = false;
    if (options.update) {
      await runGit(["fetch", "--all", "--prune"], destination);
      updated = true;
    }
    if (spec.ref) await runGit(["checkout", spec.ref], destination);
    return { hostPath: destination, cloned: false, updated, message: `${destination} already cloned${updated ? " and fetched" : ""}` };
  }

  const cloneArgs = ["clone"];
  if (config.cloneMode === "shallow") cloneArgs.push("--depth", "1");
  if (spec.ref && config.cloneMode === "shallow") cloneArgs.push("--branch", spec.ref);
  cloneArgs.push(spec.cloneUrl, destination);
  await runGit(cloneArgs);
  if (spec.ref && config.cloneMode !== "shallow") await runGit(["checkout", spec.ref], destination);
  return { hostPath: destination, cloned: true, updated: false, message: `cloned ${spec.display} to ${destination}` };
}

export async function forceRemoveClone(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}
