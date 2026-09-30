import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createWiredCore, TAP_SURFACE_ID } from "../../.pi/extensions/dev-server-command.ts";
import type { RunExec } from "../../.pi/extensions/lib/child-sessions.ts";
import type { DevServerView, ViewHandle } from "../../.pi/extensions/lib/dev-server-command-core.ts";
import type {
	TelegramBridge,
	TelegramCommandRegistration,
	TelegramSectionRegistration,
} from "../../.pi/extensions/lib/telegram-bridge.ts";

/**
 * The cross-repo seam, exercised through the production wiring
 * (`createWiredCore`) instead of the flow's injected deps: the old
 * repo-scope.test.ts proved the git-common-dir *filter*; this file proves the
 * filter is gone - children of every treehouse pool are listed and the
 * selected foreign child is asked through the real send-line path.
 */

interface RecordedSend {
	session: string;
	text: string;
	enters: number;
}

/** Fake tmux/git spanning two treehouse pools (mu-commander and riak-t). */
function createRun(config: {
	current: string | null;
	sessions: string[];
	paths: Record<string, string>;
	sends: RecordedSend[];
}): RunExec {
	let typed: { session: string; text: string } | null = null;
	let enterCount = 0;
	return async (file, args) => {
		const empty = { stdout: "", stderr: "" };
		if (file === "git") {
			// `git -C <path> rev-parse --show-toplevel`
			return { stdout: `${args[1] ?? ""}\n`, stderr: "" };
		}
		if (file !== "tmux") return empty;
		const [subcommand, ...rest] = args;
		if (subcommand === "list-sessions") {
			return { stdout: `${config.sessions.join("\n")}\n`, stderr: "" };
		}
		if (subcommand === "display-message") {
			const targetIndex = rest.indexOf("-t");
			if (targetIndex === -1) {
				// `display-message -p '#S'`: the invoking session.
				return { stdout: `${config.current ?? ""}\n`, stderr: "" };
			}
			const session = rest[targetIndex + 1] ?? "";
			return { stdout: `${config.paths[session] ?? ""}\n`, stderr: "" };
		}
		if (subcommand === "send-keys") {
			const session = rest[rest.indexOf("-t") + 1] ?? "";
			if (rest.includes("-l")) {
				const text = rest[rest.indexOf("-l") + 1] ?? "";
				typed = { session, text };
				enterCount = 0;
				config.sends.push({ session, text, enters: 0 });
				return empty;
			}
			if (rest.at(-1) === "Enter" && typed) {
				enterCount += 1;
				const send = config.sends.find((entry) => entry.session === typed!.session);
				if (send) send.enters += 1;
			}
			return empty;
		}
		if (subcommand === "capture-pane") {
			// The pane shows the typed line and changes after each Enter, so
			// the verified send confirms on its first attempt.
			return { stdout: `${typed?.text ?? ""}\nentered:${enterCount}\n`, stderr: "" };
		}
		return empty;
	};
}

function createRecordingBridge() {
	const views: DevServerView[] = [];
	const edits: string[] = [];
	const errors: unknown[] = [];
	const registrations: TelegramCommandRegistration[] = [];
	const sections: TelegramSectionRegistration[] = [];
	const bridge: TelegramBridge = {
		registerCommand: async (registration) => {
			registrations.push(registration);
			return () => {};
		},
		registerSection: async (registration) => {
			sections.push(registration);
			return () => {};
		},
		// Like production: callbacks exist only for the registered tap surface.
		sectionCallbackData: async (sectionId, action, payload) =>
			sectionId === TAP_SURFACE_ID ? `section:3:${action}:${payload}` : null,
		sendView: async (view: DevServerView) => {
			views.push(view);
			return "h1" as ViewHandle;
		},
		editView: async (handle: ViewHandle, view: DevServerView) => {
			edits.push(view.text);
			return handle;
		},
		recordError: (_category, error) => {
			errors.push(error);
		},
	};
	return { bridge, views, edits, errors, registrations, sections };
}

/** The two pools the fake spans: a mu-commander and a riak-t worktree. */
const POOLS = {
	mu: "/pool/mu-commander-70dc7d/2/mu-commander",
	riak: "/pool/riak-t-f778a7/1/riak-t",
};

function poolRun(sends: RecordedSend[] = []): RunExec {
	return createRun({
		current: "pi-main",
		sessions: ["pi-main", "pi-alpha", "pi-riak-166-driver-info-view"],
		paths: {
			"pi-alpha": POOLS.mu,
			"pi-riak-166-driver-info-view": POOLS.riak,
		},
		sends,
	});
}

describe("cross-repo child menu through the production wiring", () => {
	it("lists children of every treehouse pool with their repo label. [REQ-17]", async () => {
		const { bridge, views, errors } = createRecordingBridge();
		const core = createWiredCore({ bridge, run: poolRun() });

		await core.handle({}, "");

		assert.deepEqual(errors, [], "the wiring must not record errors");
		assert.equal(views.length, 1, "one menu message");
		const view = views[0]!;
		const text = view.text;
		assert.match(text, /<b>1\.<\/b> <code>alpha<\/code>/);
		assert.match(text, /repo <code>mu-commander<\/code>/);
		assert.match(text, /<b>2\.<\/b> <code>riak-166-driver-info-view<\/code>/);
		assert.match(text, /repo <code>riak-t<\/code>/);
		assert.match(text, /\/pool\/riak-t-f778a7\/1\/riak-t/);
		assert.doesNotMatch(text, /No child session is running/);
		assert.doesNotMatch(text, /pi-main/);
		// The tap keyboard travels through the production wiring: the bridge
		// builds it only for the registered tap surface id [REQ-19].
		assert.deepEqual(view.replyMarkup, {
			inline_keyboard: [
				[{ text: "⚫ alpha · mu-commander", callback_data: "section:3:select:alpha" }],
				[
					{
						text: "⚫ riak-166-driver-info-view · riak-t",
						callback_data: "section:3:select:riak-166-driver-info-view",
					},
				],
			],
		});
	});

	it("asks the selected child of another repository through the verified send. [REQ-18]", async () => {
		const sends: RecordedSend[] = [];
		const { bridge, edits } = createRecordingBridge();
		// No listener can exist under a fake worktree path, and a zero wait
		// skips the poll: the flow must still reach the foreign child's pane.
		const previousWait = process.env.DEV_SERVER_WAIT_SECONDS;
		process.env.DEV_SERVER_WAIT_SECONDS = "0";
		try {
			const core = createWiredCore({ bridge, run: poolRun(sends) });

			await core.handle({}, "riak-166");
		} finally {
			if (previousWait === undefined) delete process.env.DEV_SERVER_WAIT_SECONDS;
			else process.env.DEV_SERVER_WAIT_SECONDS = previousWait;
		}

		assert.equal(sends.length, 1, "exactly one instruction, to the riak-t child");
		assert.equal(sends[0]!.session, "pi-riak-166-driver-info-view");
		assert.match(sends[0]!.text, /dev-server request for riak-166-driver-info-view/);
		assert.ok(sends[0]!.enters >= 1, "Enter was sent separately and confirmed");
		assert.equal(edits.length, 1, "the one logical message is edited, not re-sent");
	});
});
