import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	currentTmuxSession,
	listChildSessions,
	parseSessionNames,
	taskFromSession,
	type RunExec,
} from "../../.pi/extensions/lib/child-sessions.ts";

/** A fake environment: tmux sessions, pane paths, and git toplevels. */
function createRun(config: {
	sessions: string[];
	paths?: Record<string, string>;
	roots?: Record<string, string>;
}): RunExec {
	return async (file, args) => {
		if (file === "tmux" && args[0] === "list-sessions") {
			return { stdout: `${config.sessions.join("\n")}\n`, stderr: "" };
		}
		if (file === "tmux" && args[0] === "display-message") {
			const session = args[args.indexOf("-t") + 1] ?? "";
			return { stdout: `${config.paths?.[session] ?? ""}\n`, stderr: "" };
		}
		if (file === "git") {
			const worktree = args[1] ?? "";
			const root = config.roots?.[worktree];
			if (!root) throw new Error("not a git repository");
			return { stdout: `${root}\n`, stderr: "" };
		}
		throw new Error(`unexpected ${file}`);
	};
}

describe("child pi session discovery", () => {
	it("recognizes only pi-<kebab-task> sessions, never pi-main", () => {
		assert.equal(taskFromSession("pi-alpha"), "alpha");
		assert.equal(taskFromSession("pi-riak-167-spotify-share-icon"), "riak-167-spotify-share-icon");
		assert.equal(taskFromSession("pi-main"), null);
		assert.equal(taskFromSession("pi-Alpha"), null);
		assert.equal(taskFromSession("pi-"), null);
		assert.equal(taskFromSession("alpha"), null);
		assert.equal(taskFromSession("dev-alpha"), null);
	});

	it("parses a tmux session list defensively", () => {
		assert.deepEqual(parseSessionNames("pi-a\npi-b\n\n"), ["pi-a", "pi-b"]);
		assert.deepEqual(parseSessionNames(""), []);
	});

	it("resolves the repo from the git toplevel and falls back to the worktree basename", async () => {
		const run = createRun({
			sessions: ["pi-alpha", "pi-beta"],
			paths: { "pi-alpha": "/tree/alpha", "pi-beta": "/tree/beta" },
			roots: { "/tree/alpha": "/tree/alpha-repo" },
		});

		const children = await listChildSessions(run, null);

		assert.deepEqual(children, [
			{ task: "alpha", session: "pi-alpha", worktree: "/tree/alpha", repo: "alpha-repo" },
			{ task: "beta", session: "pi-beta", worktree: "/tree/beta", repo: "beta" },
		]);
	});

	it("excludes the invoking session and pi-main, and skips sessions without a pane path", async () => {
		const calls: string[][] = [];
		const inner = createRun({
			sessions: ["pi-main", "pi-alpha", "pi-beta", "pi-child", "pi-alpha-two"],
			paths: {
				"pi-alpha": "/tree/alpha",
				"pi-beta": "",
				"pi-child": "/tree/child",
				"pi-alpha-two": "/tree/alpha-two",
			},
		});
		const run: RunExec = async (file, args) => {
			calls.push([file, ...args]);
			return inner(file, args);
		};

		const children = await listChildSessions(run, "pi-child");

		assert.deepEqual(
			children.map((child) => child.session),
			["pi-alpha", "pi-alpha-two"],
		);
		const resolved = calls.filter((call) => call[1] === "display-message");
		assert.deepEqual(
			resolved.map((call) => call[4]),
			["pi-alpha", "pi-beta", "pi-alpha-two"],
		);
		assert.deepEqual(
			children.map((child) => child.task),
			["alpha", "alpha-two"],
		);
	});

	it("lists nothing when tmux is not running", async () => {
		const run: RunExec = async () => {
			throw new Error("no server running on /tmp/tmux");
		};
		assert.deepEqual(await listChildSessions(run, null), []);
	});

	it("reports the invoking session name, or null outside tmux", async () => {
		assert.equal(
			await currentTmuxSession(async () => ({ stdout: "pi-main\n", stderr: "" })),
			"pi-main",
		);
		assert.equal(
			await currentTmuxSession(async () => {
				throw new Error("no tmux");
			}),
			null,
		);
	});
});
