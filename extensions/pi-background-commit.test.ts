import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import backgroundCommit, { __test__ } from "./pi-background-commit.ts";

const RPC_REQUEST = "subagents:rpc:v1:request";
const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";

type Result = { code: number; stdout: string; stderr: string };
type ExecCall = { command: string; args: string[] };

type Harness = {
	complete: (prefix: string) => Promise<Array<{ value: string; label: string; description?: string }> | null>;
	handler: (args: string, ctx: unknown) => Promise<void>;
	ctx: unknown;
	calls: ExecCall[];
	emitted: () => unknown;
	notifications: string[];
	startSession: (cwd: string) => void;
};

function harness(results: Result[], sessionFile = "/dev/null", leafId: string | null = "leaf-id"): Harness {
	let complete: Harness["complete"] | undefined;
	let handler: Harness["handler"] | undefined;
	let sessionStart: ((event: unknown, ctx: { cwd: string }) => void) | undefined;
	let emitted: unknown;
	const calls: ExecCall[] = [];
	const listeners = new Map<string, (data: unknown) => void>();
	const notifications: string[] = [];
	const pi = {
		on(event: string, callback: (event: unknown, ctx: { cwd: string }) => void) {
			if (event === "session_start") sessionStart = callback;
		},
		registerCommand(_name: string, options: { getArgumentCompletions: Harness["complete"]; handler: Harness["handler"] }) {
			complete = options.getArgumentCompletions;
			handler = options.handler;
		},
		exec: async (command: string, args: string[]) => {
			calls.push({ command, args });
			const result = results.shift();
			assert.ok(result, "unexpected git invocation");
			return result;
		},
		events: {
			on(event: string, callback: (data: unknown) => void) {
				listeners.set(event, callback);
				return () => listeners.delete(event);
			},
			emit(event: string, data: unknown) {
				if (event !== RPC_REQUEST) return;
				emitted = data;
				const requestId = (data as { requestId: string }).requestId;
				listeners.get(`${RPC_REPLY_PREFIX}${requestId}`)?.({ success: true });
			},
		},
	};
	backgroundCommit(pi as never);
	assert.ok(complete);
	assert.ok(handler);
	sessionStart?.({}, { cwd: "/work" });
	return {
		complete,
		handler,
		ctx: {
			cwd: "/work",
			hasUI: true,
			sessionManager: {
				getSessionFile: () => sessionFile,
				getLeafId: () => leafId,
			},
			ui: { notify: (message: string) => notifications.push(message) },
		},
		calls,
		emitted: () => emitted,
		notifications,
		startSession: (cwd) => sessionStart?.({}, { cwd }),
	};
}

