import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

// The repository intentionally has no node_modules. Make Pi's own extension
// peers visible so the documented direct jiti command is self-contained.
const require = createRequire(import.meta.url);
const Module = require("node:module") as { _initPaths(): void };
process.env.NODE_PATH = [
	join(homedir(), ".pi", "agent", "npm", "node_modules"),
	join(homedir(), ".npm-global", "lib", "node_modules", "@earendil-works", "pi-coding-agent", "node_modules"),
	join(homedir(), ".npm-global", "lib", "node_modules"),
	// Homebrew and /usr/local global installs of Pi.
	"/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules",
	"/opt/homebrew/lib/node_modules",
	"/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules",
	"/usr/local/lib/node_modules",
	process.env.NODE_PATH,
].filter(Boolean).join(delimiter);
Module._initPaths();

const { default: gitPopupExtension, __test__ } = await import("./pi-git-popup.ts");
const { visibleWidth } = await import("@earendil-works/pi-tui");

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function main(): void {
	assert.equal(typeof gitPopupExtension, "function");

	const status = __test__.parseStatus(
		"## main...origin/main\0M  src/a.ts\0?? new.txt\0R  new/name.ts\0old/name.ts\0",
	);
	assert.equal(status.branch, "main");
	assert.deepEqual(status.files.map((file) => file.path), ["src/a.ts", "new.txt", "new/name.ts"]);
	assert.equal(status.files[1]!.untracked, true);
	assert.equal(status.files[2]!.oldPath, "old/name.ts");
	assert.equal(__test__.parseStatus("## HEAD (no branch)\0").branch, "detached");

	const deltas = __test__.parseNumstat("3\t1\tsrc/a.ts\0-\t-\timg.png\0");
	assert.deepEqual(__test__.applyNumstat(status.files.slice(0, 1), deltas), [
		{ status: "M", path: "src/a.ts", oldPath: undefined, untracked: false, added: 3, removed: 1, binary: false },
	]);
	assert.equal(deltas.get("img.png")!.binary, true);

	assert.equal(__test__.isInsideLinkedWorktree("wt/a/file.ts", ["wt/a"]), true);
	assert.equal(__test__.isInsideLinkedWorktree("wtx/file.ts", ["wt"]), false);
	assert.deepEqual(__test__.parseWorktreePaths("worktree /repo\0HEAD abc\0\0worktree /repo/wt\0\0bare\0"), ["/repo", "/repo/wt"]);
	assert.equal(__test__.truncatePath("a/very/long/path/name.ts", 8), "name.ts");
	assert.equal(__test__.truncatePath("a/very/long/path/name.ts", 5), "…e.ts");

	// Root repository is always shown; clean non-root repositories are hidden.
	const repos = [
		{ path: "/repo", label: "repo", branch: "main", files: [] },
		{ path: "/repo/clean", label: "clean", branch: "side", files: [] },
		{
			path: "/repo/nested",
			label: "nested",
			branch: "feat\nspoofed",
			files: [{ status: "M", path: "src/evil\x1b[2J\nname.ts", added: 2, removed: 1 }],
		},
		{ path: "/repo/broken", label: "broken", branch: "?", files: [], error: "git status failed" },
	];
	const items = __test__.gitItems("/repo", repos as never, theme as never, 40);
	const text = items.join("\n");
	assert.match(text, /repo\n• main\nclean/);
	assert.doesNotMatch(text, /• side/);
	assert.match(text, /• feat spoofed/);
	assert.match(text, /git status failed/);
	assert.doesNotMatch(items.join(""), /\x1b\[2J/);
	assert.ok(items.every((line) => !line.includes("\n")));
	assert.deepEqual(__test__.gitItems(undefined, [] as never, theme as never, 40), ["(not a git repository)"]);

	// Popup frames the items, stays inside the width, and closes on escape.
	let closed = false;
	const popup = new __test__.GitPopup("/repo", repos as never, theme as never, () => {}, () => { closed = true; }, () => 40);
	const lines = popup.render(60);
	assert.ok(lines.every((line) => visibleWidth(line) <= 60 && !line.includes("\n")));
	assert.match(lines[1]!, /Git/);
	assert.match(lines.join("\n"), /esc close/);
	popup.handleInput("\x1b");
	assert.equal(closed, true);

	// Scrolling clamps to the item count instead of running past the end.
	const many = [{
		path: "/repo",
		label: "repo",
		branch: "main",
		files: Array.from({ length: 60 }, (_, index) => ({ status: "M", path: `src/file-${index}.ts`, added: 1, removed: 0 })),
	}];
	const scroller = new __test__.GitPopup("/repo", many as never, theme as never, () => {}, () => {}, () => 40);
	scroller.handleInput("\x1b[F"); // end
	const tail = scroller.render(60).join("\n");
	assert.match(tail, /file-59\.ts/);
	assert.doesNotMatch(tail, /file-0\.ts/);
	scroller.handleInput("\x1b[H"); // home
	assert.match(scroller.render(60).join("\n"), /file-0\.ts/);

	// A short terminal shrinks the page instead of overflowing the screen.
	const short = new __test__.GitPopup("/repo", many as never, theme as never, () => {}, () => {}, () => 12);
	assert.ok(short.render(60).length <= 12);
}

main();
