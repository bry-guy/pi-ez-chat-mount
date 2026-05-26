export type MountMode = "rw" | "ro";

export type MountEntry = {
  hostPath: string;
  mode: MountMode;
};

export type ConversationMounts = Record<string, MountEntry>;

export type MountStore = Record<string, ConversationMounts>;

export type AppliedMount = MountEntry & {
  guestPath: string;
};

export type SkippedMount = MountEntry & {
  guestPath: string;
  reason: string;
};

export type LastApplyState = {
  conversationId: string;
  applied: AppliedMount[];
  skipped: SkippedMount[];
  at: string;
};

export type VmCreateOptionsLike = {
  sessionLabel?: string;
  vfs?: null | {
    mounts?: Record<string, unknown>;
  };
};

export type ProviderFactory = (hostPath: string, mode: MountMode) => unknown;
