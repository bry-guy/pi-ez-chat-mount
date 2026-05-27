export type NotifyLevel = "info" | "warning" | "error";

export type CommandContext = {
  cwd: string;
  sessionManager: { getEntries(): unknown[] };
  ui: { notify(message: string, level?: NotifyLevel): void };
};

export type InputEvent = { text: string; images?: unknown[]; source?: string };
export type InputEventResult = { action: "continue" } | { action: "handled" } | { action: "transform"; text: string; images?: unknown[] };

export type ExtensionAPI = {
  getSessionName(): string | undefined;
  registerCommand(
    name: string,
    options: {
      description?: string;
      handler(args: string, ctx: CommandContext): Promise<void> | void;
    },
  ): void;
  on?(event: "input", handler: (event: InputEvent, ctx: CommandContext) => Promise<InputEventResult> | InputEventResult): void;
};
