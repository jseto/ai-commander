import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	createTelegramBridge,
	resolveAgentDir,
	type TelegramApi,
	type TelegramCommandRegistration,
	type TelegramSectionRegistration,
} from "../../.pi/extensions/lib/telegram-bridge.ts";

const REGISTRATION: TelegramCommandRegistration = {
	name: "mudevserver",
	description: "test",
	emoji: "🖥",
	showInMenu: true,
	handler: () => {},
};

const SECTION: TelegramSectionRegistration = {
	id: "dev-server-command",
	label: "🖥 Dev server",
	render: async () => ({ text: "menu", parseMode: "html" }),
	handleCallback: async (): Promise<"handled" | "pass"> => "handled",
};

describe("pi-telegram bridge", () => {
	it("resolves the agent directory from PI_CODING_AGENT_DIR or the default", () => {
		assert.equal(resolveAgentDir({ PI_CODING_AGENT_DIR: "/custom/agent" }), "/custom/agent");
		assert.equal(resolveAgentDir({ PI_CODING_AGENT_DIR: "  " }), join(homedir(), ".pi", "agent"));
		assert.equal(resolveAgentDir({}), join(homedir(), ".pi", "agent"));
	});

	it("forwards registration, views, and errors to the loaded API", async () => {
		const calls: string[] = [];
		const api: TelegramApi = {
			registerCommand: (registration) => {
				calls.push(`register:${registration.name}`);
				return () => calls.push("dispose");
			},
			registerSection: (registration) => {
				calls.push(`register-section:${registration.id}`);
				return () => calls.push("dispose-section");
			},
			getSectionToken: (id) => (id === "dev-server-command" ? "4" : null),
			sendView: async () => {
				calls.push("send");
				return "h1";
			},
			editView: async (handle) => {
				calls.push("edit");
				return handle;
			},
			recordError: (category) => {
				calls.push(`error:${category}`);
			},
		};
		const bridge = createTelegramBridge({ load: async () => api, warn: () => {} });

		const dispose = await bridge.registerCommand(REGISTRATION);
		const disposeSection = await bridge.registerSection(SECTION);
		assert.equal(await bridge.sendView({ text: "t", parseMode: "html" }, {}), "h1");
		assert.equal(await bridge.editView("h1", { text: "t", parseMode: "html" }), "h1");
		bridge.recordError("dev-server-command", new Error("boom"));
		await new Promise((resolve) => setImmediate(resolve));
		dispose();
		disposeSection();

		assert.deepEqual(calls, [
			"register:mudevserver",
			"register-section:dev-server-command",
			"send",
			"edit",
			"error:dev-server-command",
			"dispose",
			"dispose-section",
		]);
	});

	it("builds selection callback data from the registry token and enforces the 64-byte cap. [REQ-25]", async () => {
		const api: TelegramApi = {
			registerCommand: () => () => {},
			registerSection: () => () => {},
			getSectionToken: (id) => (id === "dev-server-command" ? "4" : null),
			sendView: async () => null,
			editView: async (handle) => handle,
			recordError: () => {},
		};
		const bridge = createTelegramBridge({ load: async () => api, warn: () => {} });

		assert.equal(
			await bridge.sectionCallbackData("dev-server-command", "select", "alpha"),
			"section:4:select:alpha",
		);
		assert.equal(
			await bridge.sectionCallbackData("unknown-section", "select", "alpha"),
			null,
			"no token, no callback",
		);
		const longTask =
			"a-really-long-task-name-that-pushes-the-selection-past-the-64-byte-cap";
		assert.equal(
			await bridge.sectionCallbackData("dev-server-command", "select", longTask),
			null,
			"over Telegram's 64-byte callback cap",
		);
	});

	it("propagates a registration failure so the wiring can record it", async () => {
		const failure = new Error("Telegram command is already registered: mudevserver");
		const api: TelegramApi = {
			registerCommand: () => {
				throw failure;
			},
			registerSection: () => () => {},
			getSectionToken: () => null,
			sendView: async () => null,
			editView: async (handle) => handle,
			recordError: () => {},
		};
		const bridge = createTelegramBridge({ load: async () => api, warn: () => {} });

		await assert.rejects(() => bridge.registerCommand(REGISTRATION), /already registered/);
	});

	it("Stay inert when pi-telegram is absent. [REQ-24]", async () => {
		const warnings: string[] = [];
		let loads = 0;
		const bridge = createTelegramBridge({
			load: async () => {
				loads += 1;
				throw new Error("Cannot find module '@llblab/pi-telegram/commands'");
			},
			warn: (message) => warnings.push(message),
		});

		const dispose = await bridge.registerCommand(REGISTRATION);
		dispose();
		// Registering the tap surface completes without throwing: a no-op.
		const disposeSection = await bridge.registerSection(SECTION);
		disposeSection();
		assert.equal(
			await bridge.sectionCallbackData("dev-server-command", "select", "alpha"),
			null,
			"no selection callback can be built",
		);
		assert.equal(await bridge.sendView({ text: "t", parseMode: "html" }, {}), null);
		assert.equal(await bridge.editView("h1", { text: "t", parseMode: "html" }), "h1");
		bridge.recordError("dev-server-command", new Error("boom"));
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(loads, 1, "the loader is attempted once");
		assert.equal(warnings.length, 1, "exactly one diagnostic");
		assert.match(warnings[0] ?? "", /pi-telegram is unavailable/);
	});
});
