/**
 * The `/mudevserver` flow, independent of pi, pi-telegram, tmux, and /proc.
 *
 * Everything below the interface is injected: child listing, listener
 * discovery, the verified send, reachable-URL detection, the Telegram view
 * sender, and the clock. The wiring file supplies the real adapters; tests
 * supply fakes and observe delivered/edited views and sent instructions.
 *
 * Flow: render the child menu, resolve a selection (task name, unique prefix,
 * or 1-based menu index), skip the ask when a non-loopback dev server already
 * listens in the child's worktree, otherwise send the verified instruction and
 * poll for the listener, refreshing one logical Telegram view as the server
 * comes up (or on timeout / unconfirmed send).
 */

import type { ChildSession } from "./child-sessions.ts";
import { devServerPorts, type ListeningProcess } from "./listening-ports.ts";

export interface DevServerView {
	text: string;
	parseMode: "html";
}

export type ViewHandle = unknown;

export interface DeliveryTarget {
	chatId?: number;
	threadId?: number;
	replyToMessageId?: number;
}

export interface ReachableUrls {
	intranet: string | null;
	tailscale: string | null;
}

export interface DevServerCoreDeps {
	listChildren(): Promise<ChildSession[]>;
	discoverListeners(roots: string[]): Promise<ListeningProcess[]>;
	sendLine(session: string, text: string): Promise<boolean>;
	detectReachableUrls(port: number): Promise<ReachableUrls>;
	sendView(view: DevServerView, target: DeliveryTarget): Promise<ViewHandle | null>;
	editView(handle: ViewHandle, view: DevServerView): Promise<ViewHandle | null>;
	now(): number;
	sleep(ms: number): Promise<void>;
	waitMs?: number;
	pollMs?: number;
}

export interface DevServerCore {
	handle(target: DeliveryTarget, args: string): Promise<void>;
	stop(): void;
}

export const DEFAULT_WAIT_MS = 120_000;
export const DEFAULT_POLL_MS = 2_000;

/** The instruction typed into the child's tmux pane. */
export function childInstruction(task: string): string {
	return [
		"[orchestrator] Start this project's dev server for your worktree now:",
		"run it in the background, bound to 0.0.0.0 (pass the repo's documented host flag),",
		"leave it running, and keep working on your task. No reply needed.",
		`(dev-server request for ${task})`,
	].join(" ");
}

