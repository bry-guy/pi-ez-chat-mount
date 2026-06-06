import { appendDebugLine, loadMountStore, writeLastApply } from "./storage.js";
import { excludeNodeModulesProvider } from "./filter-provider.js";
import { partitionMounts } from "./validate.js";
import type { MountEntry } from "./types.js";

type GondolinLike = {
  RealFSProvider: new (hostPath: string) => unknown;
  ReadonlyProvider: new (provider: unknown) => unknown;
};

type ContributorContext = {
  conversationId: string;
  gondolin: GondolinLike;
};

type ContributorDeps = {
  loadStore?: typeof loadMountStore;
  writeLast?: typeof writeLastApply;
  debug?: typeof appendDebugLine;
};

function buildProvider(gondolin: GondolinLike, mount: MountEntry): unknown {
  const baseProvider = new gondolin.RealFSProvider(mount.hostPath);
  const filteredProvider = mount.includeNodeModules ? baseProvider : excludeNodeModulesProvider(baseProvider);
  return mount.mode === "ro" ? new gondolin.ReadonlyProvider(filteredProvider) : filteredProvider;
}

export function createMountContributor(deps: ContributorDeps = {}) {
  return {
    name: "pi-ez-chat-mount",
    contribute: async (ctx: ContributorContext) => {
      const loadStore = deps.loadStore ?? loadMountStore;
      const writeLast = deps.writeLast ?? writeLastApply;
      const debug = deps.debug ?? appendDebugLine;
      const configured = (await loadStore())[ctx.conversationId] ?? {};
      const { applied, skipped } = await partitionMounts(configured);
      const mounts: Record<string, unknown> = {};
      for (const mount of applied) {
        mounts[mount.guestPath] = buildProvider(ctx.gondolin, mount);
      }
      const state = { conversationId: ctx.conversationId, applied, skipped, at: new Date().toISOString() };
      await writeLast(state).catch(() => undefined);
      await debug(`[apply] conversation=${ctx.conversationId} applied=${applied.length} skipped=${skipped.length}`).catch(() => undefined);
      return Object.keys(mounts).length > 0 ? { vfs: { mounts } } : undefined;
    },
  };
}
