import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	flattenPane,
	paneProbe,
	sendLine,
	type ExecResult,
	type RunExec,
} from "../../.pi/extensions/lib/tmux-send.ts";

interface FakeTmux {
	run: RunExec;
	calls: string[][];
	enterCount(): number;
}

/** `panes[i]` is the flattened pane content returned by the i-th capture. */
function createFakeTmux(panes: string[]): FakeTmux {
	const calls: string[][] = [];
	let captures = 0;
	const run: RunExec = async (file, args): Promise<ExecResult> => {
		calls.push([file, ...args]);
		if (args[0] === "capture-pane") {
			const pane = panes[Math.min(captures, panes.length - 1)] ?? "";
			captures += 1;
			return { stdout: pane, stderr: "" };
		}
		return { stdout: "", stderr: "" };
	};
	return {
		run,
		calls,
		enterCount: () =>
			calls.filter(
				(call) => call[0] === "tmux" && call[1] === "send-keys" && call.at(-1) === "Enter",
			).length,
	};
}

const immediateSleep = async (): Promise<void> => {};

describe("verified tmux send-line", () => {
	it("flattens whitespace and keeps the composer-visible tail", () => {
		assert.equal(flattenPane("a b\n  c\td"), "abcd");
		assert.equal(paneProbe("ab cd", 3), "bcd");
		assert.equal(paneProbe("short", 60), "short");
	});

	it("types the text first, then sends Enter separately until the pane changes", async () => {
		const text = "please start the dev server";
		const shown = `> ${text}`;
		const tmux = createFakeTmux([shown, shown, shown, ""]);

		const confirmed = await sendLine(tmux.run, "pi-alpha", text, { sleep: immediateSleep });

		assert.equal(confirmed, true);
		assert.deepEqual(tmux.calls[0], ["tmux", "send-keys", "-t", "pi-alpha", "-l", text]);
		assert.equal(tmux.calls[1]?.[0], "tmux");
		assert.equal(tmux.calls[1]?.[1], "capture-pane");
		assert.equal(tmux.enterCount(), 2, "the first Enter was not confirmed and was retried");
		assert.equal(tmux.calls.at(-1)?.[1], "capture-pane");
	});

	it("retypes when the text never appears in the pane", async () => {
		const text = "start it";
		const tmux = createFakeTmux(["", `> ${text}`, `> ${text}`, ""]);
		const warnings: string[] = [];

		const confirmed = await sendLine(tmux.run, "pi-alpha", text, {
			sleep: immediateSleep,
			onWarn: (message) => warnings.push(message),
		});

		assert.equal(confirmed, true);
		const typings = tmux.calls.filter(
			(call) => call[1] === "send-keys" && call.at(-2) !== "Enter" && call.at(-1) === text,
		);
		assert.equal(typings.length, 2, "the text must be typed again when it never appeared");
		assert.match(warnings[0] ?? "", /retyping/);
	});

	it("reports failure when the pane stays frozen through every Enter", async () => {
		const text = "start it";
		const shown = `> ${text}`;
		const tmux = createFakeTmux([shown, shown, shown, shown, shown, shown]);
		const warnings: string[] = [];

		const confirmed = await sendLine(tmux.run, "pi-alpha", text, {
			attempts: 3,
			sleep: immediateSleep,
			onWarn: (message) => warnings.push(message),
		});

		assert.equal(confirmed, false);
		assert.equal(tmux.enterCount(), 3);
		assert.match(warnings.at(-1) ?? "", /could not confirm/);
	});
});
