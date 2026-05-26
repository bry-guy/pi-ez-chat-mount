export type NotifyLevel = "info" | "warning" | "error";

export type CommandContext = {
  cwd: string;
  sessionManager: { getEntries(): unknown[] };
  ui: { notify(message: string, level?: NotifyLevel): void };
};

export type ExtensionAPI = {
  getSessionName(): string | undefined;
  registerCommand(
    name: string,
    options: {
      description?: string;
      handler(args: string, ctx: CommandContext): Promise<void> | void;
    },
  ): void;
};
