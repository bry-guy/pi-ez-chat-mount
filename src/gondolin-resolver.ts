import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const GONDOLIN_DIST = join("node_modules", "@earendil-works", "gondolin", "dist", "src", "index.js");

function settingsPackages(): string[] {
	const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
	try {
		const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as { packages?: unknown };
		if (!Array.isArray(parsed.packages)) return [];
		return parsed.packages.filter((entry): entry is string => typeof entry === "string");
	} catch {
		return [];
	}
}

function expandPackagePath(entry: string): string | undefined {
	if (entry.startsWith("git:") || /^https?:/.test(entry)) return undefined;
	const expanded = entry.startsWith("~") ? join(homedir(), entry.slice(1)) : entry;
	const baseDir = join(homedir(), ".pi", "agent");
	return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

function candidateRootsFromSettings(): string[] {
	const roots: string[] = [];
	for (const entry of settingsPackages()) {
		const path = expandPackagePath(entry);
		if (!path) continue;
		if (!/pi-chat(?:$|[\/\\])/.test(path)) continue;
		roots.push(path);
	}
	return roots;
}

function candidateRootsFromGitCache(): string[] {
	const root = join(homedir(), ".pi", "agent", "git");
	const candidates: string[] = [];
	const knownHosts = ["github.com"];
	for (const host of knownHosts) {
		const owners = ["earendil-works", "bry-guy"];
		for (const owner of owners) candidates.push(join(root, host, owner, "pi-chat"));
	}
	return candidates;
}

export function findGondolinDistEntry(): string | undefined {
	for (const root of [...candidateRootsFromSettings(), ...candidateRootsFromGitCache()]) {
		const candidate = join(root, GONDOLIN_DIST);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

export async function importGondolinFromPiChat<T>(): Promise<T> {
	try {
		return (await import("@earendil-works/gondolin")) as T;
	} catch (bareError) {
		const entry = findGondolinDistEntry();
		if (entry) return (await import(pathToFileURL(entry).href)) as T;
		throw bareError;
	}
}
