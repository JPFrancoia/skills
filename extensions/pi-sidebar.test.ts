import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// The repository intentionally has no node_modules. Make Pi's own extension
// peers visible so the documented direct jiti command is self-contained.
const require = createRequire(import.meta.url);
const Module = require("node:module") as { _initPaths(): void };
process.env.NODE_PATH = [
	join(homedir(), ".pi", "agent", "npm", "node_modules"),
	join(homedir(), ".npm-global", "lib", "node_modules", "@earendil-works", "pi-coding-agent", "node_modules"),
	join(homedir(), ".npm-global", "lib", "node_modules"),
	process.env.NODE_PATH,
].filter(Boolean).join(delimiter);
Module._initPaths();

const { default: sidebarExtension, __test__ } = await import("./pi-sidebar.ts");
const { visibleWidth } = await import("@earendil-works/pi-tui");

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

async function main(): Promise<void> {
	assert.equal(typeof sidebarExtension, "function");

	const stats = __test__.computeSessionStats([
		{ type: "message", message: { role: "assistant", usage: { input: 10, output: 3, cacheRead: 5, cacheWrite: 2, cost: { total: 0.1 } } } },
		{ type: "message", message: { role: "toolResult", usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.02 } } } },
		{ type: "compaction", usage: { input: 4, output: 2, cacheRead: 1, cacheWrite: 0, cost: { total: 0.03 } } },
		{ type: "compaction" },
		{ type: "message", message: { role: "assistant", usage: { input: 20, output: 5, cacheRead: 10, cacheWrite: 0, cost: { total: 0.2 } } } },
	]);
	assert.deepEqual(
		{ input: stats.input, output: stats.output, cacheRead: stats.cacheRead, cacheWrite: stats.cacheWrite, turns: stats.turns, compactions: stats.compactions, cost: stats.cost },
		{ input: 36, output: 11, cacheRead: 16, cacheWrite: 2, turns: 2, compactions: 2, cost: 0.35000000000000003 },
	);
	assert.ok(Math.abs((stats.cacheHitPercent ?? 0) - (100 / 3)) < 0.001);

	const todos = __test__.replayTodos([
		{ type: "message", message: { role: "toolResult", toolName: "todo", details: { tasks: [{ id: 1, subject: "old", status: "pending" }], nextId: 2 } } },
		{ type: "message", message: { role: "toolResult", toolName: "todo", details: { tasks: [{ id: 1, subject: "done", status: "completed" }, { id: 2, subject: "removed", status: "deleted" }], nextId: 3 } } },
	]);
	assert.deepEqual(todos.map((todo) => [todo.subject, todo.status]), [["done", "completed"], ["removed", "deleted"]]);

	const parsed = __test__.parseStatus("## main...origin/main\0 M src/long/file.ts\0R  src/new.ts\0src/old.ts\0?? task-worktree/\0");
	assert.equal(parsed.branch, "main");
	assert.equal(__test__.parseStatus("## No commits yet on trunk\0?? first.txt\0").branch, "trunk");
	assert.deepEqual(parsed.files.map((file) => [file.status, file.path, file.oldPath]), [
		["M", "src/long/file.ts", undefined],
		["R", "src/new.ts", "src/old.ts"],
		["??", "task-worktree/", undefined],
	]);
	const primary = join(tmpdir(), "repo");
	const sibling = join(tmpdir(), "repo.task");
	assert.deepEqual(__test__.parseWorktreePaths([
		`worktree ${primary}`,
		"HEAD abc123",
		"branch refs/heads/main",
		"",
		`worktree ${sibling}`,
		"HEAD def456",
		"detached",
		"locked reason",
		"prunable gitdir file points to non-existent location",
		"",
		`worktree ${join(tmpdir(), "bare.git")}`,
		"bare",
		"",
	].join("\0")), [primary, sibling]);
	const workspaceRoot = join(tmpdir(), "workspace");
	const nestedRoot = join(workspaceRoot, "enterprise");
	const workspaceTask = join(tmpdir(), "workspace-task");
	const nestedTask = join(tmpdir(), "workspace-enterprise-task");
	const nestedInlineTask = join(nestedRoot, "task");
	const duplicate = join(tmpdir(), "duplicate-worktree");
	const targets = await __test__.enumerateWorktreeTargets(
		[workspaceRoot, nestedRoot, nestedRoot],
		["linked-root"],
		async (owner) => owner === workspaceRoot
			? [workspaceRoot, workspaceTask, duplicate]
			: [nestedRoot, nestedTask, nestedInlineTask, duplicate],
	);
	assert.deepEqual(targets.map(({ owner, path, linkedWorktrees }) => [owner, path, linkedWorktrees]), [
		[workspaceRoot, workspaceRoot, ["linked-root"]],
		[workspaceRoot, workspaceTask, ["linked-root"]],
		[workspaceRoot, duplicate, ["linked-root"]],
		[nestedRoot, nestedRoot, ["task"]],
		[nestedRoot, nestedTask, ["task"]],
		[nestedRoot, nestedInlineTask, ["task"]],
	]);
	const failedTargets = await __test__.enumerateWorktreeTargets(
		[workspaceRoot, nestedRoot],
		[],
		async (owner) => {
			if (owner === nestedRoot) throw new Error("missing nested repository");
			return [];
		},
	);
	assert.deepEqual(failedTargets.map(({ owner, path }) => [owner, path]), [
		[workspaceRoot, workspaceRoot],
		[nestedRoot, nestedRoot],
	]);
	assert.deepEqual([...__test__.replayWorkedWorktrees([
		{ type: "custom", customType: "other", data: { path: sibling } },
		{ type: "custom", customType: "pi-sidebar-worktree-worked", data: { path: primary } },
		{ type: "custom", customType: "pi-sidebar-worktree-worked", data: { path: 42 } },
	])], [primary]);
	const cleanRepo = { path: primary, label: "repo", branch: "main", files: [] };
	const dirtyRepo = { ...cleanRepo, files: [{ status: "M", path: "file.ts", added: 1, removed: 0 }] };
	const changedDirtyRepo = { ...cleanRepo, files: [{ status: "M", path: "file.ts", added: 2, removed: 0 }] };
	const cleanBaseline = __test__.observeWorkedWorktrees([cleanRepo], [primary], new Map(), new Set());
	assert.deepEqual(cleanBaseline.newlyWorked, []);
	const cleanToDirty = __test__.observeWorkedWorktrees([dirtyRepo], [primary], cleanBaseline.signatures, new Set());
	assert.deepEqual(cleanToDirty.newlyWorked, [primary]);
	const dirtyBaseline = __test__.observeWorkedWorktrees([dirtyRepo], [primary], new Map(), new Set());
	assert.deepEqual(dirtyBaseline.newlyWorked, []);
	const nestedCleanRepo = { ...cleanRepo, path: nestedTask, label: "workspace-enterprise-task", branch: "task" };
	const nestedBaseline = __test__.observeWorkedWorktrees([cleanRepo, nestedCleanRepo], [primary, nestedTask], new Map(), new Set());
	const nestedDirtyRepo = { ...nestedCleanRepo, files: [{ status: "M", path: "nested.ts", added: 1, removed: 0 }] };
	assert.deepEqual(
		__test__.observeWorkedWorktrees([cleanRepo, nestedDirtyRepo], [primary, nestedTask], nestedBaseline.signatures, new Set()).newlyWorked,
		[nestedTask],
	);
	const failedObservation = __test__.observeWorkedWorktrees([{ ...cleanRepo, error: "git failed" }], [primary], dirtyBaseline.signatures, new Set());
	assert.deepEqual(failedObservation.newlyWorked, []);
	assert.equal(failedObservation.signatures.get(primary), dirtyBaseline.signatures.get(primary));
	assert.deepEqual(__test__.observeWorkedWorktrees([cleanRepo], [primary], dirtyBaseline.signatures, new Set()).newlyWorked, [primary]);
	assert.deepEqual(__test__.observeWorkedWorktrees([changedDirtyRepo], [primary], dirtyBaseline.signatures, new Set()).newlyWorked, [primary]);
	assert.deepEqual(__test__.observeWorkedWorktrees([changedDirtyRepo], [primary], dirtyBaseline.signatures, new Set([primary])).newlyWorked, []);
	const deltas = __test__.parseNumstat([
		"3\t1\tsrc/long/file.ts",
		"-\t-\timage.png",
		"2\t0\t",
		"src/old.ts",
		"src/new.ts",
		"",
	].join("\0"));
	assert.deepEqual(deltas.get("src/long/file.ts"), { added: 3, removed: 1, binary: false });
	assert.deepEqual(deltas.get("image.png"), { added: undefined, removed: undefined, binary: true });
	assert.deepEqual(deltas.get("src/new.ts"), { added: 2, removed: 0, binary: false });
	assert.equal(__test__.isInsideLinkedWorktree("task-worktree/", ["task-worktree"]), true);
	assert.equal(__test__.isInsideLinkedWorktree("src/task-worktree.ts", ["task-worktree"]), false);
	assert.equal(__test__.truncatePath("very/long/path/readable-file.ts", 16).endsWith("readable-file.ts"), true);
	const safeStatus = __test__.cleanStatusText("\x1b[31mred\x1b[0m\x1b[2J\nnext");
	assert.match(safeStatus, /\x1b\[31mred\x1b\[0m next/);
	assert.doesNotMatch(safeStatus, /\x1b\[2J/);
	assert.deepEqual(__test__.parseRunningAsyncSubagents([
		"Spawn budget: unlimited",
		"Active async runs: 2",
		"",
		"- run-one | running | parallel | 2 agents running | /repo",
		"  1. scout | running | tool read for 2s",
		"  2. reviewer | completed | 3s",
		"",
		"- run-two | running | chain | step 2/3 | /repo",
		"  1. Planner | completed",
		"  2. [Validation] Review diff (reviewer) | running | active",
	].join("\n")), [
		{ key: "async:run-one:0", agent: "scout", running: true, durationMs: 0, cost: 0 },
		{ key: "async:run-two:1", agent: "reviewer", running: true, durationMs: 0, cost: 0 },
	]);
	assert.deepEqual(__test__.parseRunningAsyncSubagents("Spawn budget: unlimited\nNo active async runs."), []);
	assert.equal(__test__.parseRunningAsyncSubagents("Run: foreground\nState: running"), undefined);
	assert.deepEqual(__test__.runningForegroundSubagents({ progress: [
		{ agent: "scout", status: "running" },
		{ agent: "reviewer", label: "Review", status: "running" },
		{ agent: "planner", status: "pending" },
	] }), [
		{ key: "foreground:0", agent: "scout", running: true, durationMs: 0, cost: 0 },
		{ key: "foreground:1", agent: "reviewer", running: true, durationMs: 0, cost: 0 },
	]);
	assert.deepEqual(__test__.initialForegroundSubagents({ agent: "scout" }), [{ key: "foreground:0", agent: "scout", running: true, durationMs: 0, cost: 0 }]);
	assert.deepEqual(__test__.initialForegroundSubagents({ tasks: [
		{ agent: "scout", count: 2 },
		{ agent: "reviewer", label: "Review" },
	], concurrency: 2 }), [
		{ key: "foreground:0", agent: "scout", running: true, durationMs: 0, cost: 0 },
		{ key: "foreground:1", agent: "scout", running: true, durationMs: 0, cost: 0 },
	]);
	assert.deepEqual(__test__.initialForegroundSubagents({ chain: [{ parallel: [
		{ agent: "scout" },
		{ agent: "reviewer", label: "Review" },
	] }] }), [
		{ key: "foreground:0", agent: "scout", running: true, durationMs: 0, cost: 0 },
		{ key: "foreground:1", agent: "reviewer", running: true, durationMs: 0, cost: 0 },
	]);
	assert.deepEqual(__test__.initialForegroundSubagents({ agent: "scout", async: true }), []);
	assert.deepEqual(__test__.subagentRunsFromDetails({
		results: [
			{ agent: "worker", usage: { cost: 0.2 }, progressSummary: { durationMs: 60_000 } },
			{ agent: "reviewer", totalCost: { costUsd: 0.03 }, progress: { status: "completed", durationMs: 5_000 } },
		],
		progress: [
			{ agent: "worker", status: "running", durationMs: 65_000 },
			{ agent: "reviewer", status: "completed", durationMs: 5_000 },
		],
	}, "foreground:call"), [
		{ key: "foreground:call:0", agent: "worker", running: true, durationMs: 65_000, cost: 0.2 },
		{ key: "foreground:call:1", agent: "reviewer", running: false, durationMs: 5_000, cost: 0.03 },
	]);
	const asyncStatus = {
		lifecycleArtifactVersion: 2,
		runId: "run-1",
		sessionId: "session-1",
		steps: [
			{ agent: "worker", status: "running", startedAt: 1_000, durationMs: 0, totalCost: { costUsd: 0.1 } },
			{ agent: "worker", status: "complete", durationMs: 60_000, totalCost: { costUsd: 0.2 } },
			{ agent: "planner", status: "pending" },
		],
	};
	const asyncRuns = [
		{ key: "async:run-1:0", agent: "worker", running: true, durationMs: 10_000, cost: 0.1 },
		{ key: "async:run-1:1", agent: "worker", running: false, durationMs: 60_000, cost: 0.2 },
	];
	assert.deepEqual(__test__.subagentRunsFromAsyncStatus(asyncStatus, "run-1", "session-1", 11_000), asyncRuns);
	assert.deepEqual(__test__.subagentRunsFromAsyncStatus({ ...asyncStatus, lifecycleArtifactVersion: 3 }, "run-1", "session-1", 11_000), asyncRuns);
	assert.equal(__test__.subagentRunsFromAsyncStatus({ lifecycleArtifactVersion: 2, runId: "run-1", sessionId: "other", steps: [] }, "run-1", "session-1"), undefined);
	assert.equal(__test__.subagentRunsFromAsyncStatus({ lifecycleArtifactVersion: 1, runId: "run-1", sessionId: "session-1", steps: [] }, "run-1", "session-1"), undefined);
	assert.equal(__test__.subagentRunsFromAsyncStatus({ lifecycleArtifactVersion: 2, runId: "wrong", sessionId: "session-1", steps: [] }, "run-1", "session-1"), undefined);
	assert.equal(__test__.subagentRunsFromAsyncStatus({ lifecycleArtifactVersion: 2, runId: "run-1", sessionId: "session-1", steps: [{ agent: "worker", status: "complete", durationMs: -1 }] }, "run-1", "session-1"), undefined);
	const aggregated = __test__.aggregateSubagents([
		{ key: "one", agent: "worker", running: false, durationMs: 60_000, cost: 0.2337 },
		{ key: "two", agent: "worker", running: true, durationMs: 46_000, cost: 0.2323 },
		{ key: "three", agent: "reviewer", running: false, durationMs: 5_000, cost: 0.03 },
	]);
	assert.deepEqual(aggregated.map(({ cost: _cost, ...agent }) => agent), [
		{ key: "worker", agent: "worker", running: true, durationMs: 106_000 },
		{ key: "reviewer", agent: "reviewer", running: false, durationMs: 5_000 },
	]);
	assert.ok(Math.abs(aggregated[0]!.cost - 0.466) < 1e-12);
	assert.equal(aggregated[1]!.cost, 0.03);
	assert.equal(__test__.formatSubagentDuration(60_000), "1m");
	assert.equal(__test__.formatSubagentDuration(106_000), "1m46s");
	const replayedSubagents = __test__.replaySubagents([
		{ type: "custom", customType: "pi-sidebar-subagent-run", data: { key: "one", agent: "worker", durationMs: 10_000, cost: 0.1 } },
		{ type: "custom", customType: "pi-sidebar-subagent-run", data: { key: "one", agent: "worker", durationMs: 60_000, cost: 0.2 } },
		{ type: "custom_message", customType: "subagent-slash-result", details: { requestId: "slash-1", result: { details: { asyncId: "run-1", asyncDir: "/tmp/run-1", results: [] } } } },
	]);
	assert.deepEqual([...replayedSubagents.runs.values()], [{ key: "one", agent: "worker", running: false, durationMs: 60_000, cost: 0.2 }]);
	assert.deepEqual([...replayedSubagents.asyncRunDirs], [["run-1", "/tmp/run-1"]]);
	const token = [
		"header",
		Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-123" } })).toString("base64url"),
		"signature",
	].join(".");
	assert.equal(__test__.codexAccountId(token), "account-123");
	assert.equal(__test__.codexAccountId("not-a-jwt"), undefined);
	assert.deepEqual(__test__.parseCodexWeeklyQuota({
		rate_limit: { primary_window: { used_percent: 17, limit_window_seconds: 604800, reset_at: 1_800_000_000 }, secondary_window: null },
	}), { remaining: 83, resetAt: 1_800_000_000_000 });
	assert.deepEqual(__test__.parseCodexWeeklyQuota({
		rate_limit: {
			primary_window: { used_percent: 5, limit_window_seconds: 18000 },
			secondary_window: { used_percent: 120, limit_window_seconds: 604800 },
		},
	}), { remaining: 0, resetAt: undefined });
	assert.equal(__test__.parseCodexWeeklyQuota({
		rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } },
	}), undefined);
	assert.equal(__test__.formatQuotaReset(6.5 * 86_400_000, 0), "6d");
	assert.equal(__test__.formatQuotaReset(23 * 3_600_000, 0), "23h");

	const root = await mkdtemp(join(tmpdir(), "pi-sidebar-"));
	try {
		await mkdir(join(root, "nested", ".git"), { recursive: true });
		await mkdir(join(root, "worktree"), { recursive: true });
		await writeFile(join(root, "worktree", ".git"), "gitdir: elsewhere\n");
		await mkdir(join(root, "node_modules", "ignored", ".git"), { recursive: true });
		const discovery = await __test__.discoverRepositories(root);
		assert.deepEqual(discovery.repos, [join(root, "nested")]);
		assert.deepEqual(discovery.linkedWorktrees, ["worktree"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}

	class Terminal {
		rows = 8;
		writes: string[] = [];
		get columns(): number { return 120; }
		write(data: string): void { this.writes.push(data); }
	}
	const terminal = new Terminal();
	let renders = 0;
	const tui = {
		terminal,
		doRender() { renders++; },
		requestRender() {},
		stopped: false,
	};
	const originalRender = tui.doRender;
	const state: any = {
		enabled: true,
		width: 48,
		thinkingLevel: "high",
		stats: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, compactions: 2 },
		todos: [],
		gitRepos: [],
		linkedWorktrees: [],
		workedWorktrees: new Set(),
		activeTools: new Map(),
		subagentRuns: new Map(),
		asyncRunDirs: new Map(),
		foregroundSubagents: new Map(),
		speedSamples: [],
		sessionStartedAt: Date.now(),
	};
	const compositor = new __test__.SidebarCompositor(tui as never, () => state as never, () => theme as never, () => new Map());
	assert.equal(compositor.install(), true);
	assert.equal(terminal.columns, 71);
	tui.doRender();
	assert.equal(renders, 1);
	assert.match(terminal.writes.join(""), /\x1b\[\?2026h/);
	compositor.dispose();
	assert.equal(terminal.columns, 120);
	assert.equal(tui.doRender, originalRender);

	state.activeTools.set("one", { name: "read", startedAt: Date.now() - 2_000 });
	state.activeTools.set("two", { name: "bash", startedAt: Date.now() - 1_000 });
	state.rootRepo = "/repo";
	state.gitRepos = [{
		path: "/repo",
		label: "repo\x1b[2J",
		branch: "main\nspoofed",
		files: [{ status: "M", path: "src/evil\x1b[2J\nname.ts", added: 1, removed: 0 }],
	}, {
		path: "/outside/repo",
		label: "repo",
		branch: "clean-sibling",
		files: [],
	}];
	const lines = __test__.renderSidebar(state as never, theme as never, new Map(), 48, 24);
	assert.ok(lines.length <= 24);
	assert.ok(lines.every((line) => visibleWidth(line) <= 48 && !line.includes("\n")));
	const contextIndex = lines.findIndex((line) => line.startsWith("ctx "));
	assert.equal(lines[contextIndex + 1], "compactions  2");
	assert.doesNotMatch(lines.join(""), /\x1b\[2J/);
	assert.doesNotMatch(lines.join("\n"), /clean-sibling/);
	assert.match(lines.join("\n"), /bash \(1s\) \+1/);
	assert.match(lines.join("\n"), /Subagents\n─+\n\(none used\)/);
	assert.doesNotMatch(__test__.renderSidebar(state as never, theme as never, new Map([["mcp", "MCP connected"]]), 48, 100).join("\n"), /MCP/);
	const fullLines = __test__.renderSidebar(state as never, theme as never, new Map(), 48, 100);
	const gitHeaderIndex = fullLines.indexOf("repo");
	assert.equal(fullLines[gitHeaderIndex + 1], "• main spoofed");
	const subagentsIndex = fullLines.indexOf("Subagents");
	assert.doesNotMatch(__test__.renderSidebar(state as never, theme as never, new Map(), 48, subagentsIndex + 2).join("\n"), /Subagents/);
	state.subagentRuns.set("async:run:0", { key: "async:run:0", agent: "scout\x1b[2J\nspoofed", running: false, durationMs: 60_000, cost: 0.2337 });
	const colorTheme = {
		...theme,
		fg: (color: string, text: string) => `\x1b[${color === "success" ? 32 : color === "error" ? 31 : 37}m${text}\x1b[0m`,
	};
	const subagentLines = __test__.renderSidebar(state as never, colorTheme as never, new Map(), 48, 40).join("\n");
	assert.match(subagentLines, /\x1b\[31m●/);
	assert.match(subagentLines, /scout spoofed/);
	assert.match(subagentLines, /1m · \$0\.2337/);
	assert.doesNotMatch(subagentLines, /\x1b\[2J/);
	state.subagentRuns.set("async:run:0", { ...state.subagentRuns.get("async:run:0"), running: true });
	assert.match(__test__.renderSidebar(state as never, colorTheme as never, new Map(), 48, 40).join("\n"), /\x1b\[32m●/);
	state.subagentRuns.clear();
	state.ctx = { cwd: "/repo", model: { id: "gpt-5.6", provider: "openai-codex" } };
	state.codexWeeklyQuota = { remaining: 83, resetAt: Date.now() + 6.5 * 86_400_000 };
	const quotaLines = __test__.renderSidebar(state as never, theme as never, new Map(), 48, 40);
	assert.match(quotaLines.join("\n"), /week  ████████░░ 83% resets in 6d/);
	const weekIndex = quotaLines.findIndex((line) => line.startsWith("week "));
	assert.equal(quotaLines[weekIndex + 1], "compactions  2");
	state.codexWeeklyQuota = undefined;
	assert.match(__test__.renderSidebar(state as never, theme as never, new Map(), 48, 40).join("\n"), /week  loading…/);
	state.codexWeeklyQuota = null;
	assert.match(__test__.renderSidebar(state as never, theme as never, new Map(), 48, 40).join("\n"), /week  unavailable/);
	state.ctx.model.provider = "anthropic";
	assert.doesNotMatch(__test__.renderSidebar(state as never, theme as never, new Map(), 48, 40).join("\n"), /week /);
	state.gitRepos = [{ path: "/repo", label: "repo", branch: "main", files: [] }, {
		path: "/outside/repo",
		label: "outside/repo",
		branch: "clean-sibling",
		files: [],
	}];
	const untouchedCleanLines = __test__.renderSidebar(state as never, theme as never, new Map(), 48, 40).join("\n");
	assert.match(untouchedCleanLines, /repo\n• main\nclean/);
	assert.doesNotMatch(untouchedCleanLines, /clean-sibling/);
	state.workedWorktrees.add("/outside/repo");
	const rememberedCleanLines = __test__.renderSidebar(state as never, theme as never, new Map(), 48, 40).join("\n");
	assert.match(rememberedCleanLines, /clean-sibling/);
	assert.match(rememberedCleanLines, /clean/);
	state.workedWorktrees.clear();
	state.gitRepos = [{ path: "/repo", label: "repo", branch: "?", files: [], error: "git status failed" }];
	assert.match(__test__.renderSidebar(state as never, theme as never, new Map(), 48, 40).join("\n"), /git status failed/);
	const spacedLines = __test__.renderSidebar(state as never, theme as never, new Map(), 48, 40);
	for (const title of ["Conversation", "Stats", "Subagents", "Todos (0/0)", "Git"]) {
		assert.equal(spacedLines[spacedLines.indexOf(title) - 1], "");
	}
}

await main();