async function main(): Promise<void> {
	assert.equal(__test__.repoArgument(""), ".");
	assert.equal(__test__.repoArgument("'nested repo'"), "nested repo");
	assert.deepEqual(__test__.parseWorktrees([
		"worktree /work/main",
		"HEAD abc123",
		"branch refs/heads/main",
		"",
		"worktree /work/task checkout ",
		"HEAD def456",
		"branch refs/heads/feat/task",
		"",
		"worktree /work/bare.git",
		"bare",
		"",
	].join("\0")), [
		{ path: "/work/main", branch: "main" },
		{ path: "/work/task checkout ", branch: "feat/task" },
	]);
	const items = __test__.completionItems("/work", [
		{ path: "/work", branch: "main" },
		{ path: "/work/nested repo", branch: "feat/nested" },
		{ path: "/sibling/detached" },
	], "");
	assert.equal(items?.[0]?.value, ".");
	assert.equal(items?.find((item) => item.label === "nested repo")?.value, '"nested repo"');
	assert.deepEqual(__test__.completionItems("/work", [{ path: "/work/nested repo", branch: "feat/nested" }], "FEAT/NESTED"), [{
		value: '"nested repo"',
		label: "nested repo",
		description: "feat/nested · nested repo",
	}]);
	assert.equal(__test__.completionItems("/work", [{ path: "/work", branch: "main" }], "missing"), null);

	const discoveryRoot = await mkdtemp(join(tmpdir(), "pi-background-commit-"));
	try {
		await mkdir(join(discoveryRoot, "nested repo", ".git"), { recursive: true });
		await mkdir(join(discoveryRoot, "linked"), { recursive: true });
		await writeFile(join(discoveryRoot, "linked", ".git"), "gitdir: elsewhere\n");
		await mkdir(join(discoveryRoot, "node_modules", "ignored", ".git"), { recursive: true });
		assert.deepEqual(await __test__.discoverRepositories(discoveryRoot), [join(discoveryRoot, "nested repo")]);
	} finally {
		await rm(discoveryRoot, { recursive: true, force: true });
	}

	const completionWorktrees = [
		"worktree /work",
		"branch refs/heads/main",
		"",
		"worktree /sibling/task-worktree",
		"branch refs/heads/feat/task",
		"",
	].join("\0");
	const completionResults = [
		{ code: 0, stdout: "/work\n", stderr: "" },
		{ code: 0, stdout: completionWorktrees, stderr: "" },
		{ code: 0, stdout: "", stderr: "" },
		{ code: 1, stdout: "", stderr: "" },
	];
	const completion = harness(completionResults);
	assert.deepEqual(await completion.complete(""), [{
		value: "../sibling/task-worktree",
		label: "task-worktree",
		description: "feat/task · ../sibling/task-worktree",
	}]);
	assert.deepEqual(completion.calls, [
		{ command: "git", args: ["-C", "/work", "rev-parse", "--show-toplevel"] },
		{ command: "git", args: ["-C", "/work", "worktree", "list", "--porcelain", "-z"] },
		{ command: "git", args: ["-C", "/work", "diff", "--cached", "--quiet", "--exit-code"] },
		{ command: "git", args: ["-C", "/sibling/task-worktree", "diff", "--cached", "--quiet", "--exit-code"] },
	]);
	completionResults.push(
		{ code: 0, stdout: "/other\n", stderr: "" },
		{ code: 0, stdout: "worktree /other\0branch refs/heads/other\0\0", stderr: "" },
		{ code: 1, stdout: "", stderr: "" },
	);
	completion.startSession("/other");
	assert.equal((await completion.complete(""))?.[0]?.value, ".");
	assert.deepEqual(completion.calls.slice(-3), [
		{ command: "git", args: ["-C", "/other", "rev-parse", "--show-toplevel"] },
		{ command: "git", args: ["-C", "/other", "worktree", "list", "--porcelain", "-z"] },
		{ command: "git", args: ["-C", "/other", "diff", "--cached", "--quiet", "--exit-code"] },
	]);

	const invalid = harness([
		{ code: 128, stdout: "", stderr: "not a repository" },
		{ code: 128, stdout: "", stderr: "not a repository" },
	]);
	await invalid.handler("missing", invalid.ctx);
	assert.equal(invalid.emitted(), undefined);
	assert.match(invalid.notifications[0] ?? "", /not a Git repository/);

	const worktreeList = [
		"worktree /work",
		"HEAD abc123",
		"branch refs/heads/main",
		"",
		"worktree /sibling/task-worktree",
		"HEAD def456",
		"branch refs/heads/feat/task-worktree",
		"",
	].join("\0");
	const basenameTarget = harness([
		{ code: 128, stdout: "", stderr: "not a repository" },
		{ code: 0, stdout: worktreeList, stderr: "" },
		{ code: 0, stdout: "/sibling/task-worktree\n", stderr: "" },
		{ code: 1, stdout: "", stderr: "" },
	]);
	await basenameTarget.handler("task-worktree", basenameTarget.ctx);
	assert.equal((basenameTarget.emitted() as { params: { cwd: string } }).params.cwd, "/sibling/task-worktree");
	assert.deepEqual(basenameTarget.calls, [
		{ command: "git", args: ["-C", "/work/task-worktree", "rev-parse", "--show-toplevel"] },
		{ command: "git", args: ["-C", "/work", "worktree", "list", "--porcelain", "-z"] },
		{ command: "git", args: ["-C", "/sibling/task-worktree", "rev-parse", "--show-toplevel"] },
		{ command: "git", args: ["-C", "/sibling/task-worktree", "diff", "--cached", "--quiet", "--exit-code"] },
	]);

	const branchTarget = harness([
		{ code: 128, stdout: "", stderr: "not a repository" },
		{ code: 0, stdout: worktreeList, stderr: "" },
		{ code: 0, stdout: "/sibling/task-worktree\n", stderr: "" },
		{ code: 1, stdout: "", stderr: "" },
	]);
	await branchTarget.handler("feat/task-worktree", branchTarget.ctx);
	assert.equal((branchTarget.emitted() as { params: { cwd: string } }).params.cwd, "/sibling/task-worktree");

	const ambiguous = harness([
		{ code: 128, stdout: "", stderr: "not a repository" },
		{ code: 0, stdout: [
			"worktree /one/task",
			"branch refs/heads/feat/one",
			"",
			"worktree /two/other",
			"branch refs/heads/task",
			"",
		].join("\0"), stderr: "" },
	]);
	await ambiguous.handler("task", ambiguous.ctx);
	assert.equal(ambiguous.emitted(), undefined);
	assert.match(ambiguous.notifications[0] ?? "", /Ambiguous worktree task: \/one\/task, \/two\/other/);

	const clean = harness([
		{ code: 0, stdout: "/work/repo\n", stderr: "" },
		{ code: 0, stdout: "", stderr: "" },
	]);
	await clean.handler("repo", clean.ctx);
	assert.equal(clean.emitted(), undefined);
	assert.match(clean.notifications[0] ?? "", /No staged changes/);

	const staged = harness([
		{ code: 0, stdout: "/work/enterprise\n", stderr: "" },
		{ code: 1, stdout: "", stderr: "" },
	]);
	await staged.handler("enterprise", staged.ctx);
	const request = staged.emitted() as {
		method: string;
		params: { async: boolean; context: string; cwd: string; workflowScript: string; clarify?: unknown; agent?: unknown; task?: unknown };
	};
	assert.equal(request.method, "spawn");
	assert.deepEqual(
		[request.params.async, request.params.context, request.params.cwd],
		[true, "fork", "/work/enterprise"],
	);
	assert.match(request.params.workflowScript, /agent: "contextual-committer"/);
	assert.match(request.params.workflowScript, /Target repository: \/work\/enterprise/);
	assert.match(request.params.workflowScript, /Use git -C with that exact path/);
	assert.doesNotMatch(request.params.workflowScript, /Expected HEAD|Expected staged tree/);
	assert.equal(request.params.clarify, undefined);
	assert.equal(request.params.agent, undefined);
	assert.equal(request.params.task, undefined);
	assert.deepEqual(staged.calls, [
		{ command: "git", args: ["-C", "/work/enterprise", "rev-parse", "--show-toplevel"] },
		{ command: "git", args: ["-C", "/work/enterprise", "diff", "--cached", "--quiet", "--exit-code"] },
	]);

	const emptySession = harness([
		{ code: 0, stdout: "/work/enterprise\n", stderr: "" },
		{ code: 1, stdout: "", stderr: "" },
	], "/work/missing-session.jsonl");
	await emptySession.handler("enterprise", emptySession.ctx);
	assert.equal((emptySession.emitted() as { params: { context: string } }).params.context, "fresh");

	const emptyHistory = harness([
		{ code: 0, stdout: "/work/enterprise\n", stderr: "" },
		{ code: 1, stdout: "", stderr: "" },
	], "/dev/null", null);
	await emptyHistory.handler("enterprise", emptyHistory.ctx);
	assert.equal((emptyHistory.emitted() as { params: { context: string } }).params.context, "fresh");
}

await main();
