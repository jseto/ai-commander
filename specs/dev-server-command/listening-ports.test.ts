import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	decodeProcAddress,
	devServerPorts,
	insideWorktree,
	isLoopbackAddress,
	parseProcNetTcp,
	scanListeningProcesses,
	type ListeningProcess,
	type ProcIo,
} from "../../.pi/extensions/lib/listening-ports.ts";

// Captured verbatim from /proc/net/tcp on the target machine (inodes replaced).
const PROC_NET_TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41862 1 0000000000000000 100 0 0 10 0
   1: 0100007F:9689 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 38553 1 0000000000000000 100 0 0 10 0
   2: 0100007F:9A4E 0100007F:9689 01 00000000:00000000 00:00000000 00000000  1000        0 11111 1 0000000000000000 100 0 0 10 0
   not a socket line
   3: 0A00A8C0:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 22222 1 0000000000000000 100 0 0 10 0`;

const PROC_NET_TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000001000000:1435 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 33333 1 0000000000000000 100 0 0 10 0
   1: 00000000000000000000000000000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 44444 1 0000000000000000 100 0 0 10 0`;

function listener(overrides: Partial<ListeningProcess> = {}): ListeningProcess {
	return {
		port: 5173,
		address: "0.0.0.0",
		inode: "41862",
		pid: 100,
		cwd: "/tree/alpha",
		cmdline: "node vite --host",
		...overrides,
	};
}

function createFakeProc(
	files: Record<string, string>,
	dirs: Record<string, string[]>,
	links: Record<string, string>,
): ProcIo {
	return {
		readFile: async (path) => {
			if (path in files) return files[path]!;
			throw new Error(`ENOENT ${path}`);
		},
		readdir: async (path) => {
			if (path in dirs) return dirs[path]!;
			throw new Error(`ENOENT ${path}`);
		},
		readlink: async (path) => {
			if (path in links) return links[path]!;
			throw new Error(`ENOENT ${path}`);
		},
	};
}

describe("listening ports (/proc)", () => {
	it("parses only listening sockets and decodes their bind addresses", () => {
		const sockets = parseProcNetTcp(PROC_NET_TCP, 4);
		assert.deepEqual(sockets, [
			{ port: 0x1435, address: "0.0.0.0", inode: "41862" },
			{ port: 0x9689, address: "127.0.0.1", inode: "38553" },
			{ port: 0x1f90, address: "192.168.0.10", inode: "22222" },
		]);
	});

	it("decodes IPv4 and IPv6 /proc addresses", () => {
		assert.equal(decodeProcAddress("00000000", 4), "0.0.0.0");
		assert.equal(decodeProcAddress("0100007F", 4), "127.0.0.1");
		assert.equal(decodeProcAddress("0A00A8C0", 4), "192.168.0.10");
		assert.equal(decodeProcAddress("00000000000000000000000000000000", 6), "::");
		assert.equal(decodeProcAddress("00000000000000000000000001000000", 6), "::1");
		assert.equal(decodeProcAddress("0000000000000000ffff00000100007f", 6), "::ffff:127.0.0.1");
		assert.equal(decodeProcAddress("malformed", 4), "malformed");
		const sockets = parseProcNetTcp(PROC_NET_TCP6, 6);
		assert.deepEqual(sockets, [
			{ port: 0x1435, address: "::1", inode: "33333" },
			{ port: 0x1f90, address: "::", inode: "44444" },
		]);
	});

	it("treats only loopback as loopback, including the mapped form", () => {
		assert.equal(isLoopbackAddress("127.0.0.1"), true);
		assert.equal(isLoopbackAddress("127.12.34.56"), true);
		assert.equal(isLoopbackAddress("::1"), true);
		assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
		assert.equal(isLoopbackAddress("0.0.0.0"), false);
		assert.equal(isLoopbackAddress("::"), false);
		assert.equal(isLoopbackAddress("100.85.184.75"), false);
		assert.equal(isLoopbackAddress("192.168.0.10"), false);
	});

	it("scopes a listener to a worktree by its process cwd", () => {
		assert.equal(insideWorktree("/tree/alpha", "/tree/alpha"), true);
		assert.equal(insideWorktree("/tree/alpha/src", "/tree/alpha"), true);
		assert.equal(insideWorktree("/tree/alpha-two", "/tree/alpha"), false);
		assert.equal(insideWorktree("/tree", "/tree/alpha"), false);
	});

	it("keeps only non-loopback listeners rooted in the worktree, deduped and ranked", () => {
		const candidates: ListeningProcess[] = [
			listener({ port: 9999, address: "127.0.0.1", inode: "1", cmdline: "node" }),
			listener({ port: 8080, address: "0.0.0.0", inode: "2", cwd: "/tree/beta", cmdline: "node" }),
			listener({ port: 6000, address: "0.0.0.0", inode: "3", cmdline: "python3 -m http.server" }),
			listener({ port: 5173, address: "::", inode: "4", cmdline: "node vite" }),
			listener({ port: 5173, address: "0.0.0.0", inode: "5", cmdline: "node vite" }),
		];
		const ports = devServerPorts(candidates, "/tree/alpha");
		assert.deepEqual(
			ports.map((entry) => entry.port),
			[5173, 6000],
		);
	});

	it("scans /proc and maps listening socket inodes to processes inside the roots", async () => {
		const io = createFakeProc(
			{
				"/proc/net/tcp": PROC_NET_TCP,
				"/proc/100/cmdline": "node\0vite\0--host\0",
			},
			{
				"/proc": ["1", "100", "200", "self", "net"],
				"/proc/100/fd": ["0", "25"],
				"/proc/200/fd": ["7"],
			},
			{
				"/proc/100/cwd": "/tree/alpha",
				"/proc/200/cwd": "/elsewhere",
				"/proc/100/fd/0": "/dev/null",
				"/proc/100/fd/25": "socket:[41862]",
				"/proc/200/fd/7": "socket:[38553]",
			},
		);

		const found = await scanListeningProcesses(["/tree/alpha"], io);
		assert.deepEqual(found, [
			{
				port: 0x1435,
				address: "0.0.0.0",
				inode: "41862",
				pid: 100,
				cwd: "/tree/alpha",
				cmdline: "node vite --host",
			},
		]);
	});

	it("returns no listeners when the roots or /proc are unavailable", async () => {
		const io = createFakeProc({}, { "/proc": ["1"] }, {});
		assert.deepEqual(await scanListeningProcesses([], io), []);
		assert.deepEqual(await scanListeningProcesses(["/tree/alpha"], io), []);
	});
});
