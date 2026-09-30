import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
	childInstruction,
	createDevServerCore,
	type DeliveryTarget,
	type DevServerCore,
	type DevServerCoreDeps,
	type DevServerView,
	type ReachableUrls,
} from "../../.pi/extensions/lib/dev-server-command-core.ts";
import type { ChildSession, RunExec } from "../../.pi/extensions/lib/child-sessions.ts";
import { listChildSessions } from "../../.pi/extensions/lib/child-sessions.ts";
import type { ListeningProcess } from "../../.pi/extensions/lib/listening-ports.ts";
import { sendLine } from "../../.pi/extensions/lib/tmux-send.ts";
import {
	COMMAND_NAME,
	registerDevServerSurfaces,
	type PiExtensionApi,
} from "../../.pi/extensions/dev-server-command.ts";
import type {
	TelegramBridge,
	TelegramCommandRegistration,
} from "../../.pi/extensions/telegram-bridge.ts";
import { resolveAgentDir } from "../../.pi/extensions/telegram-bridge.ts";

const ALPHA: ChildSession = {
	task: "alpha",
	session: "pi-alpha",
	worktree: "/tree/alpha",
	repo: "alpha-repo",
};
const BETA: ChildSession = {
	task: "beta",
	session: "pi-beta",
	worktree: "/tree/beta",
	repo: "beta-repo",
};

function listener(port: number, cwd: string, cmdline = "npm run dev -- --host"): ListeningProcess {
	return {
		port,
		address: "0.0.0.0",
		inode: `inode-${port}`,
		pid: 10_000 + port,
		cwd,
		cmdline,
	};
}

interface DeliveryRecord {
	kind: "send" | "edit";
	handle: string;
	view: DevServerView;
	target: DeliveryTarget;
}

interface HarnessOptions {
	children?: ChildSession[];
	discover?: ListeningProcess[][] | ((call: number, roots: string[]) => ListeningProcess[]);
	sendLine?: (session: string, text: string) => Promise<boolean>;
	urls?: Record<number, ReachableUrls>;
	deliver?: boolean;
	waitMs?: number;
	pollMs?: number;
}

function createHarness(options: HarnessOptions = {}) {
	const deliveries: DeliveryRecord[] = [];
	const lines: Array<{ session: string; text: string }> = [];
	const discoverCalls: string[][] = [];
	const sleeps: number[] = [];
	const script = options.discover;
	let discoverCall = 0;
	let handleSeq = 0;
	let time = 0;

	const deps: DevServerCoreDeps = {
		listChildren: async () => options.children ?? [],
		discoverListeners: async (roots) => {
			discoverCalls.push([...roots]);
			if (typeof script === "function") return script(discoverCall++, roots);
			if (Array.isArray(script)) {
				const snapshot = script[Math.min(discoverCall, script.length - 1)] ?? [];
				discoverCall += 1;
				return snapshot;
			}
			return [];
		},
		sendLine: async (session, text) => {
			lines.push({ session, text });
			return options.sendLine ? options.sendLine(session, text) : true;
		},
		detectReachableUrls: async (port) =>
			options.urls?.[port] ?? { intranet: null, tailscale: null },
		sendView: async (view, target) => {
			if (options.deliver === false) {
				deliveries.push({ kind: "send", handle: "", view, target });
				return null;
			}
			const handle = `h${(handleSeq += 1)}`;
			deliveries.push({ kind: "send", handle, view, target });
			return handle;
		},
		editView: async (handle, view) => {
			deliveries.push({ kind: "edit", handle: String(handle), view, target: {} });
			return handle;
		},
		now: () => time,
		sleep: async (ms) => {
			sleeps.push(ms);
			time += ms;
		},
		waitMs: options.waitMs ?? 10_000,
		pollMs: options.pollMs ?? 2_000,
	};

	return {
		core: createDevServerCore(deps),
		deliveries,
		lines,
		discoverCalls,
		sleeps,
		time: () => time,
	};
}

