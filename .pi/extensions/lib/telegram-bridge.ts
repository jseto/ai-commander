/**
 * The pi-telegram surface `/mudevserver` needs, isolated behind one seam.
 *
 * A project extension cannot `import "@llblab/pi-telegram"`: pi resolves an
 * extension's imports from the extension's own directory, mu-commander has no
 * `node_modules`, and pi-telegram is installed only in the global agent
 * directory (verified against pi's own jiti loader, which fails with
 * `Cannot find module '@llblab/pi-telegram/commands'`).
 *
 * The bridge therefore resolves the package's *public* API at runtime from the
 * global agent install (`PI_CODING_AGENT_DIR`, default `~/.pi/agent`):
 * `createRequire(<agentDir>/…).resolve("@llblab/pi-telegram/<subpath>")` honors
 * the package exports map, and the resolved files are dynamically imported
 * (`commands`, `sections`, `delivery`, `outbound`).
 * When pi-telegram is not installed the bridge is inert - command and tap
 * surface registration are no-ops, views report "not delivered" (which aborts
 * the flow before any child is touched), no selection callback can be built,
 * and one diagnostic is emitted.
 */

import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { DeliveryTarget, DevServerView, ViewHandle } from "./dev-server-command-core.ts";

/** The slice of pi-telegram's Telegram command context the handler uses. */
export interface TelegramCommandContext {
	args: string;
}

export interface TelegramCommandRegistration {
	name: string;
	description: string;
	emoji: string;
	showInMenu: boolean;
	handler: (ctx: TelegramCommandContext) => void;
}

/** The slice of pi-telegram's section callback context the tap handler uses. */
export interface TelegramSectionCallbackContext {
	sectionId: string;
	chatId: number;
	messageId?: number;
	action: string;
	payload: string;
	answerCallback(text?: string): Promise<void>;
}

/**
 * The tap-surface registration, structurally mirroring pi-telegram's section
 * contract (`@llblab/pi-telegram/sections`). `render` takes the section open
 * context at runtime; this extension ignores it and returns the child menu.
 */
export interface TelegramSectionRegistration {
	id: string;
	label: string;
	order?: number;
	render: () => DevServerView | Promise<DevServerView>;
	handleCallback: (
		ctx: TelegramSectionCallbackContext,
	) => "handled" | "pass" | Promise<"handled" | "pass">;
}

/** The pi-telegram operations the `/mudevserver` flow performs. */
export interface TelegramBridge {
	/** Register the bot command; a no-op disposer when pi-telegram is absent. */
	registerCommand(registration: TelegramCommandRegistration): Promise<() => void>;
	/** Register the tap surface; a no-op disposer when pi-telegram is absent. */
	registerSection(registration: TelegramSectionRegistration): Promise<() => void>;
	/**
	 * `section:<token>:<action>:<payload>` for the registered tap surface;
	 * null when pi-telegram is absent, the section did not register, or the
	 * data would exceed Telegram's 64-byte callback cap.
	 */
	sectionCallbackData(
		sectionId: string,
		action: string,
		payload: string,
	): Promise<string | null>;
	/** Send an HTML view; null when the target is unavailable or undeliverable. */
	sendView(view: DevServerView, target: DeliveryTarget): Promise<ViewHandle | null>;
	/** Edit the view behind a handle; null when the handle went stale. */
	editView(handle: ViewHandle, view: DevServerView): Promise<ViewHandle | null>;
	recordError(category: string, error: unknown, details?: Record<string, unknown>): void;
}

/** The loaded public pi-telegram API behind a single seam. */
export interface TelegramApi {
	registerCommand(registration: TelegramCommandRegistration): () => void;
	registerSection(registration: TelegramSectionRegistration): () => void;
	/** The registry token for a registered section id; null when absent. */
	getSectionToken(id: string): string | null;
	sendView(view: DevServerView, target: DeliveryTarget): Promise<ViewHandle | null>;
	editView(handle: ViewHandle, view: DevServerView): Promise<ViewHandle | null>;
	recordError(category: string, error: unknown, details?: Record<string, unknown>): void;
}

export type TelegramApiLoader = () => Promise<TelegramApi>;

interface TelegramDeliveryScope {
	kind: "instance" | "target";
	target?: { chatId: number; threadId?: number };
}

interface PiTelegramCommandsModule {
	registerTelegramCommand(registration: TelegramCommandRegistration): () => void;
}

interface PiTelegramSectionsModule {
	registerTelegramSection(registration: TelegramSectionRegistration): () => void;
	getTelegramSectionDiagnostics(): Array<{ id: string; token: string }>;
}

interface PiTelegramDeliveryResult {
	ok: boolean;
	value?: ViewHandle;
}

interface PiTelegramDeliveryModule {
	sendTelegramView(
		view: DevServerView,
		options: { scope: TelegramDeliveryScope; replyToMessageId?: number },
	): Promise<PiTelegramDeliveryResult>;
	editTelegramView(handle: ViewHandle, view: DevServerView): Promise<PiTelegramDeliveryResult>;
}

