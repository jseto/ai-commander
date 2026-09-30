/**
 * Telegram `/mudevserver`: list the running child pi sessions of the
 * mu-commander orchestrator pattern, ask the selected one to start its
 * project's dev server, discover the port it binds, and deliver the
 * phone-reachable intranet and Tailscale links as HTML anchors. The menu
 * offers each child as a tap button on an inline keyboard next to the typed
 * selection [REQ-19]; a tap answers promptly and runs the identical flow
 * [REQ-20][REQ-21].
 *
 * Wiring only: this file knows tmux and /proc; the flow lives in
 * `lib/dev-server-command-core.ts` and the pi-telegram surface in
 * `telegram-bridge.ts`, both injected. See `specs/dev-server-command/` for
 * the requirements and design.
 *
 * Install scope: this is a *project* extension (`.pi/extensions/` inside the
 * mu-commander repository), so pi loads it only for sessions of this project -
 * no runtime session gate is needed. The child menu itself is cross-repo: it
 * lists every live `pi-<task>` child on the machine, whichever treehouse pool
 * its worktree belongs to, labeled with the child's repo [REQ-17].
 * Registration follows the deferred `session_start` pattern (pi-telegram binds
 * its registries after extension factories run) and disposes both the command
 * and the section tap surface on `session_shutdown` [REQ-23].
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
	currentTmuxSession,
	listChildSessions,
	type RunExec,
} from "./lib/child-sessions.ts";
import {
	createDevServerCore,
	SELECT_ACTION,
	type DeliveryTarget,
	type DevServerCore,
	type DevServerCoreDeps,
	type DevServerView,
	type ViewHandle,
} from "./lib/dev-server-command-core.ts";
import { scanListeningProcesses } from "./lib/listening-ports.ts";
import { detectInternalUrl, detectTailscaleUrl } from "./lib/reachable-url.ts";
import { sendLine } from "./lib/tmux-send.ts";
import {
	createTelegramBridge,
	type TelegramBridge,
	type TelegramCommandContext,
	type TelegramSectionCallbackContext,
} from "./lib/telegram-bridge.ts";

const execFileAsync = promisify(execFile);

export const COMMAND_NAME = "mudevserver";
const COMMAND_EMOJI = "🖥";
/**
 * The pi-telegram section id behind the menu's tap buttons: a section is the
 * package's managed callback surface (it answers the tap, then dispatches),
 * registered beside the command [REQ-19][REQ-23].
 */
export const TAP_SURFACE_ID = "dev-server-command";

/**
 * The slice of pi's `ExtensionAPI` this extension uses. Structural on purpose:
 * the real type comes from the host-provided `@earendil-works/pi-coding-agent`
 * package, which a project extension without `node_modules` cannot resolve.
 */
export interface PiExtensionApi {
	on(event: "session_start" | "session_shutdown", handler: () => void | Promise<void>): () => void;
}

export const runExec: RunExec = async (file, args) => {
	const { stdout, stderr } = await execFileAsync(file, args, {
		encoding: "utf8",
		timeout: 10_000,
		maxBuffer: 4_000_000,
	});
	return { stdout, stderr };
};

/** `DEV_SERVER_WAIT_SECONDS` overrides the 120 s default; invalid values ignored. */
export function waitMsFromEnv(env: Record<string, string | undefined>): number {
	const raw = env.DEV_SERVER_WAIT_SECONDS?.trim();
	if (raw) {
		const seconds = Number(raw);
		if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
	}
	return 120_000;
}

export interface WiredCoreOptions {
	bridge: TelegramBridge;
	/** Exec adapter; tests inject a fake tmux/git, production uses `runExec`. */
	run?: RunExec;
}

