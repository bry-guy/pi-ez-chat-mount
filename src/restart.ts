import { spawn } from "node:child_process";

export type RestartScheduleResult = { scheduled: boolean; message: string };

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function scheduleCurrentTmuxPaneRespawn(delaySeconds = 8): RestartScheduleResult {
  const pane = process.env.TMUX_PANE;
  if (!pane) return { scheduled: false, message: "Gondolin VM must be restarted." };

  // Respawn the pane, not just QEMU. That reloads the pi worker process, extensions,
  // pi-chat conversation binding, and therefore creates a fresh Gondolin VM with the
  // updated mount config. The original pane start command is preserved by tmux.
  const script = `sleep ${Math.max(1, delaySeconds)}; tmux respawn-pane -k -t ${shellQuote(pane)}`;
  const child = spawn("sh", ["-c", script], { detached: true, stdio: "ignore" });
  child.unref();
  return { scheduled: true, message: `Restarting Gondolin VM in ${Math.max(1, delaySeconds)}s.` };
}