interface PiTelegramOutboundModule {
	recordTelegramRuntimeEvent(
		category: string,
		error: unknown,
		details?: Record<string, unknown>,
	): void;
}

/** `PI_CODING_AGENT_DIR` when set, else `~/.pi/agent`. */
export function resolveAgentDir(env: Record<string, string | undefined>): string {
	const configured = env.PI_CODING_AGENT_DIR?.trim();
	return configured ? configured : join(homedir(), ".pi", "agent");
}

/** Telegram's callback_data cap (pi-telegram's `TELEGRAM_CALLBACK_DATA_MAX_BYTES`). */
const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;

/** Load the public pi-telegram API from the global agent install. */
export async function loadTelegramApi(agentDir: string): Promise<TelegramApi> {
	// The file need not exist: createRequire only uses its path as the
	// resolution base, so bare specifiers resolve from <agentDir>/node_modules.
	const resolver = createRequire(join(agentDir, "mudevserver-bridge-resolver.cjs"));
	const commands = (await import(
		pathToFileURL(resolver.resolve("@llblab/pi-telegram/commands")).href
	)) as unknown as PiTelegramCommandsModule;
	const sections = (await import(
		pathToFileURL(resolver.resolve("@llblab/pi-telegram/sections")).href
	)) as unknown as PiTelegramSectionsModule;
	const delivery = (await import(
		pathToFileURL(resolver.resolve("@llblab/pi-telegram/delivery")).href
	)) as unknown as PiTelegramDeliveryModule;
	const outbound = (await import(
		pathToFileURL(resolver.resolve("@llblab/pi-telegram/outbound")).href
	)) as unknown as PiTelegramOutboundModule;

	return {
		registerCommand: (registration) => commands.registerTelegramCommand(registration),
		registerSection: (registration) => sections.registerTelegramSection(registration),
		getSectionToken: (id) =>
			sections.getTelegramSectionDiagnostics().find((entry) => entry.id === id)?.token ??
			null,
		sendView: async (view, target) => {
			const scope: TelegramDeliveryScope =
				target.chatId === undefined
					? { kind: "instance" }
					: {
							kind: "target",
							target: {
								chatId: target.chatId,
								...(target.threadId === undefined ? {} : { threadId: target.threadId }),
							},
						};
			const result = await delivery.sendTelegramView(view, {
				scope,
				...(target.replyToMessageId === undefined
					? {}
					: { replyToMessageId: target.replyToMessageId }),
			});
			return result.ok ? (result.value ?? null) : null;
		},
		editView: async (handle, view) => {
			const result = await delivery.editTelegramView(handle, view);
			return result.ok ? (result.value ?? handle) : null;
		},
		recordError: (category, error, details) =>
			outbound.recordTelegramRuntimeEvent(category, error, details),
	};
}

export interface TelegramBridgeOptions {
	load?: TelegramApiLoader;
	/** Receives the one diagnostic emitted when pi-telegram cannot be loaded. */
	warn?: (message: string, error: unknown) => void;
}

export function createTelegramBridge(options: TelegramBridgeOptions = {}): TelegramBridge {
	const load = options.load ?? (() => loadTelegramApi(resolveAgentDir(process.env)));
	const warn =
		options.warn ??
		((message, error) => {
			console.error(
				`[mudevserver] ${message}: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
	let api: Promise<TelegramApi> | null = null;
	let loadReported = false;
	const ensure = (): Promise<TelegramApi> => {
		api ??= load().catch((error) => {
			if (!loadReported) {
				loadReported = true;
				warn("pi-telegram is unavailable; /mudevserver is inert", error);
			}
			throw error;
		});
		return api;
	};

	return {
		registerCommand: async (registration) => {
			const loaded = await ensure().catch(() => null);
			// A load failure means "no bridge"; a registration failure (a name
			// clash, say) still propagates so the wiring can record it.
			return loaded ? loaded.registerCommand(registration) : () => {};
		},
		registerSection: async (registration) => {
			const loaded = await ensure().catch(() => null);
			return loaded ? loaded.registerSection(registration) : () => {};
		},
		sectionCallbackData: async (sectionId, action, payload) => {
			try {
				const loaded = await ensure();
				const token = loaded.getSectionToken(sectionId);
				if (!token) return null;
				const data = `section:${token}:${action}:${payload}`;
				const bytes = new TextEncoder().encode(data).byteLength;
				return bytes <= TELEGRAM_CALLBACK_DATA_MAX_BYTES ? data : null;
			} catch {
				return null;
			}
		},
		sendView: async (view, target) => {
			try {
				return await (await ensure()).sendView(view, target);
			} catch {
				return null;
			}
		},
		editView: async (handle, view) => {
			try {
				return await (await ensure()).editView(handle, view);
			} catch {
				return handle;
			}
		},
		recordError: (category, error, details) => {
			void ensure()
				.then((loaded) => loaded.recordError(category, error, details))
				.catch(() => {});
		},
	};
}
