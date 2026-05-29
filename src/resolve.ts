import { basename, join, resolve } from "node:path";
import type { CommandContext } from "./pi-types.js";
import { expandHome, loadConfig } from "./config.js";
import type { ChatMountConfig } from "./config.js";
import { ensureRepoClone, pathExists, runGit } from "./clone.js";
import { parseForge, parseMountTarget, type MountTarget } from "./target.js";

export type TargetOptions = {
  force: boolean;
  sourceDir?: string;
  forge?: string;
};

export type ResolvedHostPath = {
  hostPath: string;
  target?: MountTarget;
  message?: string;
};

export async function gitRoot(cwd: string): Promise<string | undefined> {
  try {
    return await runGit(["rev-parse", "--show-toplevel"], cwd);
  } catch {
    return undefined;
  }
}

export async function resolveCurrentRepoHostPath(ctx: Pick<CommandContext, "cwd">): Promise<ResolvedHostPath> {
  const root = await gitRoot(ctx.cwd);
  if (!root) throw new Error("Current cwd is not inside a git repository; pass a repo name, repo shorthand, or URL instead.");
  return { hostPath: root, message: `resolved current git repository ${basename(root)}` };
}

function withOverrides(config: ChatMountConfig, options: TargetOptions): ChatMountConfig {
  const next = { ...config };
  if (options.sourceDir) next.sourceDir = resolve(expandHome(options.sourceDir));
  if (options.forge) next.defaultForge = parseForge(options.forge);
  return next;
}

export async function resolveTargetHostPath(rawTarget: string, ctx: Pick<CommandContext, "cwd">, options: TargetOptions): Promise<ResolvedHostPath> {
  const config = withOverrides(await loadConfig(undefined, ctx.cwd), options);
  const target = parseMountTarget(rawTarget, config.defaultForge);
  if (!target) throw new Error(`Not a supported repository target: ${rawTarget}`);

  const destination = join(config.sourceDir, target.slug);
  if (target.kind === "name") {
    if (!(await pathExists(destination))) {
      throw new Error(`No repository named ${target.slug} under ${config.sourceDir}. Did you mean to specify a repo URL?`);
    }
    if (target.ref) await runGit(["checkout", target.ref], destination);
    return { hostPath: destination, target, message: `found ${target.slug} in ${config.sourceDir}` };
  }

  const clone = await ensureRepoClone(target, config, { force: options.force });
  return { hostPath: clone.hostPath, target, message: clone.message };
}

export function guestPathForTarget(rawTarget: string, defaultForge = "github"): string | undefined {
  const target = parseMountTarget(rawTarget, parseForge(defaultForge));
  if (!target) return undefined;
  return `/${target.slug.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "")}`;
}
