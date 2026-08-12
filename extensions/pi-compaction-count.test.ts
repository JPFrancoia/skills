import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const require = createRequire(import.meta.url);
const Module = require("node:module") as { _initPaths(): void };
process.env.NODE_PATH = [
	join(homedir(), ".pi", "agent", "npm", "node_modules"),
	join(homedir(), ".npm-global", "lib", "node_modules"),
	process.env.NODE_PATH,
].filter(Boolean).join(delimiter);
Module._initPaths();

const { default: compactionCount, __test__ } = await import("./pi-compaction-count.ts");

assert.equal(__test__.countCompactions([
	{ type: "message" },
	{ type: "compaction" },
	{ type: "compaction" },
]), 2);

const handlers = new Map<string, (_event: unknown, ctx: typeof ctx) => void>();
const statuses: Array<[string, string]> = [];
const entries = [{ type: "message" }, { type: "compaction" }];
const ctx = {
	sessionManager: { getBranch: () => entries },
	ui: {
		theme: { fg: (_color: string, text: string) => text },
		setStatus: (key: string, value: string) => statuses.push([key, value]),
	},
};
const pi = {
	on(event: string, handler: (_event: unknown, eventCtx: typeof ctx) => void) {
		handlers.set(event, handler);
	},
} as unknown as ExtensionAPI;

compactionCount(pi);
assert.deepEqual([...handlers.keys()], ["session_start", "session_compact", "session_tree"]);
handlers.get("session_start")?.({}, ctx);
entries.push({ type: "compaction" });
handlers.get("session_compact")?.({}, ctx);
assert.deepEqual(statuses, [
	["compaction-count", "🧹 1"],
	["compaction-count", "🧹 2"],
]);

console.log("ok");
