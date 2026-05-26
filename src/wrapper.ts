import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { appendDebugLine, loadMountStore, writeLastApply } from "./storage.js";
import { identifyConversation } from "./conversation.js";
import { partitionMounts, validateGuestPath } from "./validate.js";
import type { MountMode, ProviderFactory, VmCreateOptionsLike } from "./types.js";

type VmModuleLike = {
  VM: { create: (options?: VmCreateOptionsLike) => Promise<unknown> };
  RealFSProvider?: new (hostPath: string) => unknown;
  ReadonlyProvider?: new (provider: unknown) => unknown;
};

const WRAPPED = Symbol.for("pi-ez-chat-mount.vm-create-wrapped");
const ORIGINAL = Symbol.for("pi-ez-chat-mount.vm-create-original");

type WrappedCreate = ((options?: VmCreateOptionsLike) => Promise<unknown>) & {
  [WRAPPED]?: true;
  [ORIGINAL]?: (options?: VmCreateOptionsLike) => Promise<unknown>;
};

export function defaultProviderFactory(module: VmModuleLike): ProviderFactory {
  return (hostPath: string, mode: MountMode): unknown => {
    if (!module.RealFSProvider) throw new Error("@earendil-works/gondolin RealFSProvider is unavailable");
    const provider = new module.RealFSProvider(hostPath);
    if (mode === "ro") {
      if (!module.ReadonlyProvider) throw new Error("@earendil-works/gondolin ReadonlyProvider is unavailable");
      return new module.ReadonlyProvider(provider);
    }
    return provider;
  };
}

export function installVmCreateWrapper(module: VmModuleLike, providerFactory = defaultProviderFactory(module)): boolean {
  const current = module.VM.create as WrappedCreate;
  if (current[WRAPPED]) return false;
  const original = current.bind(module.VM) as (options?: VmCreateOptionsLike) => Promise<unknown>;
  const wrapped = (async (options?: VmCreateOptionsLike) => {
    const opts = options ?? {};
    try {
      await applyConfiguredMounts(opts, providerFactory);
    } catch (error) {
      await appendDebugLine(`[wrapper-error] ${error instanceof Error ? error.stack || error.message : String(error)}`).catch(() => undefined);
    }
    return original(opts);
  }) as WrappedCreate;
  wrapped[WRAPPED] = true;
  wrapped[ORIGINAL] = original;
  module.VM.create = wrapped;
  return true;
}

export async function applyConfiguredMounts(
  opts: VmCreateOptionsLike,
  providerFactory: ProviderFactory,
  deps: { loadStore?: typeof loadMountStore; writeLast?: typeof writeLastApply; debug?: typeof appendDebugLine } = {},
): Promise<void> {
  const conversationId = identifyConversation(opts);
  if (!conversationId) return;
  const loadStore = deps.loadStore ?? loadMountStore;
  const writeLast = deps.writeLast ?? writeLastApply;
  const debug = deps.debug ?? appendDebugLine;
  const store = await loadStore();
  const configured = store[conversationId] ?? {};
  const { applied, skipped } = await partitionMounts(configured);
  if (!opts.vfs) opts.vfs = { mounts: {} };
  if (!opts.vfs.mounts) opts.vfs.mounts = {};

  for (const mount of applied) {
    const existing = opts.vfs.mounts[mount.guestPath];
    const conflict = existing || validateGuestPath(mount.guestPath);
    if (conflict) {
      skipped.push({ ...mount, reason: existing ? "guest path collides with existing VM mount" : String(conflict) });
      continue;
    }
    opts.vfs.mounts[mount.guestPath] = providerFactory(mount.hostPath, mount.mode);
  }

  const finalApplied = applied.filter((mount) => opts.vfs?.mounts?.[mount.guestPath]);
  const state = { conversationId, applied: finalApplied, skipped, at: new Date().toISOString() };
  await writeLast(state).catch(() => undefined);
  await debug(`[apply] conversation=${conversationId} applied=${finalApplied.length} skipped=${skipped.length}`).catch(() => undefined);
}

async function importGondolin(): Promise<VmModuleLike> {
  try {
    return (await import("@earendil-works/gondolin")) as VmModuleLike;
  } catch (bareError) {
    // pi-chat is commonly installed as a git pi package. Import its dependency by
    // absolute path so we patch the same module instance pi-chat uses, without
    // bundling a duplicate Gondolin copy in this package.
    const fallback = join(
      homedir(),
      ".pi",
      "agent",
      "git",
      "github.com",
      "earendil-works",
      "pi-chat",
      "node_modules",
      "@earendil-works",
      "gondolin",
      "dist",
      "src",
      "index.js",
    );
    if (existsSync(fallback)) return (await import(pathToFileURL(fallback).href)) as VmModuleLike;
    throw bareError;
  }
}

export async function tryInstallRuntimeWrapper(): Promise<{ installed: boolean; error?: string }> {
  try {
    const module = await importGondolin();
    return { installed: installVmCreateWrapper(module) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await appendDebugLine(`[install-error] ${message}`).catch(() => undefined);
    return { installed: false, error: message };
  }
}