/** A fake tmux child listing: sessions, pane paths, and git toplevels. */
function createTmuxRun(config: {
	sessions: string[];
	paths?: Record<string, string>;
	roots?: Record<string, string>;
	failList?: boolean;
}): RunExec {
	return async (file, args) => {
		if (file === "git") {
			const worktree = args[1] ?? "";
			return { stdout: `${config.roots?.[worktree] ?? worktree}\n`, stderr: "" };
		}
		if (file !== "tmux") return { stdout: "", stderr: "" };
		const [subcommand, ...rest] = args;
		if (subcommand === "list-sessions") {
			if (config.failList) throw new Error("no server running");
			return { stdout: `${config.sessions.join("\n")}\n`, stderr: "" };
		}
		if (subcommand === "display-message") {
			const session = rest[rest.indexOf("-t") + 1] ?? "";
			return { stdout: `${config.paths?.[session] ?? ""}\n`, stderr: "" };
		}
		return { stdout: "", stderr: "" };
	};
}

function createFakePi() {
	const handlers: Record<string, () => unknown> = {};
	const pi = {
		on(event: string, handler: () => unknown) {
			handlers[event] = handler;
		},
	} as PiExtensionApi;
	return { pi, fire: (event: string) => handlers[event]?.() };
}

interface RegisteredCommand {
	registration: TelegramCommandRegistration;
	disposed: boolean;
}

function createFakeBridge() {
	const commands: RegisteredCommand[] = [];
	const errors: unknown[] = [];
	const bridge: TelegramBridge = {
		registerCommand: async (registration) => {
			const entry: RegisteredCommand = { registration, disposed: false };
			commands.push(entry);
			return () => {
				entry.disposed = true;
			};
		},
		sendView: async () => null,
		editView: async (handle) => handle,
		recordError: (_category, error) => {
			errors.push(error);
		},
	};
	return {
		bridge,
		commands,
		errors,
		active: () => commands.filter((command) => !command.disposed),
	};
}

