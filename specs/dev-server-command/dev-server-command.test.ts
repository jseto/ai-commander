import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
	childInstruction,
	createDevServerCore,
	SELECT_ACTION,
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
	TAP_SURFACE_ID,
	registerDevServerSurfaces,
	type PiExtensionApi,
} from "../../.pi/extensions/dev-server-command.ts";
import type {
	TelegramBridge,
	TelegramCommandRegistration,
	TelegramSectionRegistration,
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
	buttonCallbackData?: DevServerCoreDeps["buttonCallbackData"];
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
		buttonCallbackData: options.buttonCallbackData,
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

interface RegisteredSection {
	registration: TelegramSectionRegistration;
	disposed: boolean;
}

function createFakeBridge(options: { failSection?: boolean } = {}) {
	const commands: RegisteredCommand[] = [];
	const sections: RegisteredSection[] = [];
	const errors: unknown[] = [];
	const bridge: TelegramBridge = {
		registerCommand: async (registration) => {
			const entry: RegisteredCommand = { registration, disposed: false };
			commands.push(entry);
			return () => {
				entry.disposed = true;
			};
		},
		registerSection: async (registration) => {
			if (options.failSection) {
				throw new Error("Telegram section registry not available.");
			}
			const entry: RegisteredSection = { registration, disposed: false };
			sections.push(entry);
			return () => {
				entry.disposed = true;
			};
		},
		// Mirrors production: a callback exists only while the section for the
		// requested id is registered (the registry token lives with it).
		sectionCallbackData: async (sectionId, action, payload) =>
			sections.some((entry) => !entry.disposed && entry.registration.id === sectionId)
				? `section:7:${action}:${payload}`
				: null,
		sendView: async () => null,
		editView: async (handle) => handle,
		recordError: (_category, error) => {
			errors.push(error);
		},
	};
	return {
		bridge,
		commands,
		sections,
		errors,
		active: () => commands.filter((command) => !command.disposed),
		activeSections: () => sections.filter((section) => !section.disposed),
	};
}

/** Let a dispatched (fire-and-forget) flow run until `done` or give up. */
async function settle(done: () => boolean, rounds = 100): Promise<void> {
	for (let round = 0; round < rounds && !done(); round += 1) {
		await new Promise((resolve) => setImmediate(resolve));
	}
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
			renderMenu: async () => ({ text: "menu", parseMode: "html" }),
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

	it("Offer each child as a tap button on the menu. [REQ-19]", async () => {
		const harness = createHarness({
			children: [ALPHA, BETA],
			discover: [[listener(5173, "/tree/beta")]],
			urls: { 5173: { intranet: null, tailscale: null } },
			buttonCallbackData: (task) => `section:7:select:${task}`,
		});

		await harness.core.handle({}, "");

		const view = harness.deliveries[0]!.view;
		assert.deepEqual(view.replyMarkup, {
			inline_keyboard: [
				[{ text: "⚫ alpha · alpha-repo", callback_data: "section:7:select:alpha" }],
				[{ text: "🟢 beta · beta-repo · :5173", callback_data: "section:7:select:beta" }],
			],
		});
		assert.match(view.text, /Tap a button/);

		// No child: the menu carries no keyboard at all.
		const empty = createHarness({ children: [] });
		await empty.core.handle({}, "");
		assert.equal(empty.deliveries[0]!.view.replyMarkup, undefined);
	});

	it("Run the same flow when a menu button is tapped. [REQ-20]", async () => {
		const { pi, fire } = createFakePi();
		const harness = createHarness({
			children: [ALPHA],
			discover: [[], [], [listener(5173, "/tree/alpha")]],
			urls: { 5173: { intranet: "http://lan:5173", tailscale: null } },
			buttonCallbackData: (task) => `section:7:select:${task}`,
		});
		const fake = createFakeBridge();
		registerDevServerSurfaces(pi, harness.core, fake.bridge);
		await fire("session_start");

		// The menu is on screen with its keyboard.
		await harness.core.handle({}, "");
		const menu = harness.deliveries[0]!;
		assert.equal(menu.view.replyMarkup?.inline_keyboard.length, 1);

		const verdict = await fake.activeSections()[0]!.registration.handleCallback({
			sectionId: TAP_SURFACE_ID,
			chatId: 1,
			messageId: 42,
			action: SELECT_ACTION,
			payload: "alpha",
			answerCallback: async () => {},
		});
		assert.equal(verdict, "handled");
		await settle(() => harness.deliveries.some((entry) => entry.kind === "edit"));

		// The tap runs the identical typed-selection flow: verified ask first…
		assert.deepEqual(
			harness.lines.map((line) => line.session),
			["pi-alpha"],
		);
		assert.equal(harness.lines[0]!.text, childInstruction("alpha"));
		// …delivered as one logical message of its own, not the menu's [REQ-20].
		const sends = harness.deliveries.filter((entry) => entry.kind === "send");
		const edits = harness.deliveries.filter((entry) => entry.kind === "edit");
		assert.equal(sends.length, 2, "menu plus one flow message");
		assert.equal(edits.length, 1);
		assert.equal(edits[0]!.handle, sends[1]!.handle, "the flow refreshes its own message");
		assert.notEqual(edits[0]!.handle, menu.handle, "the menu message is never edited");
		assert.match(edits[0]!.view.text, /dev server up/);
		assert.ok(menu.view.replyMarkup, "the menu keeps its list and buttons");
	});

	it("Answer the button tap before any selection work starts. [REQ-21]", async () => {
		const { pi, fire } = createFakePi();
		const events: string[] = [];
		const core: DevServerCore = {
			handle: async () => {
				events.push("flow");
			},
			renderMenu: async () => ({ text: "menu", parseMode: "html" }),
			stop: () => {},
		};
		const fake = createFakeBridge();
		registerDevServerSurfaces(pi, core, fake.bridge);
		await fire("session_start");

		const verdict = await fake.activeSections()[0]!.registration.handleCallback({
			sectionId: TAP_SURFACE_ID,
			chatId: 1,
			action: SELECT_ACTION,
			payload: "alpha",
			answerCallback: async () => {
				events.push("answer");
			},
		});

		assert.equal(verdict, "handled");
		assert.deepEqual(events, ["answer", "flow"]);
	});

	it("passes a callback it does not own back to pi-telegram", async () => {
		const { pi, fire } = createFakePi();
		const events: string[] = [];
		const core: DevServerCore = {
			handle: async () => {
				events.push("flow");
			},
			renderMenu: async () => ({ text: "menu", parseMode: "html" }),
			stop: () => {},
		};
		const fake = createFakeBridge();
		registerDevServerSurfaces(pi, core, fake.bridge);
		await fire("session_start");

		const verdict = await fake.activeSections()[0]!.registration.handleCallback({
			sectionId: TAP_SURFACE_ID,
			chatId: 1,
			action: "open",
			payload: "",
			answerCallback: async () => {
				events.push("answer");
			},
		});

		assert.equal(verdict, "pass");
		assert.deepEqual(events, [], "no answer and no flow for an unknown action");
	});

	it("Report a tap for a child that died since the menu was sent. [REQ-22]", async () => {
		const { pi, fire } = createFakePi();
		const children = [ALPHA, BETA];
		const harness = createHarness({
			children,
			discover: [[]],
			buttonCallbackData: (task) => `section:7:select:${task}`,
		});
		const fake = createFakeBridge();
		registerDevServerSurfaces(pi, harness.core, fake.bridge);
		await fire("session_start");
		await harness.core.handle({}, "");
		assert.equal(harness.deliveries[0]!.view.replyMarkup?.inline_keyboard.length, 2);

		// alpha's tmux session ends while the menu stays on screen.
		children.splice(children.indexOf(ALPHA), 1);
		await fake.activeSections()[0]!.registration.handleCallback({
			sectionId: TAP_SURFACE_ID,
			chatId: 1,
			messageId: 42,
			action: SELECT_ACTION,
			payload: "alpha",
			answerCallback: async () => {},
		});
		await settle(() => harness.deliveries.length >= 2);

		assert.equal(harness.deliveries.length, 2, "one error message, no flow message");
		assert.equal(harness.deliveries[1]!.kind, "send");
		assert.match(harness.deliveries[1]!.view.text, /No child session matches <code>alpha<\/code>/);
		assert.equal(harness.lines.length, 0, "no instruction is sent to any child");
		assert.equal(harness.discoverCalls.length, 1, "no port polling starts");
	});

	it("Register the tap surface with the command and dispose both on shutdown. [REQ-23]", async () => {
		const { pi, fire } = createFakePi();
		const core: DevServerCore = {
			handle: async () => {},
			renderMenu: async () => ({ text: "menu", parseMode: "html" }),
			stop: () => {},
		};
		const fake = createFakeBridge();
		registerDevServerSurfaces(pi, core, fake.bridge);

		assert.equal(fake.active().length, 0);
		assert.equal(fake.activeSections().length, 0);

		await fire("session_start");
		assert.equal(fake.active().length, 1);
		assert.equal(fake.activeSections().length, 1);
		const section = fake.activeSections()[0]!.registration;
		assert.equal(section.id, TAP_SURFACE_ID);
		assert.equal(section.label, "🖥 Dev server");
		assert.equal((await section.render()).text, "menu", "the menu entry point renders the menu");

		// A second session_start (reload) re-registers both without duplicating.
		await fire("session_start");
		assert.equal(fake.active().length, 1);
		assert.equal(fake.activeSections().length, 1);
		assert.equal(fake.commands.filter((command) => command.disposed).length, 1);
		assert.equal(fake.sections.filter((entry) => entry.disposed).length, 1);

		fire("session_shutdown");
		assert.equal(fake.active().length, 0);
		assert.equal(fake.activeSections().length, 0);
	});

	it("Keep a child whose button would not fit Telegram's callback limit. [REQ-25]", async () => {
		// The bridge enforces this cap (see telegram-bridge.test.ts); the menu
		// must degrade per child, not fail.
		const longTask = "a-really-long-task-name-that-pushes-the-selection-past-the-64-byte-cap";
		const long: ChildSession = {
			task: longTask,
			session: `pi-${longTask}`,
			worktree: `/tree/${longTask}`,
			repo: "big-repo",
		};
		const buttonCallbackData = (task: string) => {
			const data = `section:7:select:${task}`;
			return new TextEncoder().encode(data).byteLength <= 64 ? data : null;
		};
		const harness = createHarness({
			children: [ALPHA, long],
			discover: [[], []],
			buttonCallbackData,
			waitMs: 0,
		});

		await harness.core.handle({}, "");
		const view = harness.deliveries[0]!.view;
		assert.equal(view.replyMarkup?.inline_keyboard.length, 1, "only the fitting child has a button");
		assert.equal(view.replyMarkup!.inline_keyboard[0]![0]!.callback_data, "section:7:select:alpha");
		assert.ok(view.text.includes(longTask), "the over-long child is still listed");

		await harness.core.handle({}, longTask);
		assert.equal(harness.lines[0]?.session, `pi-${longTask}`, "typed selection still resolves it");
	});

	it("Keep the command alive when the tap surface cannot register. [REQ-26]", async () => {
		const { pi, fire } = createFakePi();
		const fake = createFakeBridge({ failSection: true });
		const harness = createHarness({
			children: [ALPHA],
			buttonCallbackData: (task) =>
				fake.bridge.sectionCallbackData(TAP_SURFACE_ID, SELECT_ACTION, task),
		});
		registerDevServerSurfaces(pi, harness.core, fake.bridge);

		await fire("session_start");
		assert.equal(fake.active().length, 1, "the command registered anyway");
		assert.equal(fake.activeSections().length, 0);
		assert.equal(fake.errors.length, 1, "one diagnostic records the section failure");

		await harness.core.handle({}, "");
		const menu = harness.deliveries[0]!;
		assert.ok(menu.view.text.includes("alpha"), "the menu is still delivered");
		assert.equal(menu.view.replyMarkup, undefined, "without a keyboard");
	});
});
