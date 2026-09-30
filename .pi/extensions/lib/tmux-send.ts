/**
 * Verified tmux send-line, ported from `scripts/_sub-common.sh:tmux_send_line`
 * (mu-commander main repo) so a Telegram-originated instruction reaches a
 * child pi session the same way the orchestrator sends one.
 *
 * A bare `send-keys -l` plus `Enter` races the target TUI's startup: pi can be
 * mid-redraw when the Enter lands, the keystroke is dropped, and the text stays
 * parked in the child's composer. This helper defends both halves: it retypes
 * when the text never appears in `capture-pane`, and it retries Enter while the
 * flattened pane content stays frozen (an unsubmitted line looks exactly like
 * a static screen). Extra Enters on an empty composer are harmless; a silently
 * unsent instruction is not. Returns true only when the pane changed after an
 * Enter - i.e. the line was confirmed submitted.
 */

export interface ExecResult {
	stdout: string;
	stderr: string;
}

export type RunExec = (file: string, args: string[]) => Promise<ExecResult>;

export interface SendLineOptions {
	/** Enter retries while the pane stays frozen. */
	attempts?: number;
	/** Seconds-equivalent settle time after each Enter. */
	settleMs?: number;
	/** Wait after typing before checking that the text landed. */
	retypeDelayMs?: number;
	sleep?: (ms: number) => Promise<void>;
	onWarn?: (message: string) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/** Non-whitespace characters only; tmux wraps text to the pane width. */
export function flattenPane(content: string): string {
	return content.replace(/\s+/g, "");
}

/**
 * The composer always shows the END of the text, so its tail survives pane
 * wrapping even when the head scrolls out of view.
 */
export function paneProbe(text: string, tail = 60): string {
	const flat = flattenPane(text);
	return flat.slice(Math.max(0, flat.length - tail));
}

export async function sendLine(
	run: RunExec,
	target: string,
	text: string,
	options: SendLineOptions = {},
): Promise<boolean> {
	const attempts = options.attempts ?? 4;
	const settleMs = options.settleMs ?? 1000;
	const retypeDelayMs = options.retypeDelayMs ?? 400;
	const sleep = options.sleep ?? defaultSleep;
	const probe = paneProbe(text);

	for (let attempt = 0; attempt < 2; attempt += 1) {
		await run("tmux", ["send-keys", "-t", target, "-l", text]);
		await sleep(retypeDelayMs);
		const pane = flattenPane((await capture(run, target)).stdout);
		if (!probe || pane.includes(probe)) break;
		options.onWarn?.(`text not visible in ${target} yet; retyping`);
	}

	let before = flattenPane((await capture(run, target)).stdout);
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		await run("tmux", ["send-keys", "-t", target, "Enter"]);
		await sleep(settleMs);
		const after = flattenPane((await capture(run, target)).stdout);
		if (after !== before) return true;
		before = after;
	}

	options.onWarn?.(`could not confirm that ${target} picked up the line; check the pane`);
	return false;
}

function capture(run: RunExec, target: string): Promise<ExecResult> {
	return run("tmux", ["capture-pane", "-t", target, "-p"]);
}