describe("Telegram /mudevserver command for mu-commander child pi sessions", () => {
	it("List all running child sessions with their repo, worktree, and dev-server state. [REQ-1]", async () => {
		const run = createTmuxRun({
			sessions: ["pi-main", "pi-beta", "pi-alpha"],
			paths: { "pi-alpha": "/tree/alpha", "pi-beta": "/tree/beta" },
			roots: { "/tree/alpha": "/tree/alpha-repo", "/tree/beta": "/tree/beta-repo" },
		});
		const harness = createHarness({
			children: await listChildSessions(run, "pi-main"),
		});

		await harness.core.handle({}, "");

		assert.equal(harness.deliveries.length, 1);
		const text = harness.deliveries[0]!.view.text;
		assert.match(text, /alpha/);
		assert.match(text, /beta/);
		assert.match(text, /alpha-repo/);
		assert.match(text, /\/tree\/alpha/);
		assert.match(text, /no dev server/);
		assert.match(text, /\/mudevserver/);
		assert.doesNotMatch(text, /\/dev-server/);
		assert.doesNotMatch(text, /pi-main/);
	});

	it("Show the reachable links for a child whose dev server already listens. [REQ-2]", async () => {
		const harness = createHarness({
			children: [ALPHA],
			discover: [[listener(5173, "/tree/alpha")]],
			urls: { 5173: { intranet: "http://lan:5173", tailscale: "http://ts:5173" } },
		});

		await harness.core.handle({}, "");

		const text = harness.deliveries[0]!.view.text;
		assert.match(text, /5173/);
		assert.match(text, /<a href="http:\/\/lan:5173">intranet<\/a>/);
		assert.match(text, /<a href="http:\/\/ts:5173">Tailscale<\/a>/);
	});

	it("Resolve a selection by task name, unique prefix, or menu index. [REQ-3]", async () => {
		for (const args of ["alpha", "pi-alpha", "1"]) {
			const harness = createHarness({
				children: [ALPHA, BETA],
				discover: [[], [listener(5173, "/tree/alpha")]],
				waitMs: 10_000,
			});
			await harness.core.handle({}, args);
			assert.deepEqual(harness.lines.map((line) => line.session), ["pi-alpha"], `args=${args}`);
			assert.equal(harness.lines[0]!.text, childInstruction("alpha"), `args=${args}`);
		}
	});

	it("Reject an unknown or ambiguous selection without side effects. [REQ-4]", async () => {
		const children = [ALPHA, { ...BETA, task: "alpha-two", session: "pi-alpha-two" }];

		const ambiguous = createHarness({ children });
		await ambiguous.core.handle({}, "alph");
		assert.match(ambiguous.deliveries[0]!.view.text, /matches 2 children/);
		assert.equal(ambiguous.lines.length, 0);

		const unknown = createHarness({ children });
		await unknown.core.handle({}, "nope");
		assert.match(unknown.deliveries[0]!.view.text, /No child session matches/);
		assert.equal(unknown.lines.length, 0);
	});

	it("Report when no child session is running. [REQ-5]", async () => {
		const run = createTmuxRun({ sessions: ["pi-main"] });
		const harness = createHarness({ children: await listChildSessions(run, "pi-main") });

		await harness.core.handle({}, "");

		assert.equal(harness.deliveries.length, 1);
		assert.match(harness.deliveries[0]!.view.text, /No child session is running/);
	});

	it("Ask a selected child without a dev server through the verified send. [REQ-6]", async () => {
		const calls: string[][] = [];
		const typed = childInstruction("alpha");
		const panes = [`> ${typed}`, `> ${typed}`, `> ${typed}`, ""];
		let captureIndex = 0;
		const run: RunExec = async (file, args) => {
			calls.push([file, ...args]);
			if (args[0] === "capture-pane") {
				const index = Math.min(captureIndex, panes.length - 1);
				captureIndex += 1;
				return { stdout: panes[index] ?? "", stderr: "" };
			}
			return { stdout: "", stderr: "" };
		};
		const harness = createHarness({
			children: [ALPHA],
			discover: [[], [listener(4000, "/tree/alpha")]],
			sendLine: (session, text) => sendLine(run, session, text, { sleep: async () => {} }),
		});

		await harness.core.handle({}, "alpha");

		assert.deepEqual(calls[0], [
			"tmux",
			"send-keys",
			"-t",
			"pi-alpha",
			"-l",
			childInstruction("alpha"),
		]);
		const enters = calls.filter(
			(call) => call[0] === "tmux" && call[1] === "send-keys" && call.at(-1) === "Enter",
		);
		// The pane only changed after the second Enter: the first Enter was not
		// confirmed and was retried.
		assert.equal(enters.length, 2);
		assert.equal(captureIndex, 4);
	});

	it("Report an unconfirmed instruction instead of waiting for a server. [REQ-7]", async () => {
		const harness = createHarness({
			children: [ALPHA],
			discover: [[]],
			sendLine: async () => false,
		});

		await harness.core.handle({}, "alpha");

		const edits = harness.deliveries.filter((entry) => entry.kind === "edit");
		assert.equal(edits.length, 1);
		assert.match(edits[0]!.view.text, /Could not confirm/);
		assert.equal(harness.discoverCalls.length, 1);
	});

	it("Do not ask a child whose dev server is already running. [REQ-8]", async () => {
		const harness = createHarness({
			children: [ALPHA],
			discover: [[listener(5173, "/tree/alpha")]],
			urls: { 5173: { intranet: "http://lan:5173", tailscale: null } },
		});

		await harness.core.handle({}, "alpha");

		assert.equal(harness.lines.length, 0);
		const text = harness.deliveries[0]!.view.text;
		assert.match(text, /dev server up/);
		assert.match(text, /<a href="http:\/\/lan:5173">intranet<\/a>/);
	});

	it("Capture the port the child's dev server binds. [REQ-9]", async () => {
		const harness = createHarness({
			children: [ALPHA],
			discover: [[], [], [listener(4321, "/tree/alpha")]],
		});

		await harness.core.handle({}, "alpha");

		assert.equal(harness.discoverCalls.length, 3);
		const last = harness.deliveries.at(-1)!;
		assert.equal(last.kind, "edit");
		assert.match(last.view.text, /port <code>4321<\/code>/);
	});

	it("Deliver both reachable links as clickable HTML anchors. [REQ-10]", async () => {
		const harness = createHarness({
			children: [ALPHA],
			discover: [[], [listener(5173, "/tree/alpha")]],
			urls: { 5173: { intranet: "http://lan:5173", tailscale: "http://ts:5173" } },
		});

		await harness.core.handle({}, "alpha");

		const text = harness.deliveries.at(-1)!.view.text;
		assert.match(text, /<a href="http:\/\/lan:5173">intranet<\/a>/);
		assert.match(text, /<a href="http:\/\/ts:5173">Tailscale<\/a>/);
	});

	it("Say so when no reachable URL answers. [REQ-11]", async () => {
		const harness = createHarness({
			children: [ALPHA],
			discover: [[], [listener(5173, "/tree/alpha")]],
			urls: { 5173: { intranet: null, tailscale: null } },
		});

		await harness.core.handle({}, "alpha");

		const text = harness.deliveries.at(-1)!.view.text;
		assert.match(text, /No LAN or Tailscale address answered for port <code>5173<\/code>/);
		assert.doesNotMatch(text, /<a href=/);
	});

	it("Report a slow child without hanging the command. [REQ-12]", async () => {
		const harness = createHarness({
			children: [ALPHA],
			discover: [[]],
			waitMs: 6_000,
			pollMs: 2_000,
		});

		await harness.core.handle({}, "alpha");

		const text = harness.deliveries.at(-1)!.view.text;
		assert.match(text, /did not bring a dev server up within 6s/);
		assert.equal(harness.sleeps.length, 3);
		assert.ok(harness.time() >= 6_000);
	});

	it("Refresh the same message when the server comes up. [REQ-13]", async () => {
		const harness = createHarness({
			children: [ALPHA],
			discover: [[], [listener(5173, "/tree/alpha")]],
			urls: { 5173: { intranet: "http://lan:5173", tailscale: null } },
		});

		await harness.core.handle({}, "alpha");

		const sends = harness.deliveries.filter((entry) => entry.kind === "send");
		const edits = harness.deliveries.filter((entry) => entry.kind === "edit");
		assert.equal(sends.length, 1);
		assert.equal(edits.length, 1);
		assert.equal(edits[0]!.handle, sends[0]!.handle);
	});

	it("Ignore a second request while a child is already being asked. [REQ-14]", async () => {		let time = 0;
		let releaseSleep: (() => void) | null = null;
		let gated = true;
		const lines: string[] = [];
		const core = createDevServerCore({
			listChildren: async () => [ALPHA],
			discoverListeners: async () => [],
			sendLine: async (session) => {
				lines.push(session);
				return true;
			},
			detectReachableUrls: async () => ({ intranet: null, tailscale: null }),
			sendView: async () => "h",
			editView: async (handle) => handle,
			now: () => time,
			sleep: async (ms) => {
				time += ms;
				// Only the first poll blocks, so the first request is still waiting
				// when the second one arrives.
				if (gated) {
					gated = false;
					await new Promise<void>((resolve) => {
						releaseSleep = resolve;
					});
				}
			},
			waitMs: 10_000,
			pollMs: 2_000,
		});

		const first = core.handle({}, "alpha");
		await new Promise((resolve) => setImmediate(resolve));
		await core.handle({}, "alpha");
		assert.equal(lines.length, 1, "the second request must not send a second instruction");

		releaseSleep!();
		await first;
	});

	it("cancels in-flight waits on stop and serves a later session again", async () => {
		let time = 0;
		let releaseSleep: (() => void) | null = null;
		let gated = true;
		let portAvailable = false;
		const views: string[] = [];
		const core = createDevServerCore({
			listChildren: async () => [ALPHA],
			discoverListeners: async () =>
				portAvailable ? [listener(5173, "/tree/alpha")] : [],
			sendLine: async () => true,
			detectReachableUrls: async () => ({ intranet: null, tailscale: null }),
			sendView: async (view) => {
				views.push(view.text);
				return "h";
			},
			editView: async (handle, view) => {
				views.push(view.text);
				return handle;
			},
			now: () => time,
			sleep: async (ms) => {
				time += ms;
				if (gated) {
					gated = false;
					await new Promise<void>((resolve) => {
						releaseSleep = resolve;
					});
				}
			},
			waitMs: 10_000,
			pollMs: 2_000,
		});

		const first = core.handle({}, "alpha");
		await new Promise((resolve) => setImmediate(resolve));
		core.stop();
		releaseSleep!();
		await first;
		assert.equal(views.length, 1, "stop suppresses the timeout edit of the cancelled flow");

		portAvailable = true;
		await core.handle({}, "alpha");
		assert.equal(views.length, 2, "a session after stop starts a fresh flow");
		assert.match(views[1] ?? "", /dev server up/);
	});

	it("Register the command on session_start and dispose it on shutdown. [REQ-15]", async () => {
		const { pi, fire } = createFakePi();
		const handled: string[] = [];
		const core: DevServerCore = {
			handle: async (_target, args) => {
				handled.push(args);
			},
			stop: () => {},
		};
		const fake = createFakeBridge();
		registerDevServerSurfaces(pi, core, fake.bridge);

		assert.equal(fake.active().length, 0, "nothing is registered before a session");

		await fire("session_start");
		assert.equal(fake.active().length, 1);
		const registration = fake.active()[0]!.registration;
		assert.equal(registration.name, COMMAND_NAME);
		assert.equal(registration.showInMenu, true);
		registration.handler({ args: "alpha" });
		assert.deepEqual(handled, ["alpha"], "the command handler dispatches to the flow");

		// A second session_start (reload) re-registers without duplicating.
		await fire("session_start");
		assert.equal(fake.active().length, 1);
		assert.equal(fake.commands.filter((command) => command.disposed).length, 1);

		fire("session_shutdown");
		assert.equal(fake.active().length, 0);
	});

	it("Ship the command inside the mu-commander project extensions directory. [REQ-16]", () => {
		const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
		assert.equal(
			existsSync(resolve(repoRoot, ".pi/extensions/dev-server-command.ts")),
			true,
			"the command must be a project extension",
		);
		assert.equal(
			existsSync(resolve(repoRoot, ".pi/extensions/lib/dev-server-command-core.ts")),
			true,
		);
		assert.equal(
			existsSync(join(resolveAgentDir(process.env), "extensions", "dev-server-command.ts")),
			false,
			"the command must not be installed in the global extensions directory",
		);
	});

	it("List children of every repository's pool, labeled with their repo. [REQ-17]", async () => {
		// The fake spans two treehouse pools: a mu-commander worktree and a
		// riak-t worktree. Discovery must keep both [REQ-17].
		const run = createTmuxRun({
			sessions: ["pi-main", "pi-alpha", "pi-riak-166-driver-info-view"],
			paths: {
				"pi-alpha": "/pool/mu-commander-70dc7d/1/mu-commander",
				"pi-riak-166-driver-info-view": "/pool/riak-t-f778a7/1/riak-t",
			},
		});
		const harness = createHarness({ children: await listChildSessions(run, "pi-main") });

		await harness.core.handle({}, "");

		assert.equal(harness.deliveries.length, 1);
		const text = harness.deliveries[0]!.view.text;
		assert.match(text, /repo <code>mu-commander<\/code>/);
		assert.match(text, /repo <code>riak-t<\/code>/);
		assert.match(text, /riak-166-driver-info-view/);
		assert.match(text, /\/pool\/riak-t-f778a7\/1\/riak-t/);
		// Ordered by task name: alpha (mu-commander) before the riak-t child.
		assert.ok(text.indexOf("alpha") < text.indexOf("riak-166-driver-info-view"));
		assert.doesNotMatch(text, /No child session is running/);
		assert.doesNotMatch(text, /pi-main/);
	});

	it("Select a child of another repository end to end. [REQ-18]", async () => {
		const riak: ChildSession = {
			task: "riak-166-driver-info-view",
			session: "pi-riak-166-driver-info-view",
			worktree: "/pool/riak-t-f778a7/2/riak-t",
			repo: "riak-t",
		};
		const harness = createHarness({
			children: [riak],
			discover: [[], [listener(4173, riak.worktree)]],
			urls: { 4173: { intranet: "http://lan:4173", tailscale: "http://ts:4173" } },
		});

		await harness.core.handle({}, "riak-166");

		// The ask lands in the foreign pool's pane, and its listener is captured.
		assert.deepEqual(
			harness.lines.map((line) => line.session),
			["pi-riak-166-driver-info-view"],
		);
		assert.equal(harness.lines[0]!.text, childInstruction("riak-166-driver-info-view"));
		const sends = harness.deliveries.filter((entry) => entry.kind === "send");
		const edits = harness.deliveries.filter((entry) => entry.kind === "edit");
		assert.equal(sends.length, 1);
		assert.equal(edits.length, 1);
		assert.equal(edits[0]!.handle, sends[0]!.handle);
		const text = edits[0]!.view.text;
		assert.match(text, /port <code>4173<\/code>/);
		assert.match(text, /<a href="http:\/\/lan:4173">intranet<\/a>/);
		assert.match(text, /<a href="http:\/\/ts:4173">Tailscale<\/a>/);
	});
});
