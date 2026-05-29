export type ForgeName = "github" | "gitlab" | "bitbucket";

export type MountTarget = {
  input: string;
  kind: "name" | "shorthand" | "url";
  slug: string;
  cloneUrl?: string;
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

function cloneUrlForForge(forge: ForgeName, owner: string, repo: string): string {
  if (forge === "github") return `git@github.com:${owner}/${repo}.git`;
  if (forge === "gitlab") return `git@gitlab.com:${owner}/${repo}.git`;
  return `git@bitbucket.org:${owner}/${repo}.git`;
}

export function parseForge(value: string | undefined): ForgeName {
  const normalized = (value || "github").trim().toLowerCase();
  if (normalized === "github" || normalized === "gitlab" || normalized === "bitbucket") return normalized;
  throw new Error(`Unsupported forge ${value}. Expected github, gitlab, or bitbucket.`);
}

export function parseMountTarget(raw: string, defaultForge: ForgeName = "github"): MountTarget | undefined {
  const input = raw.trim();
  if (!input) return undefined;
  const { base, ref } = splitRef(input);

  if (validSegment(base)) {
    return { input, kind: "name", slug: stripGitSuffix(base), ref, display: stripGitSuffix(base) };
  }

  const shorthand = base.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (shorthand) {
    const [, owner, repo] = shorthand;
    if (!validSegment(owner) || !validSegment(repo)) throw new Error(`Invalid repository shorthand: ${input}`);
    const slug = stripGitSuffix(repo);
    return { input, kind: "shorthand", slug, cloneUrl: cloneUrlForForge(defaultForge, owner, slug), ref, display: `${owner}/${slug}` };
  }

  const ssh = base.match(/^git@([^:]+):(.+)$/);
  if (ssh) {
    const path = ssh[2].replace(/^\/+/, "");
    const last = path.split("/").filter(Boolean).at(-1);
    if (!last) throw new Error(`Could not determine repository name from ${input}`);
    const slug = stripGitSuffix(last);
    if (!validSegment(slug)) throw new Error(`Invalid repository name in ${input}`);
    return { input, kind: "url", slug, cloneUrl: base, ref, display: base };
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
    const slug = stripGitSuffix(decodeURIComponent(last));
    if (!validSegment(slug)) throw new Error(`Invalid repository name in ${input}`);
    return { input, kind: "url", slug, cloneUrl: base, ref, display: base };
  }

  return undefined;
}