export function createDevServerCore(deps: DevServerCoreDeps): DevServerCore {
	const waitMs = deps.waitMs ?? DEFAULT_WAIT_MS;
	const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
	const inFlight = new Map<string, Promise<void>>();
	// A generation counter, not a boolean: `stop()` cancels the flows that are
	// polling now, while a later session (session_start re-fires on session
	// replacement) can start fresh flows from the same core instance.
	let generation = 0;

	async function handle(target: DeliveryTarget, args: string): Promise<void> {
		let children: ChildSession[];
		try {
			children = await deps.listChildren();
		} catch (error) {
			await deps.sendView(errorView("Could not list child sessions", error), target);
			return;
		}

		const selection = resolveSelection(args, children);
		if (selection.kind === "menu") {
			await deps.sendView(await menuView(children), target);
			return;
		}
		if (selection.kind === "error") {
			await deps.sendView({ text: selection.message, parseMode: "html" }, target);
			return;
		}

		const child = selection.child;
		const running = await discoverFor(child.worktree);
		if (running.length > 0) {
			await deps.sendView(await readyView(child, running[0]!.port), target);
			return;
		}
		if (inFlight.has(child.task)) {
			await deps.sendView(
				{
					text: `⏳ <code>${escapeHtml(child.task)}</code> is already being asked to start its dev server.`,
					parseMode: "html",
				},
				target,
			);
			return;
		}

		const flow = runFlow(child, target);
		inFlight.set(child.task, flow);
		try {
			await flow;
		} finally {
			if (inFlight.get(child.task) === flow) inFlight.delete(child.task);
		}
	}

	async function runFlow(child: ChildSession, target: DeliveryTarget): Promise<void> {
		const startedAt = generation;
		// Delivery first: an unauthorized chat/thread cannot send the view, and
		// without a delivered view there is no reason to touch the child at all.
		const handle = await deps.sendView(startingView(child), target);
		if (!handle) return;

		let confirmed = false;
		try {
			confirmed = await deps.sendLine(child.session, childInstruction(child.task));
		} catch {
			confirmed = false;
		}
		if (generation !== startedAt) return;
		if (!confirmed) {
			await deps.editView(handle, sendFailedView(child));
			return;
		}

		const deadline = deps.now() + waitMs;
		while (generation === startedAt && deps.now() < deadline) {
			const running = await discoverFor(child.worktree);
			if (running.length > 0) {
				await deps.editView(handle, await readyView(child, running[0]!.port));
				return;
			}
			await deps.sleep(pollMs);
		}
		if (generation === startedAt) await deps.editView(handle, timeoutView(child, waitMs));
	}

	function stop(): void {
		generation += 1;
	}

	async function discoverFor(worktree: string): Promise<ListeningProcess[]> {
		try {
			return devServerPorts(await deps.discoverListeners([worktree]), worktree);
		} catch {
			return [];
		}
	}

	async function readyView(child: ChildSession, port: number): Promise<DevServerView> {
		let urls: ReachableUrls = { intranet: null, tailscale: null };
		try {
			urls = await deps.detectReachableUrls(port);
		} catch {
			// Keep the port and say plainly that no address answered.
		}
		const lines = [
			`🖥 <b>${escapeHtml(child.task)}</b> — dev server up (port <code>${port}</code>)`,
			`repo <code>${escapeHtml(child.repo)}</code> · worktree <code>${escapeHtml(child.worktree)}</code>`,
		];
		const links = linkLines(urls);
		if (links.length > 0) lines.push(...links);
		else {
			lines.push(
				`⚠️ No LAN or Tailscale address answered for port <code>${port}</code> — the server may be bound to loopback only.`,
			);
		}
		return { text: lines.join("\n"), parseMode: "html" };
	}

	async function menuView(children: ChildSession[]): Promise<DevServerView> {
		if (children.length === 0) {
			return {
				text: "🖥 <b>Child dev servers</b>\n\nNo child session is running.",
				parseMode: "html",
			};
		}
		let listeners: ListeningProcess[] = [];
		try {
			listeners = await deps.discoverListeners(children.map((child) => child.worktree));
		} catch {
			// Entries then report no server rather than failing the whole menu.
		}
		const rows = await Promise.all(
			children.map(async (child) => {
				const running = devServerPorts(listeners, child.worktree);
				if (running.length === 0) return { child, port: null, urls: null };
				const port = running[0]!.port;
				let urls: ReachableUrls = { intranet: null, tailscale: null };
				try {
					urls = await deps.detectReachableUrls(port);
				} catch {
					// Fall through to the "no reachable URL" suffix.
				}
				return { child, port, urls };
			}),
		);

		const lines = ["🖥 <b>Child dev servers</b>", ""];
		rows.forEach((row, index) => {
			lines.push(`<b>${index + 1}.</b> <code>${escapeHtml(row.child.task)}</code>`);
			lines.push(
				`    repo <code>${escapeHtml(row.child.repo)}</code> · <code>${escapeHtml(row.child.worktree)}</code>`,
			);
			if (row.port === null) {
				lines.push("    ⚫ no dev server");
				return;
			}
			const links = row.urls ? linkLines(row.urls) : [];
			lines.push(
				`    🟢 port <code>${row.port}</code>${links.length > 0 ? ` · ${links.join(" · ")}` : " (no reachable URL answered)"}`,
			);
		});
		lines.push("", "Reply <code>/mudevserver &lt;number | task&gt;</code> to start or open one.");
		return { text: lines.join("\n"), parseMode: "html" };
	}

	type Selection =
		| { kind: "menu" }
		| { kind: "child"; child: ChildSession }
		| { kind: "error"; message: string };

	function resolveSelection(args: string, children: ChildSession[]): Selection {
		const raw = args.trim();
		if (!raw) return { kind: "menu" };
		if (children.length === 0) {
			return { kind: "error", message: "🖥 No child session is running." };
		}

		const token = raw.split(/\s+/)[0]!.replace(/^\/+/, "");
		if (/^\d+$/.test(token)) {
			const child = children[Number(token) - 1];
			if (child) return { kind: "child", child };
			return {
				kind: "error",
				message: `⚠️ There is no child ${escapeHtml(token)}. Send <code>/mudevserver</code> for the list.`,
			};
		}

		const name = token.startsWith("pi-") ? token.slice(3) : token;
		const exact = children.find((child) => child.task === name);
		if (exact) return { kind: "child", child: exact };

		const candidates = children.filter((child) => child.task.startsWith(name));
		if (candidates.length === 1) return { kind: "child", child: candidates[0]! };
		if (candidates.length > 1) {
			return {
				kind: "error",
				message: `⚠️ <code>${escapeHtml(name)}</code> matches ${candidates.length} children: ${candidates.map((child) => `<code>${escapeHtml(child.task)}</code>`).join(", ")}. Use the full task name or the menu number.`,
			};
		}
		return {
			kind: "error",
			message: `⚠️ No child session matches <code>${escapeHtml(name)}</code>. Send <code>/mudevserver</code> for the list.`,
		};
	}

	function startingView(child: ChildSession): DevServerView {
		return {
			text: [
				`🖥 <b>${escapeHtml(child.task)}</b> — asking the child to start its dev server…`,
				`repo <code>${escapeHtml(child.repo)}</code> · worktree <code>${escapeHtml(child.worktree)}</code>`,
			].join("\n"),
			parseMode: "html",
		};
	}

	function sendFailedView(child: ChildSession): DevServerView {
		return {
			text: `⚠️ Could not confirm that <code>${escapeHtml(child.task)}</code> received the dev-server instruction — check its tmux pane (<code>tmux attach -t ${escapeHtml(child.session)}</code>) and try again.`,
			parseMode: "html",
		};
	}

	function timeoutView(child: ChildSession, waitedMs: number): DevServerView {
		const seconds = Math.max(1, Math.round(waitedMs / 1000));
		return {
			text: [
				`⌛ <b>${escapeHtml(child.task)}</b> did not bring a dev server up within ${seconds}s.`,
				`The child may still be starting it — check its tmux pane (<code>tmux attach -t ${escapeHtml(child.session)}</code>) and run <code>/mudevserver ${escapeHtml(child.task)}</code> again.`,
			].join("\n"),
			parseMode: "html",
		};
	}

	return { handle, stop };
}

function linkLines(urls: ReachableUrls): string[] {
	const lines: string[] = [];
	if (urls.intranet) {
		lines.push(`🏠 <a href="${escapeAttribute(urls.intranet)}">intranet</a> — <code>${escapeHtml(urls.intranet)}</code>`);
	}
	if (urls.tailscale) {
		lines.push(`🔒 <a href="${escapeAttribute(urls.tailscale)}">Tailscale</a> — <code>${escapeHtml(urls.tailscale)}</code>`);
	}
	return lines;
}

function errorView(prefix: string, error: unknown): DevServerView {
	const message = error instanceof Error ? error.message : String(error);
	return {
		text: `⚠️ ${escapeHtml(prefix)}: <code>${escapeHtml(message)}</code>`,
		parseMode: "html",
	};
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(text: string): string {
	return escapeHtml(text).replace(/"/g, "&quot;");
}
