import { spawnSync } from "node:child_process";

export type RestartScheduleResult = { scheduled: boolean; message: string };

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function scheduleCurrentTmuxPaneRespawn(delaySeconds = 1): RestartScheduleResult {
  const pane = process.env.TMUX_PANE;
  if (!pane) return { scheduled: false, message: "Gondolin VM must be restarted." };

  // We cannot respawn synchronously without killing the process before pi-chat can
  // deliver the command result. Ask tmux to do it shortly after this hook returns.
  // `tmux run-shell -b` itself is synchronous enough that we can report scheduling
  // failures in the command result.
  const delay = Math.max(1, delaySeconds);
  const script = `sleep ${delay}; tmux respawn-pane -k -t ${shellQuote(pane)}`;
  const result = spawnSync("tmux", ["run-shell", "-b", script], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    const stderr = result.stderr?.trim();
    return {
      scheduled: false,
      message: `Gondolin VM must be restarted. Auto-restart failed: ${stderr || result.error?.message || `tmux exited ${result.status}`}`,
    };
  }
  return { scheduled: true, message: "Restarting Gondolin VM." };
}
