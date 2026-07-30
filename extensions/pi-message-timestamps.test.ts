import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const require = createRequire(import.meta.url);
const Module = require("node:module") as { _initPaths(): void };
process.env.NODE_PATH = [
	join(homedir(), ".pi", "agent", "npm", "node_modules"),
	join(homedir(), ".npm-global", "lib", "node_modules", "@earendil-works", "pi-coding-agent", "node_modules"),
	join(homedir(), ".npm-global", "lib", "node_modules"),
	"/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules",
	"/opt/homebrew/lib/node_modules",
	process.env.NODE_PATH,
].filter(Boolean).join(delimiter);
Module._initPaths();

const { default: timestamps, __test__ } = await import("./pi-message-timestamps.ts");

const timestamp = new Date(2026, 0, 2, 3, 4, 5).getTime();
assert.equal(__test__.formatTime(timestamp), "03:04:05");

let messageStart: ((event: { message: { role: string; timestamp: number } }) => void) | undefined;
let renderEntry: ((entry: { data: { timestamp: number } }, options: unknown, theme: { fg(color: string, text: string): string }) => { render(width: number): string[] }) | undefined;
const appended: Array<{ type: string; data: { timestamp: number } }> = [];
const pi = {
	registerEntryRenderer(type: string, renderer: typeof renderEntry) {
		assert.equal(type, "message-timestamp");
		renderEntry = renderer;
	},
	on(event: string, handler: typeof messageStart) {
		assert.equal(event, "message_start");
		messageStart = handler;
	},
	appendEntry(type: string, data: { timestamp: number }) {
		appended.push({ type, data });
	},
} as unknown as ExtensionAPI;

timestamps(pi);
assert.ok(renderEntry);
assert.deepEqual(
	renderEntry({ data: { timestamp } }, {}, { fg: (_color, text) => text }).render(80).map((line) => line.trimEnd()),
	["── 03:04:05 ──"],
);
assert.ok(messageStart);
messageStart({ message: { role: "user", timestamp } });
messageStart({ message: { role: "assistant", timestamp: timestamp + 1_000 } });
messageStart({ message: { role: "toolResult", timestamp: timestamp + 2_000 } });
assert.deepEqual(appended, [
	{ type: "message-timestamp", data: { timestamp } },
	{ type: "message-timestamp", data: { timestamp: timestamp + 1_000 } },
]);

console.log("ok");