/** The production core: cross-repo tmux children, /proc listeners, bridge delivery. */
export function createWiredCore(options: WiredCoreOptions): DevServerCore {
	const run = options.run ?? runExec;
	const deps: DevServerCoreDeps = {
		// No repository filter: every live pi-<task> child on the machine is
		// listed, whichever treehouse pool its worktree belongs to [REQ-17].
		listChildren: async () => listChildSessions(run, await currentTmuxSession(run)),
		discoverListeners: (roots) => scanListeningProcesses(roots),
		sendLine: (session, text) => sendLine(run, session, text),
		detectReachableUrls: async (port) => {
			const [intranet, tailscale] = await Promise.all([
				detectInternalUrl(port),
				detectTailscaleUrl(port),
			]);
			return { intranet, tailscale };
		},
		sendView: (view: DevServerView, target: DeliveryTarget) =>
			options.bridge.sendView(view, target),
		editView: (handle: ViewHandle, view: DevServerView) =>
			options.bridge.editView(handle, view),
		// The menu's tap buttons: built by the bridge from the registered
		// section's token; null (no button for that child) when the tap
		// surface cannot build a callback [REQ-19][REQ-25].
		buttonCallbackData: (task) =>
			options.bridge.sectionCallbackData(TAP_SURFACE_ID, SELECT_ACTION, task),
		now: () => Date.now(),
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		waitMs: waitMsFromEnv(process.env),
	};
	return createDevServerCore(deps);
}

/**
 * Deferred registration of the command and its tap surface. Exported so tests
 * can drive the lifecycle with a fake pi and a recording bridge.
 */
export function registerDevServerSurfaces(
	pi: PiExtensionApi,
	core: DevServerCore,
	bridge: TelegramBridge,
): void {
	let unregisterCommand: (() => void) | null = null;
	let unregisterSection: (() => void) | null = null;

	function dispose(): void {
		unregisterCommand?.();
		unregisterCommand = null;
		unregisterSection?.();
		unregisterSection = null;
	}

	function dispatch(target: DeliveryTarget, args: string): void {
		// The flow can wait minutes for a slow child; never hold the Telegram
		// update loop on it. Failures are recorded through the bridge.
		void core.handle(target, args).catch((error) => {
			bridge.recordError("dev-server-command", error, { phase: "flow" });
		});
	}

	async function register(): Promise<void> {
		// Re-register defensively across reload/session replacement: drop the
		// previous handlers before claiming the names again. The bridge resolves
		// pi-telegram lazily, so registration is asynchronous.
		dispose();
		try {
			unregisterCommand = await bridge.registerCommand({
				name: COMMAND_NAME,
				description: "List or start a child's dev server (any repository)",
				emoji: COMMAND_EMOJI,
				showInMenu: true,
				handler: (ctx: TelegramCommandContext) => dispatch({}, ctx.args),
			});
		} catch (error) {
			unregisterCommand = null;
			bridge.recordError("dev-server-command", error, { phase: "register-command" });
		}
		// The tap surface: pi-telegram answers each tap through this section's
		// callback context [REQ-21], then the exact typed-selection flow runs
		// against the tapped task name [REQ-20]. A failure here must not take
		// the command down [REQ-26].
		try {
			unregisterSection = await bridge.registerSection({
				id: TAP_SURFACE_ID,
				label: "🖥 Dev server",
				order: 100,
				render: () => core.renderMenu(),
				handleCallback: async (ctx: TelegramSectionCallbackContext) => {
					if (ctx.action !== SELECT_ACTION) return "pass";
					await ctx.answerCallback();
					dispatch({}, ctx.payload);
					return "handled";
				},
			});
		} catch (error) {
			unregisterSection = null;
			bridge.recordError("dev-server-command", error, { phase: "register-section" });
		}
	}

	function cleanup(): void {
		dispose();
		core.stop();
	}

	pi.on("session_start", register);
	pi.on("session_shutdown", cleanup);
}

export default function (pi: PiExtensionApi) {
	const bridge = createTelegramBridge();
	registerDevServerSurfaces(pi, createWiredCore({ bridge }), bridge);
}
