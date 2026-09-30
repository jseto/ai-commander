import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	createTelegramBridge,
	resolveAgentDir,
	type TelegramApi,
	type TelegramCommandRegistration,
} from "../../.pi/extensions/telegram-bridge.ts";

const REGISTRATION: TelegramCommandRegistration = {
	name: "mudevserver",
	description: "test",
	emoji: "🖥",
	showInMenu: true,
	handler: () => {},
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
		assert.equal(await bridge.sendView({ text: "t", parseMode: "html" }, {}), "h1");
		assert.equal(await bridge.editView("h1", { text: "t", parseMode: "html" }), "h1");
		bridge.recordError("dev-server-command", new Error("boom"));
		await new Promise((resolve) => setImmediate(resolve));
		dispose();

		assert.deepEqual(calls, ["register:mudevserver", "send", "edit", "error:dev-server-command", "dispose"]);
	});

	it("propagates a registration failure so the wiring can record it", async () => {
		const failure = new Error("Telegram command is already registered: mudevserver");
		const api: TelegramApi = {
			registerCommand: () => {
				throw failure;
			},
			sendView: async () => null,
			editView: async (handle) => handle,
			recordError: () => {},
		};
		const bridge = createTelegramBridge({ load: async () => api, warn: () => {} });

		await assert.rejects(() => bridge.registerCommand(REGISTRATION), /already registered/);
	});

	it("is inert with one diagnostic when pi-telegram cannot be loaded", async () => {
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
		assert.equal(await bridge.sendView({ text: "t", parseMode: "html" }, {}), null);
		assert.equal(await bridge.editView("h1", { text: "t", parseMode: "html" }), "h1");
		bridge.recordError("dev-server-command", new Error("boom"));
		await new Promise((resolve) => setImmediate(resolve));

		assert.equal(loads, 1, "the loader is attempted once");
		assert.equal(warnings.length, 1, "exactly one diagnostic");
		assert.match(warnings[0] ?? "", /pi-telegram is unavailable/);
	});
});
