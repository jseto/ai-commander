/**
 * Repository scope for the child-session menu.
 *
 * `/mudevserver` is a project extension: pi loads it only in sessions whose
 * project is this checkout, so no session-level gate is needed. What is still
 * needed is narrowing the tmux menu - the orchestrator may have children of
 * *other* repositories running (for example tasks in the riak-t repo), and
 * those must never be listed or addressed by this command.
 *
 * Two paths belong to the same project exactly when their git common
 * directories match: `git rev-parse --path-format=absolute --git-common-dir`
 * returns `<main checkout>/.git` for the main checkout and for every linked
 * treehouse worktree, and a different path for any other repository.
 */

import { resolve } from "node:path";

import { listChildSessions, type ChildSession, type RunExec } from "./child-sessions.ts";

export interface RepoIdentity {
	/** The repository's git common dir, absolute; null when `path` is not a repo. */
	commonDir(path: string): Promise<string | null>;
	sameRepo(left: string, right: string): Promise<boolean>;
}

/** The repository's git common dir, absolute; null when `path` is not a repo. */
export async function gitCommonDir(run: RunExec, path: string): Promise<string | null> {
	try {
		const { stdout } = await run("git", [
			"-C",
			path,
			"rev-parse",
			"--path-format=absolute",
			"--git-common-dir",
		]);
		const absolute = stdout.trim();
		if (absolute) return absolute;
	} catch {
		// Older git without --path-format falls through to the relative form.
	}
	try {
		const { stdout } = await run("git", ["-C", path, "rev-parse", "--git-common-dir"]);
		const relative = stdout.trim();
		return relative ? resolve(path, relative) : null;
	} catch {
		return null;
	}
}

export function createRepoIdentity(run: RunExec): RepoIdentity {
	const cache = new Map<string, Promise<string | null>>();
	const commonDir = (path: string): Promise<string | null> => {
		const cached = cache.get(path) ?? gitCommonDir(run, path);
		cache.set(path, cached);
		return cached;
	};
	return {
		commonDir,
		sameRepo: async (left, right) => {
			const leftKey = await commonDir(left);
			return leftKey !== null && (await commonDir(right)) === leftKey;
		},
	};
}

/**
 * Child sessions, narrowed to checkouts of the same repository as
 * `projectRoot`. The tmux enumeration (`listChildSessions`) stays
 * repository-agnostic; this is the scoping seam.
 */
export async function listScopedChildren(
	run: RunExec,
	identity: RepoIdentity,
	projectRoot: string,
	currentSession: string | null,
): Promise<ChildSession[]> {
	const children = await listChildSessions(run, currentSession);
	const accepted = await Promise.all(
		children.map(async (child) =>
			(await identity.sameRepo(projectRoot, child.worktree)) ? child : null,
		),
	);
	return accepted.filter((child): child is ChildSession => child !== null);
}
