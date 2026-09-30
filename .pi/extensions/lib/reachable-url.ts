/**
 * Phone-reachable URL detection shared by the dev-server and Lavish Telegram
 * extensions.
 *
 * Vendored verbatim from the pi-config repository into the mu-commander
 * project extension so `/mudevserver` stays self-contained; behavior and the
 * `DEV_SERVER_INTERNAL_HOST` / `DEV_SERVER_TAILSCALE_URL` env names are
 * unchanged.
 *
 * Extracted verbatim from `dev-server-tunnel.ts` so both integrations offer the
 * same candidates: an explicit override, the mDNS host, raw LAN IPv4 probes,
 * a `tailscale serve` HTTPS host, and the raw tailnet IPv4. Each candidate is
 * HTTP-probed, so a host that resolves but rejects the request (Vite
 * `allowedHosts`), or a Lavish server that answers 403 to a foreign Host
 * header, is skipped instead of offered as a dead link.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import { homedir, hostname, networkInterfaces } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Overrides shared by both extensions:
 * DEV_SERVER_INTERNAL_HOST accepts a host ("my-host.local") or a full URL,
 * DEV_SERVER_TAILSCALE_URL pins the Tailscale link.
 */
export const INTERNAL_HOST_ENV = "DEV_SERVER_INTERNAL_HOST";
export const TAILSCALE_URL_ENV = "DEV_SERVER_TAILSCALE_URL";

const TAILSCALE_BIN_CANDIDATES = [
	join(homedir(), ".local/opt/tailscale/tailscale"),
	"/usr/bin/tailscale",
	"/usr/local/bin/tailscale",
	"/usr/sbin/tailscale",
];
const TAILSCALE_SOCKET_CANDIDATES = [
	join(homedir(), ".local/state/tailscale/tailscaled.sock"),
	"/var/run/tailscale/tailscaled.sock",
];

async function runTailscale(args: string[]): Promise<string | null> {
	const bin = TAILSCALE_BIN_CANDIDATES.find((candidate) => existsSync(candidate)) ?? "tailscale";
	for (const socket of [...TAILSCALE_SOCKET_CANDIDATES, undefined]) {
		try {
			const { stdout } = await execFileAsync(
				bin,
				[...(socket ? [`--socket=${socket}`] : []), ...args],
				{ timeout: 4000, encoding: "utf8" },
			);
			if (stdout.trim()) return stdout;
		} catch {
			// Try the next socket candidate, then the default daemon socket.
		}
	}
	return null;
}

export function withPort(value: string, port: number): string {
	const trimmed = value.trim().replace(/\/+$/, "");
	if (/^https?:\/\//i.test(trimmed)) return trimmed;
	// Append the port only when the override has no explicit port.
	return /:\d+$/.test(trimmed) ? `http://${trimmed}` : `http://${trimmed}:${port}`;
}

export function probeHttp(url: string, timeoutMs = 1500): Promise<boolean> {
	return new Promise((resolve) => {
		const request = http.get(url, (res) => {
			res.resume();
			resolve((res.statusCode ?? 0) < 400);
		});
		request.on("error", () => resolve(false));
		request.setTimeout(timeoutMs, () => {
			request.destroy();
			resolve(false);
		});
	});
}

// Internal-network link: an explicit override, then the mDNS hostname, then the
// raw LAN IPv4. Each candidate is probed.
export async function detectInternalUrl(port: number): Promise<string | null> {
	const override = process.env[INTERNAL_HOST_ENV]?.trim();
	if (override) return withPort(override, port);

	const candidates: string[] = [`http://${hostname()}.local:${port}`];
	for (const addresses of Object.values(networkInterfaces())) {
		for (const address of addresses ?? []) {
			if (address.family === "IPv4" && !address.internal) {
				candidates.push(`http://${address.address}:${port}`);
			}
		}
	}
	for (const candidate of candidates) {
		if (await probeHttp(candidate)) return candidate;
	}
	return null;
}

// Tailscale fallback: an explicit override, then a `tailscale serve` HTTPS host,
// then the raw tailnet IPv4.
export async function detectTailscaleUrl(port: number): Promise<string | null> {
	const override = process.env[TAILSCALE_URL_ENV]?.trim();
	if (override) return withPort(override, port);

	const serve = await runTailscale(["serve", "status", "--json"]);
	if (serve) {
		try {
			const parsed = JSON.parse(serve) as {
				Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
			};
			for (const [hostPort, entry] of Object.entries(parsed.Web ?? {})) {
				const proxiesPort = Object.values(entry.Handlers ?? {}).some((handler) =>
					(handler.Proxy ?? "").includes(`:${port}`),
				);
				if (proxiesPort) return `https://${hostPort.replace(/:\d+$/, "")}`;
			}
		} catch {
			// Ignore malformed serve status.
		}
	}

	const ip = (await runTailscale(["ip", "-4"]))?.trim().split(/\s+/)[0];
	if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) return `http://${ip}:${port}`;
	return null;
}
