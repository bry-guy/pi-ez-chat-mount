export type RepoSpec = {
  input: string;
  cloneUrl: string;
  repoName: string;
  ref?: string;
  display: string;
};

function stripGitSuffix(name: string): string {
  return name.replace(/\.git$/i, "");
}

function splitRef(input: string): { base: string; ref?: string } {
  const hash = input.lastIndexOf("#");
  if (hash <= 0) return { base: input };
  const ref = input.slice(hash + 1).trim();
  return { base: input.slice(0, hash), ref: ref || undefined };
}

function validSegment(value: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(value) && value !== "." && value !== "..";
}

export function parseRepoSpec(raw: string): RepoSpec | undefined {
  const input = raw.trim();
  if (!input) return undefined;
  const { base, ref } = splitRef(input);

  const shorthand = base.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (shorthand) {
    const [, owner, repo] = shorthand;
    if (!validSegment(owner) || !validSegment(repo)) throw new Error(`Invalid GitHub repo shorthand: ${input}`);
    return {
      input,
      cloneUrl: `git@github.com:${owner}/${repo}.git`,
      repoName: stripGitSuffix(repo),
      ref,
      display: `${owner}/${stripGitSuffix(repo)}`,
    };
  }

  const ssh = base.match(/^git@([^:]+):(.+)$/);
  if (ssh) {
    const path = ssh[2].replace(/^\/+/, "");
    const last = path.split("/").filter(Boolean).at(-1);
    if (!last) throw new Error(`Could not determine repository name from ${input}`);
    const repoName = stripGitSuffix(last);
    if (!validSegment(repoName)) throw new Error(`Invalid repository name in ${input}`);
    return { input, cloneUrl: base, repoName, ref, display: base };
  }

  if (/^https?:\/\//i.test(base) || /^ssh:\/\//i.test(base)) {
    let url: URL;
    try {
      url = new URL(base);
    } catch {
      throw new Error(`Invalid repository URL: ${input}`);
    }
    const last = url.pathname.split("/").filter(Boolean).at(-1);
    if (!last) throw new Error(`Could not determine repository name from ${input}`);
    const repoName = stripGitSuffix(decodeURIComponent(last));
    if (!validSegment(repoName)) throw new Error(`Invalid repository name in ${input}`);
    return { input, cloneUrl: base, repoName, ref, display: base };
  }

  return undefined;
}
