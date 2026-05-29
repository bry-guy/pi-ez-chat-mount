import { parseMountTarget } from "./target.js";
import type { ForgeName } from "./target.js";

export type RepoSpec = {
  input: string;
  cloneUrl: string;
  repoName: string;
  ref?: string;
  display: string;
};

export function parseRepoSpec(raw: string, defaultForge: ForgeName = "github"): RepoSpec | undefined {
  const target = parseMountTarget(raw, defaultForge);
  if (!target || target.kind === "name" || !target.cloneUrl) return undefined;
  return {
    input: target.input,
    cloneUrl: target.cloneUrl,
    repoName: target.slug,
    ref: target.ref,
    display: target.display,
  };
}
