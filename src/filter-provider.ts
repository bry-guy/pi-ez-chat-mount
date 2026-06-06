const DIRECTORY_METHOD_PATTERN = /^(readdir|readDir|readDirectory|listDir|listDirectory)$/u;
const TWO_PATH_ARGUMENT_METHODS = new Set<PropertyKey>(["rename", "copy", "link", "symlink"]);

export function pathIncludesNodeModules(value: string): boolean {
  return value.split(/[\\/]+/u).includes("node_modules");
}

function nodeModulesExcludedError(path: string): Error & { code: string } {
  const error = new Error(`node_modules is excluded from this mount: ${path}`) as Error & { code: string };
  error.code = "ENOENT";
  return error;
}

function pathArgumentIndexes(prop: PropertyKey): number[] {
  if (TWO_PATH_ARGUMENT_METHODS.has(prop)) return [0, 1];
  return [0];
}

function entryName(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && "name" in entry) {
    const name = (entry as { name?: unknown }).name;
    return typeof name === "string" ? name : undefined;
  }
  return undefined;
}

function filterDirectoryEntries(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.filter((entry) => entryName(entry) !== "node_modules");
}

function maybeFilterDirectoryEntries(prop: PropertyKey, value: unknown): unknown {
  if (typeof prop !== "string" || !DIRECTORY_METHOD_PATTERN.test(prop)) return value;
  if (value && typeof (value as PromiseLike<unknown>).then === "function") {
    return (value as PromiseLike<unknown>).then(filterDirectoryEntries);
  }
  return filterDirectoryEntries(value);
}

export function excludeNodeModulesProvider(provider: unknown): unknown {
  if (!provider || (typeof provider !== "object" && typeof provider !== "function")) return provider;
  return new Proxy(provider as object, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        for (const index of pathArgumentIndexes(prop)) {
          const candidate = args[index];
          if (typeof candidate === "string" && pathIncludesNodeModules(candidate)) throw nodeModulesExcludedError(candidate);
        }
        return maybeFilterDirectoryEntries(prop, value.apply(target, args));
      };
    },
  });
}
