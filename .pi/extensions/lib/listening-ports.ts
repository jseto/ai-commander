/**
 * Listening TCP port discovery for child worktrees, read from `/proc`.
 *
 * A per-child dev server must bind a non-loopback address to be reachable from
 * the phone (`detectInternalUrl` / `detectTailscaleUrl` probe real HTTP), and
 * its process keeps the worktree as its working directory - npm, vite and
 * friends run from where they were launched. So a "dev server for worktree W"
 * is: a LISTEN socket whose owning process `cwd` is inside W, bound to a
 * non-loopback address.
 *
 * `/proc/net/tcp{,6}` names the listening sockets (port + inode + bind
 * address); scanning only the `cwd`s under the candidate worktrees keeps the
 * `fd` scan bounded and avoids external tools such as `ss`/`lsof`. Linux-only
 * by design - this is the user's personal machine, and every failure degrades
 * to "no listener".
 */

import { readFile, readdir, readlink } from "node:fs/promises";

export interface ListeningSocket {
	port: number;
	address: string;
	inode: string;
}

export interface ListeningProcess extends ListeningSocket {
	pid: number;
	cwd: string;
	cmdline: string;
}

export interface ProcIo {
	readFile(path: string): Promise<string>;
	readdir(path: string): Promise<string[]>;
	readlink(path: string): Promise<string>;
}

export const realProcIo: ProcIo = {
	readFile: (path) => readFile(path, "utf8"),
	readdir: (path) => readdir(path),
	readlink: (path) => readlink(path),
};

/** Command lines that clearly identify a project dev server (scoring only). */
const DEV_SERVER_COMMAND =
	/(vite|next (?:dev|start)|nuxt|webpack|astro|remix|svelte-kit|ng serve|react-scripts|npm run dev|pnpm(?: run)? dev|yarn dev|bun(?: run)? dev|deno task dev|flask run|uvicorn|gunicorn|manage\.py runserver|rails server|cargo run|go run|http\.server)/i;

/** Decode the little-endian hex address from `/proc/net/tcp{,6}`. */
export function decodeProcAddress(hexAddress: string, family: 4 | 6): string {
	const hex = hexAddress.trim().toLowerCase();
	if (family === 4) {
		if (!/^[0-9a-f]{8}$/.test(hex)) return hexAddress;
		const bytes = [0, 2, 4, 6].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
		return bytes.reverse().join(".");
	}
	if (!/^[0-9a-f]{32}$/.test(hex)) return hexAddress;
	const bytes: number[] = [];
	for (let word = 0; word < 4; word += 1) {
		const value = parseInt(hex.slice(word * 8, word * 8 + 8), 16);
		bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
	}
	if (bytes.every((byte) => byte === 0)) return "::";
	if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return "::1";
	if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
		return `::ffff:${bytes.slice(12).join(".")}`;
	}
	const groups: string[] = [];
	for (let group = 0; group < 8; group += 1) {
		groups.push((((bytes[group * 2] ?? 0) << 8) | (bytes[group * 2 + 1] ?? 0)).toString(16));
	}
	return groups.join(":");
}

/** Loopback and the loopback IPv4-mapped form; wildcard binds are not loopback. */
export function isLoopbackAddress(address: string): boolean {
	const value = address.trim().toLowerCase();
	if (value === "::1") return true;
	if (value.startsWith("::ffff:")) return value.slice(7).startsWith("127.");
	return /^127\./.test(value);
}

/** Listening sockets from one `/proc/net/tcp*` snapshot (state 0A = LISTEN). */
export function parseProcNetTcp(content: string, family: 4 | 6): ListeningSocket[] {
	const sockets: ListeningSocket[] = [];
	for (const line of content.split("\n").slice(1)) {
		const parts = line.trim().split(/\s+/);
		if (parts.length < 10 || parts[3] !== "0A") continue;
		const local = parts[1] ?? "";
		const separator = local.lastIndexOf(":");
		if (separator <= 0) continue;
		const address = decodeProcAddress(local.slice(0, separator), family);
		const port = parseInt(local.slice(separator + 1), 16);
		const inode = parts[9] ?? "";
		if (!Number.isInteger(port) || port <= 0 || port > 65535 || !inode) continue;
		sockets.push({ port, address, inode });
	}
	return sockets;
}

