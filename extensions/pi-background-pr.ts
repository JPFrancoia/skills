/**
 * pi-background-pr — run /pr [repo-path] as an async commit/PR/CI workflow.
 *
 * Install by symlinking this file into ~/.pi/agent/extensions/ and running /reload.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

const RPC_REQUEST = "subagents:rpc:v1:request";
const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
const RPC_TIMEOUT_MS = 30_000;
const PRUNED_DIRS = new Set([".cache", ".next", ".venv", "build", "dist", "node_modules", "target", "vendor", "venv"]);

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

async function kind(path: string): Promise<"directory" | "file" | undefined> {
	try {
		const value = await stat(path);
		if (value.isDirectory()) return "directory";
		if (value.isFile()) return "file";
	} catch {
		// Missing and unreadable paths are not repositories.
	}
	return undefined;
}

async function discoverRepositories(root: string): Promise<string[]> {
	const repositories: string[] = [];
	const queue = [root];
	while (queue.length > 0) {
		const parent = queue.shift()!;
		let entries: Dirent[];
		try {
			entries = await readdir(parent, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name === ".git" || PRUNED_DIRS.has(entry.name)) continue;
			const path = join(parent, entry.name);
			const marker = await kind(join(path, ".git"));
			if (marker === "directory") repositories.push(path);
			else if (marker !== "file") queue.push(path);
		}
	}
	return repositories.sort();
}

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

async function discoverCompletionTargets(pi: ExtensionAPI, cwd: string): Promise<Worktree[]> {
	const rootResult = await git(pi, cwd, ["rev-parse", "--show-toplevel"]);
	if (rootResult.code !== 0) return [];
	const root = resolve(rootResult.stdout.replace(/[\r\n]+$/, ""));
	const owners = [root, ...await discoverRepositories(root)];
	const groups = await Promise.all(owners.map(async (owner) => {
		const listed = await git(pi, owner, ["worktree", "list", "--porcelain", "-z"]);
		return listed.code === 0 ? parseWorktrees(listed.stdout) : [];
	}));
	const targets = new Map<string, Worktree>();
	for (const target of groups.flat()) targets.set(target.path, target);
	return [...targets.values()];
}

function quoteArgument(path: string): string {
	if (!/\s/.test(path)) return path;
	return path.includes('"') ? `'${path}'` : `"${path}"`;
}

function completionItems(cwd: string, targets: readonly Worktree[], prefix: string): AutocompleteItem[] | null {
	const query = (prefix.trim() ? repoArgument(prefix) : "").replace(/^["']/, "").toLowerCase();
	const items = targets
		.map((target) => {
			const path = relative(cwd, target.path) || ".";
			const label = basename(target.path);
			return {
				value: quoteArgument(path),
				label,
				description: `${target.branch ?? "detached"} · ${path}`,
				path,
				search: `${path} ${label} ${target.branch ?? "detached"} ${target.path}`.toLowerCase(),
			};
		})
		.filter((item) => !query || item.search.includes(query))
		.sort((left, right) => (left.path === "." ? -1 : right.path === "." ? 1 : left.path.localeCompare(right.path)))
		.map(({ value, label, description }) => ({ value, label, description }));
	return items.length > 0 ? items : null;
}

async function getCompletions(pi: ExtensionAPI, cwd: string, targets: readonly Worktree[], prefix: string): Promise<AutocompleteItem[] | null> {
	const staged = await Promise.all(targets.map(async (target) => {
		const result = await git(pi, target.path, ["diff", "--cached", "--quiet", "--exit-code"]);
		return result.code === 1 ? target : undefined;
	}));
	return completionItems(cwd, staged.filter((target): target is Worktree => target !== undefined), prefix);
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
		notify(ctx, "Background PR launch timed out; run /subagents-doctor.", "error");
	}, RPC_TIMEOUT_MS);
	timeout.unref();

	unsubscribe = pi.events.on(event, (data) => {
		clearTimeout(timeout);
		unsubscribe?.();
		const reply = data as RpcReply;
		if (reply.success) {
			notify(ctx, `Background PR workflow started in ${repository}.`);
			return;
		}
		notify(ctx, reply.error?.message ?? "Background PR workflow failed to launch.", "error");
	});
}

export default function (pi: ExtensionAPI) {
	let completionCwd = process.cwd();
	let completionTargets: Promise<Worktree[]> | undefined;
	pi.on("session_start", (_event, ctx) => {
		completionCwd = ctx.cwd;
		completionTargets = undefined;
	});

	pi.registerCommand("pr", {
		description: "Commit, push, open a PR or MR, and watch CI in the background",
		getArgumentCompletions: async (prefix) => {
			const cwd = completionCwd;
			const targets = await (completionTargets ??= discoverCompletionTargets(pi, cwd));
			return cwd === completionCwd ? getCompletions(pi, cwd, targets, prefix) : null;
		},
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

			const requestId = `background-pr-${randomUUID()}`;
			const sessionFile = ctx.sessionManager.getSessionFile();
			const context = sessionFile && existsSync(sessionFile) && ctx.sessionManager.getLeafId() ? "fork" : "fresh";
			watchLaunchReply(pi, ctx, requestId, repository);

			pi.events.emit(RPC_REQUEST, {
				version: 1,
				requestId,
				method: "spawn",
				params: {
					agent: "pull-request-creator",
					cwd: repository,
					context,
					async: true,
					clarify: false,
					agentScope: "both",
					task: `Target repository: ${repository}\nCommit whatever is staged there, creating a meaningful branch first if HEAD is main or master. Use git -C with that exact path for every Git command. Push to origin, create or reuse the matching GitHub PR or GitLab MR, watch CI, and follow your pull-request instructions.`,
				},
				source: { extension: "pi-background-pr" },
			});

			notify(ctx, `Launching background PR workflow in ${repository}…`);
		},
	});
}

export const __test__ = { completionItems, discoverRepositories, parseWorktrees, repoArgument };
