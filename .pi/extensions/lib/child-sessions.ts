/**
 * Running child pi sessions of the orchestrator pattern.
 *
 * The mu-commander `sub-spawn.sh` convention starts each child as a tmux
 * session `pi-<task>` rooted at its leased treehouse worktree
 * (`tmux new -d -s pi-<task> -c "$WT"`). A tmux session dies with its last
 * pane, so a live `pi-<task>` session means a live child, and the pane's
 * current path is the leased worktree. `pi-main` is the orchestrator itself
 * and never a child; the invoking session is excluded so a session never lists
 * itself. The repo name is the basename of the worktree's git toplevel.
 */

import { basename } from "node:path";

export interface ChildSession {
	task: string;
	session: string;
	worktree: string;
	repo: string;
}

export interface ExecResult {
	stdout: string;
	stderr: string;
}

export type RunExec = (file: string, args: string[]) => Promise<ExecResult>;

export const CHILD_SESSION_PREFIX = "pi-";
export const MAIN_SESSION = "pi-main";
const TASK_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** `pi-<task>` -> `<task>`; null for `pi-main` or a non-task name. */
export function taskFromSession(session: string): string | null {
	if (!session.startsWith(CHILD_SESSION_PREFIX)) return null;
	const task = session.slice(CHILD_SESSION_PREFIX.length);
	if (task === "main") return null;
	return TASK_PATTERN.test(task) ? task : null;
}

export function parseSessionNames(stdout: string): string[] {
	return stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

/** Name of the tmux session containing this process, or null outside tmux. */
export async function currentTmuxSession(run: RunExec): Promise<string | null> {
	try {
		const { stdout } = await run("tmux", ["display-message", "-p", "#S"]);
		return stdout.trim() || null;
	} catch {
		return null;
	}
}

/** Live child sessions, sorted by task name. An absent tmux server means none. */
export async function listChildSessions(
	run: RunExec,
	currentSession: string | null,
): Promise<ChildSession[]> {
	let names: string[];
	try {
		names = parseSessionNames(
			(await run("tmux", ["list-sessions", "-F", "#{session_name}"])).stdout,
		);
	} catch {
		return [];
	}

	const children: ChildSession[] = [];
	for (const session of names) {
		if (session === currentSession) continue;
		const task = taskFromSession(session);
		if (!task) continue;
		const worktree = await paneCurrentPath(run, session);
		if (!worktree) continue;
		children.push({ task, session, worktree, repo: await repoName(run, worktree) });
	}
	return children.sort((left, right) => left.task.localeCompare(right.task));
}

async function paneCurrentPath(run: RunExec, session: string): Promise<string | null> {
	try {
		const { stdout } = await run("tmux", [
			"display-message",
			"-p",
			"-t",
			session,
			"#{pane_current_path}",
		]);
		return stdout.trim() || null;
	} catch {
		return null;
	}
}

async function repoName(run: RunExec, worktree: string): Promise<string> {
	try {
		const { stdout } = await run("git", ["-C", worktree, "rev-parse", "--show-toplevel"]);
		const root = stdout.trim();
		if (root) return basename(root);
	} catch {
		// Not a git checkout: fall back to the worktree directory name.
	}
	return basename(worktree);
}
