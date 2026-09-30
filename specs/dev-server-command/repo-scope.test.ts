import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RunExec } from "../../.pi/extensions/lib/child-sessions.ts";
import {
	createRepoIdentity,
	gitCommonDir,
	listScopedChildren,
} from "../../.pi/extensions/lib/repo-scope.ts";

const PROJECT_ROOT = "/repo/mu-commander";
const WORKTREE = "/pool/mu-commander-70dc7d/2/mu-commander";
const OTHER_REPO = "/repo/other";

/** Fake git: `--path-format=absolute` optionally unsupported (older git). */
function createGitRun(config: {
	commonDirs: Record<string, string>;
	absoluteUnsupported?: boolean;
}): RunExec {
	return async (file, args) => {
		if (file !== "git") throw new Error(`unexpected ${file}`);
		const path = args[1] ?? "";
		const commonDir = config.commonDirs[path];
		if (!commonDir) throw new Error("not a git repository");
		if (args.includes("--path-format=absolute")) {
			if (config.absoluteUnsupported) throw new Error("unknown option 'path-format'");
			return { stdout: `${commonDir}\n`, stderr: "" };
		}
		// Older git returns the common dir relative to `path` when it is inside.
		const relative = commonDir.startsWith(`${path}/`)
			? commonDir.slice(path.length + 1)
			: commonDir;
		return { stdout: `${relative}\n`, stderr: "" };
	};
}

const COMMON_DIRS = {
	[PROJECT_ROOT]: `${PROJECT_ROOT}/.git`,
	[`${PROJECT_ROOT}/scripts`]: `${PROJECT_ROOT}/.git`,
	[WORKTREE]: `${PROJECT_ROOT}/.git`,
	[OTHER_REPO]: `${OTHER_REPO}/.git`,
};

describe("repository scope for the child menu", () => {
	it("resolves the absolute git common dir, including the relative fallback", async () => {
		const modern = createGitRun({ commonDirs: COMMON_DIRS });
		assert.equal(await gitCommonDir(modern, PROJECT_ROOT), `${PROJECT_ROOT}/.git`);
		assert.equal(await gitCommonDir(modern, WORKTREE), `${PROJECT_ROOT}/.git`);

		const legacy = createGitRun({ commonDirs: COMMON_DIRS, absoluteUnsupported: true });
		assert.equal(await gitCommonDir(legacy, PROJECT_ROOT), `${PROJECT_ROOT}/.git`);
		assert.equal(await gitCommonDir(legacy, WORKTREE), `${PROJECT_ROOT}/.git`);
	});

	it("returns null for paths that are not git repositories", async () => {
		const run = createGitRun({ commonDirs: COMMON_DIRS });
		assert.equal(await gitCommonDir(run, "/tmp/not-a-repo"), null);
	});

	it("treats the main checkout and its treehouse worktrees as the same project, other repos as not", async () => {
		const identity = createRepoIdentity(createGitRun({ commonDirs: COMMON_DIRS }));
		assert.equal(await identity.sameRepo(PROJECT_ROOT, WORKTREE), true);
		assert.equal(await identity.sameRepo(PROJECT_ROOT, `${PROJECT_ROOT}/scripts`), true);
		assert.equal(await identity.sameRepo(PROJECT_ROOT, OTHER_REPO), false);
		assert.equal(await identity.sameRepo(PROJECT_ROOT, "/tmp/not-a-repo"), false);
	});

	it("scopes out everything when the project root is not a repository", async () => {
		const identity = createRepoIdentity(createGitRun({ commonDirs: COMMON_DIRS }));
		assert.equal(await identity.sameRepo("/tmp/not-a-repo", WORKTREE), false);
	});

	it("lists child sessions but drops every worktree of another repository", async () => {
		const git = createGitRun({ commonDirs: COMMON_DIRS });
		const run: RunExec = async (file, args) => {
			if (file === "tmux" && args[0] === "list-sessions") {
				return { stdout: "pi-alpha\npi-other\npi-broken\n", stderr: "" };
			}
			if (file === "tmux" && args[0] === "display-message") {
				const session = args[args.indexOf("-t") + 1] ?? "";
				const paths: Record<string, string> = {
					"pi-alpha": WORKTREE,
					"pi-other": OTHER_REPO,
					"pi-broken": "/tmp/not-a-repo",
				};
				return { stdout: `${paths[session] ?? ""}\n`, stderr: "" };
			}
			return git(file, args);
		};
		const identity = createRepoIdentity(git);

		const children = await listScopedChildren(run, identity, PROJECT_ROOT, null);

		assert.deepEqual(
			children.map((child) => child.task),
			["alpha"],
		);
	});
});