/** True when `cwd` is `worktree` itself or a directory below it. */
export function insideWorktree(cwd: string, worktree: string): boolean {
	const root = worktree.replace(/\/+$/, "");
	return cwd === root || cwd.startsWith(`${root}/`);
}

/**
 * Non-loopback listeners rooted in `worktree`, most dev-server-like first.
 * Deduplicated by port (a dual-stack `::`/`0.0.0.0` pair collapses to one).
 */
export function devServerPorts(
	listeners: ListeningProcess[],
	worktree: string,
): ListeningProcess[] {
	const seen = new Set<number>();
	return listeners
		.filter((listener) => !isLoopbackAddress(listener.address))
		.filter((listener) => insideWorktree(listener.cwd, worktree))
		.sort((left, right) => {
			const leftScore = DEV_SERVER_COMMAND.test(left.cmdline) ? 0 : 1;
			const rightScore = DEV_SERVER_COMMAND.test(right.cmdline) ? 0 : 1;
			return leftScore - rightScore || left.port - right.port;
		})
		.filter((listener) => {
			if (seen.has(listener.port)) return false;
			seen.add(listener.port);
			return true;
		});
}

/**
 * Scan `/proc` once and return every LISTEN socket owned by a process whose
 * `cwd` is inside one of `roots`. Errors degrade to an empty result.
 */
export async function scanListeningProcesses(
	roots: string[],
	io: ProcIo = realProcIo,
): Promise<ListeningProcess[]> {
	if (roots.length === 0) return [];

	const sockets = new Map<string, ListeningSocket>();
	for (const [family, path] of [
		[4, "/proc/net/tcp"],
		[6, "/proc/net/tcp6"],
	] as const) {
		try {
			const content = await io.readFile(path);
			for (const socket of parseProcNetTcp(content, family)) {
				sockets.set(socket.inode, socket);
			}
		} catch {
			// A missing tcp6 file (or an unreadable /proc) means "no listener there".
		}
	}
	if (sockets.size === 0) return [];

	let entries: string[];
	try {
		entries = await io.readdir("/proc");
	} catch {
		return [];
	}

	const found: ListeningProcess[] = [];
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue;
		const pid = Number(entry);
		const cwd = await safeReadlink(io, `/proc/${pid}/cwd`);
		if (!cwd || !roots.some((root) => insideWorktree(cwd, root))) continue;
		const fds = await safeReaddir(io, `/proc/${pid}/fd`);
		if (fds.length === 0) continue;
		const cmdline = (await safeReadFile(io, `/proc/${pid}/cmdline`)).replace(/\0/g, " ").trim();
		for (const fd of fds) {
			const link = await safeReadlink(io, `/proc/${pid}/fd/${fd}`);
			const match = link?.match(/^socket:\[(\d+)\]$/);
			if (!match) continue;
			const socket = sockets.get(match[1] ?? "");
			if (!socket) continue;
			found.push({ ...socket, pid, cwd, cmdline });
		}
	}
	return found;
}

async function safeReadlink(io: ProcIo, path: string): Promise<string | null> {
	try {
		return await io.readlink(path);
	} catch {
		return null;
	}
}

async function safeReaddir(io: ProcIo, path: string): Promise<string[]> {
	try {
		return await io.readdir(path);
	} catch {
		return [];
	}
}

async function safeReadFile(io: ProcIo, path: string): Promise<string> {
	try {
		return await io.readFile(path);
	} catch {
		return "";
	}
}
