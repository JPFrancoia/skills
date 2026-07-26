/**
 * pi-background-commit — run /m [repo-path] as an async contextual commit.
 *
 * Install by symlinking this file into ~/.pi/agent/extensions/ and running /reload.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";

const RPC_REQUEST = "subagents:rpc:v1:request";
const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
const RPC_TIMEOUT_MS = 30_000;

type RpcReply = {
	success?: boolean;
	error?: { message?: string };
};

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	try {
		if (ctx.hasUI) ctx.ui.notify(message, level);
	} catch {
		// Async replies may arrive after a print-mode session has shut down.
	}
}

function repoArgument(args: string): string {
	const value = args.trim();
	if (!value) return ".";
	if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
		return value.slice(1, -1);
	}
	return value;
}

async function git(pi: ExtensionAPI, cwd: string, args: string[]) {
	return pi.exec("git", ["-C", cwd, ...args], { timeout: 5_000 });
}

type Worktree = { path: string; branch?: string };

function parseWorktrees(output: string): Worktree[] {
	const worktrees: Worktree[] = [];
	let path: string | undefined;
	let branch: string | undefined;
	let bare = false;
	const flush = () => {
		if (path && !bare) worktrees.push({ path: resolve(path), branch });
		path = undefined;
		branch = undefined;
		bare = false;
	};
	for (const token of output.split("\0")) {
		if (!token) {
			flush();
			continue;
		}
		if (token.startsWith("worktree ")) path = token.slice("worktree ".length);
		else if (token.startsWith("branch refs/heads/")) branch = token.slice("branch refs/heads/".length);
		else if (token === "bare") bare = true;
	}
	flush();
	return worktrees;
}

async function resolveRepository(pi: ExtensionAPI, cwd: string, selector: string): Promise<{ repository?: string; error?: string }> {
	const direct = await git(pi, resolve(cwd, selector), ["rev-parse", "--show-toplevel"]);
	if (direct.code === 0) return { repository: direct.stdout.replace(/[\r\n]+$/, "") };

	const listed = await git(pi, cwd, ["worktree", "list", "--porcelain", "-z"]);
	if (listed.code !== 0) return { error: `${selector} is not a Git repository.` };
	const matches = [...new Set(parseWorktrees(listed.stdout)
		.filter((worktree) => basename(worktree.path) === selector || worktree.branch === selector)
		.map((worktree) => worktree.path))];
	if (matches.length > 1) return { error: `Ambiguous worktree ${selector}: ${matches.join(", ")}` };
	if (matches.length === 0) return { error: `${selector} is not a Git repository.` };

	const matched = await git(pi, matches[0]!, ["rev-parse", "--show-toplevel"]);
	return matched.code === 0
		? { repository: matched.stdout.replace(/[\r\n]+$/, "") }
		: { error: `${selector} is not a Git repository.` };
}

function watchLaunchReply(pi: ExtensionAPI, ctx: ExtensionContext, requestId: string, repository: string): void {
	const event = `${RPC_REPLY_PREFIX}${requestId}`;
	let unsubscribe: (() => void) | undefined;
	const timeout = setTimeout(() => {
		unsubscribe?.();
		notify(ctx, "Background commit launch timed out; run /subagents-doctor.", "error");
	}, RPC_TIMEOUT_MS);
	timeout.unref();

	unsubscribe = pi.events.on(event, (data) => {
		clearTimeout(timeout);
		unsubscribe?.();
		const reply = data as RpcReply;
		if (reply.success) {
			notify(ctx, `Background commit started in ${repository}.`);
			return;
		}
		notify(ctx, reply.error?.message ?? "Background commit failed to launch.", "error");
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("m", {
		description: "Commit staged changes contextually in the background",
		getArgumentCompletions: () => null,
		handler: async (args, ctx) => {
			const target = await resolveRepository(pi, ctx.cwd, repoArgument(args));
			if (!target.repository) {
				notify(ctx, target.error ?? "Could not resolve Git repository.", "error");
				return;
			}
			const repository = target.repository;

			const stagedResult = await git(pi, repository, ["diff", "--cached", "--quiet", "--exit-code"]);
			if (stagedResult.code === 0) {
				notify(ctx, `No staged changes in ${repository}.`, "warning");
				return;
			}
			if (stagedResult.code !== 1) {
				notify(ctx, stagedResult.stderr.trim() || "Could not inspect staged changes.", "error");
				return;
			}

			const requestId = `background-commit-${randomUUID()}`;
			const sessionFile = ctx.sessionManager.getSessionFile();
			const context = sessionFile && existsSync(sessionFile) && ctx.sessionManager.getLeafId() ? "fork" : "fresh";
			watchLaunchReply(pi, ctx, requestId, repository);

			pi.events.emit(RPC_REQUEST, {
				version: 1,
				requestId,
				method: "spawn",
				params: {
					agent: "contextual-committer",
					cwd: repository,
					context,
					async: true,
					clarify: false,
					agentScope: "both",
					task: `Target repository: ${repository}\nCommit whatever is staged there when you run. Use git -C with that exact path for every Git command. Follow your contextual commit instructions.`,
				},
				source: { extension: "pi-background-commit" },
			});

			notify(ctx, `Launching background commit in ${repository}…`);
		},
	});
}

export const __test__ = { parseWorktrees, repoArgument };
