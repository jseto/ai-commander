/**
 * Telegram `/mudevserver`: list the running child pi sessions of the
 * mu-commander orchestrator pattern, ask the selected one to start its
 * project's dev server, discover the port it binds, and deliver the
 * phone-reachable intranet and Tailscale links as HTML anchors.
 *
 * Wiring only: this file knows tmux, /proc, and the extension's own location;
 * the flow lives in `lib/dev-server-command-core.ts` and the pi-telegram
 * surface in `telegram-bridge.ts`, both injected. See
 * `specs/dev-server-command/` for the requirements and design.
 *
 * Install scope: this is a *project* extension (`.pi/extensions/` inside the
 * mu-commander repository), so pi loads it only for sessions of this project -
 * no runtime session gate is needed. The child menu is still narrowed to
 * checkouts of the same repository because the orchestrator can have children
 * of other repositories running. Registration follows the deferred
 * `session_start` pattern (pi-telegram binds its registries after extension
 * factories run) and is disposed on `session_shutdown`.
 */

import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { currentTmuxSession, type RunExec } from "./lib/child-sessions.ts";
import {
	createDevServerCore,
	type DeliveryTarget,
	type DevServerCore,
	type DevServerCoreDeps,
	type DevServerView,
	type ViewHandle,
} from "./lib/dev-server-command-core.ts";
import { scanListeningProcesses } from "./lib/listening-ports.ts";
import { detectInternalUrl, detectTailscaleUrl } from "./lib/reachable-url.ts";
import { createRepoIdentity, listScopedChildren, type RepoIdentity } from "./lib/repo-scope.ts";
import { sendLine } from "./lib/tmux-send.ts";
import {
	createTelegramBridge,
	type TelegramBridge,
	type TelegramCommandContext,
} from "./telegram-bridge.ts";

const execFileAsync = promisify(execFile);

export const COMMAND_NAME = "mudevserver";
const COMMAND_EMOJI = "🖥";

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
	projectRoot: string;
	identity: RepoIdentity;
	bridge: TelegramBridge;
}

/** The production core: scoped tmux children, /proc listeners, bridge delivery. */
export function createWiredCore(options: WiredCoreOptions): DevServerCore {
	const deps: DevServerCoreDeps = {
		listChildren: async () =>
			listScopedChildren(
				runExec,
				options.identity,
				options.projectRoot,
				await currentTmuxSession(runExec),
			),
		discoverListeners: (roots) => scanListeningProcesses(roots),
		sendLine: (session, text) => sendLine(runExec, session, text),
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
		now: () => Date.now(),
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		waitMs: waitMsFromEnv(process.env),
	};
	return createDevServerCore(deps);
}

/**
 * Deferred registration of the command. Exported so tests can drive the
 * lifecycle with a fake pi and a recording bridge.
 */
export function registerDevServerSurfaces(
	pi: PiExtensionApi,
	core: DevServerCore,
	bridge: TelegramBridge,
): void {
	let unregisterCommand: (() => void) | null = null;

	function dispose(): void {
		unregisterCommand?.();
		unregisterCommand = null;
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
		// previous handler before claiming the name again. The bridge resolves
		// pi-telegram lazily, so registration is asynchronous.
		dispose();
		try {
			unregisterCommand = await bridge.registerCommand({
				name: COMMAND_NAME,
				description: "List or start a mu-commander child's dev server",
				emoji: COMMAND_EMOJI,
				showInMenu: true,
				handler: (ctx: TelegramCommandContext) => dispatch({}, ctx.args),
			});
		} catch (error) {
			unregisterCommand = null;
			bridge.recordError("dev-server-command", error, { phase: "register-command" });
		}
	}

	function cleanup(): void {
		dispose();
		core.stop();
	}

	pi.on("session_start", register);
	pi.on("session_shutdown", cleanup);
}

/** The repository checkout that contains this extension (`<repo>/.pi/extensions/`). */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export default function (pi: PiExtensionApi) {
	const identity = createRepoIdentity(runExec);
	const bridge = createTelegramBridge();
	registerDevServerSurfaces(
		pi,
		createWiredCore({ projectRoot: PROJECT_ROOT, identity, bridge }),
		bridge,
	);
}
