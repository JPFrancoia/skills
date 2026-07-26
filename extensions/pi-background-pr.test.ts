import assert from "node:assert/strict";
import backgroundPr, { __test__ } from "./pi-background-pr.ts";

const RPC_REQUEST = "subagents:rpc:v1:request";
const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";

type Result = { code: number; stdout: string; stderr: string };
type ExecCall = { command: string; args: string[] };
type RpcReply = { success?: boolean; error?: { message?: string } };

type Harness = {
	handler: (args: string, ctx: unknown) => Promise<void>;
	ctx: unknown;
	calls: ExecCall[];
	emitted: () => unknown;
	notifications: string[];
};

function harness(
	results: Result[],
	sessionFile = "/dev/null",
	leafId: string | null = "leaf-id",
	rpcReply: RpcReply = { success: true },
): Harness {
	let handler: Harness["handler"] | undefined;
	let emitted: unknown;
	const calls: ExecCall[] = [];
	const listeners = new Map<string, (data: unknown) => void>();
	const notifications: string[] = [];
	const pi = {
		registerCommand(_name: string, options: { handler: Harness["handler"] }) {
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
				listeners.get(`${RPC_REPLY_PREFIX}${requestId}`)?.(rpcReply);
			},
		},
	};
	backgroundPr(pi as never);
	assert.ok(handler);
	return {
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
		{ code: 0, stdout: "/work/infra\n", stderr: "" },
		{ code: 1, stdout: "", stderr: "" },
	]);
	await staged.handler("infra", staged.ctx);
	const request = staged.emitted() as {
		method: string;
		params: { agent: string; async: boolean; context: string; cwd: string; task: string };
	};
	assert.equal(request.method, "spawn");
	assert.deepEqual(
		[request.params.agent, request.params.async, request.params.context, request.params.cwd],
		["pull-request-creator", true, "fork", "/work/infra"],
	);
	assert.match(request.params.task, /Target repository: \/work\/infra/);
	assert.match(request.params.task, /Use git -C with that exact path/);
	assert.match(request.params.task, /GitHub PR or GitLab MR/);
	assert.match(request.params.task, /watch CI/);
	assert.deepEqual(staged.calls, [
		{ command: "git", args: ["-C", "/work/infra", "rev-parse", "--show-toplevel"] },
		{ command: "git", args: ["-C", "/work/infra", "diff", "--cached", "--quiet", "--exit-code"] },
	]);

	const spaced = harness([
		{ code: 0, stdout: "/work/trailing-space \n", stderr: "" },
		{ code: 1, stdout: "", stderr: "" },
	]);
	await spaced.handler("trailing-space ", spaced.ctx);
	assert.equal((spaced.emitted() as { params: { cwd: string } }).params.cwd, "/work/trailing-space ");
	assert.equal(spaced.calls[1]?.args[1], "/work/trailing-space ");

	const rejected = harness(
		[
			{ code: 0, stdout: "/work/repo\n", stderr: "" },
			{ code: 1, stdout: "", stderr: "" },
		],
		"/dev/null",
		"leaf-id",
		{ success: false, error: { message: "spawn rejected" } },
	);
	await rejected.handler("repo", rejected.ctx);
	assert.match(rejected.notifications.join("\n"), /spawn rejected/);

	const emptySession = harness([
		{ code: 0, stdout: "/work/infra\n", stderr: "" },
		{ code: 1, stdout: "", stderr: "" },
	], "/work/missing-session.jsonl");
	await emptySession.handler("infra", emptySession.ctx);
	assert.equal((emptySession.emitted() as { params: { context: string } }).params.context, "fresh");

	const emptyHistory = harness([
		{ code: 0, stdout: "/work/infra\n", stderr: "" },
		{ code: 1, stdout: "", stderr: "" },
	], "/dev/null", null);
	await emptyHistory.handler("infra", emptyHistory.ctx);
	assert.equal((emptyHistory.emitted() as { params: { context: string } }).params.context, "fresh");
}

await main();
