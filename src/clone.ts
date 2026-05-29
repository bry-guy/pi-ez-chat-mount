import { mkdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { ChatMountConfig } from "./config.js";
import type { MountTarget } from "./target.js";

export type CloneOptions = {
  force: boolean;
};

export type CloneResult = {
  hostPath: string;
  cloned: boolean;
  message: string;
};

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function runGit(args: string[], cwd?: string): Promise<string> {
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

export function sameOrigin(actual: string, expected: string): boolean {
  const normalize = (value: string) => value
    .trim()
    .replace(/\.git$/i, "")
    .replace(/^https:\/\/github\.com\//i, "git@github.com:")
    .replace(/^https:\/\/gitlab\.com\//i, "git@gitlab.com:")
    .replace(/^https:\/\/bitbucket\.org\//i, "git@bitbucket.org:");
  return normalize(actual) === normalize(expected);
}

export async function ensureRepoClone(target: MountTarget, config: ChatMountConfig, options: CloneOptions): Promise<CloneResult> {
  if (!target.cloneUrl) throw new Error(`Cannot clone bare repository name ${target.display}; did you mean to specify a repo URL?`);

  const sourceDir = resolve(config.sourceDir);
  const destination = join(sourceDir, target.slug);
  if (!destination.startsWith(`${sourceDir}/`) && destination !== sourceDir) throw new Error(`Refusing unsafe clone destination: ${destination}`);

  await mkdir(sourceDir, { recursive: true });
  const exists = await pathExists(destination);
  if (exists) {
    // User intent is source-dir-first: if a sibling with the target slug is already
    // present, mount it rather than consulting the network. Origin mismatch is not
    // an error; users manage repo identity/state themselves inside the VM.
    if (target.ref) await runGit(["checkout", target.ref], destination);
    return { hostPath: destination, cloned: false, message: `${destination} already exists in source` };
  }

  const cloneArgs = ["clone"];
  if (config.cloneMode === "shallow") cloneArgs.push("--depth", "1");
  if (target.ref && config.cloneMode === "shallow") cloneArgs.push("--branch", target.ref);
  cloneArgs.push(target.cloneUrl, destination);
  await runGit(cloneArgs);
  if (target.ref && config.cloneMode !== "shallow") await runGit(["checkout", target.ref], destination);
  return { hostPath: destination, cloned: true, message: `cloned ${target.display} to ${destination}` };
}

export async function forceRemoveClone(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}
