/**
 * pi-sidebar — fixed right sidebar for this Pi setup.
 *
 * Shows session/model/context/turns/cost, rpiv-todo, extension statuses, and
 * root+nested-repository Git changes. Install with:
 *   pi install /absolute/path/to/extensions/pi-sidebar.ts
 *
 * Pi has no public reserved-column API, so SidebarCompositor carefully wraps
 * private TUI terminal/doRender fields and restores them on disposal.
 */

import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const DEFAULT_WIDTH = 53;
const MIN_MAIN_WIDTH = 70;
const REFRESH_TICKS = 15;
const TODO_WIDGET_KEY = "rpiv-todos";
const WORKED_WORKTREE_ENTRY = "pi-sidebar-worktree-worked";
const SUBAGENT_RUN_ENTRY = "pi-sidebar-subagent-run";
const SUBAGENT_ASYNC_ENTRY = "pi-sidebar-subagent-async";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const WEEKLY_QUOTA_BAR_WIDTH = 10;
const SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const SUBAGENT_RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
const SUBAGENT_RPC_TIMEOUT_MS = 500;
const SUBAGENT_LIFECYCLE_VERSIONS = new Set([2, 3]);
const PRUNED_DIRS = new Set([".cache", ".next", ".venv", "build", "dist", "node_modules", "target", "vendor", "venv"]);
const GIT_REFRESH_TOOLS = new Set(["edit", "write"]);

type Usage = {
	cost?: { total?: number };
};

type SessionStats = {
	cost: number;
	turns: number;
	compactions: number;
};

type TodoTask = {
	id: number;
	subject: string;
	activeForm?: string;
	status: "pending" | "in_progress" | "completed" | "deleted";
};

type GitFile = {
	status: string;
	path: string;
	oldPath?: string;
	added?: number;
	removed?: number;
	binary?: boolean;
	untracked?: boolean;
};

type GitRepo = {
	path: string;
	label: string;
	branch: string;
	files: GitFile[];
	error?: string;
};

type RepoDiscovery = {
	repos: string[];
	linkedWorktrees: string[];
};

type WorktreeTarget = {
	owner: string;
	path: string;
	linkedWorktrees: string[];
};

type FooterData = {
	getExtensionStatuses(): ReadonlyMap<string, string>;
};

type CodexWeeklyQuota = {
	remaining: number;
	resetAt?: number;
};

type SubagentRun = {
	key: string;
	agent: string;
	running: boolean;
	durationMs: number;
	cost: number;
};

type SidebarState = {
	enabled: boolean;
	width: number;
	ctx?: ExtensionContext;
	title?: string;
	thinkingLevel: string;
	stats: SessionStats;
	todos: TodoTask[];
	gitRepos: GitRepo[];
	rootRepo?: string;
	linkedWorktrees: string[];
	workedWorktrees: Set<string>;
	context?: { tokens: number | null; contextWindow: number; percent: number | null };
	codexWeeklyQuota?: CodexWeeklyQuota | null;
	subagentRuns: Map<string, SubagentRun>;
	asyncRunDirs: Map<string, string>;
	foregroundSubagents: Map<string, SubagentRun[]>;
};

const EMPTY_STATS: SessionStats = {
	cost: 0,
	turns: 0,
	compactions: 0,
};

function number(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nonNegativeNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function addUsage(stats: SessionStats, usage: Usage | undefined): void {
	stats.cost += number(usage?.cost?.total);
}

function computeSessionStats(entries: readonly unknown[]): SessionStats {
	const stats: SessionStats = { ...EMPTY_STATS };

	for (const raw of entries) {
		const entry = raw as {
			type?: string;
			usage?: Usage;
			message?: { role?: string; usage?: Usage };
		};
		if (entry.type === "compaction") stats.compactions++;
		if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			addUsage(stats, entry.usage);
			continue;
		}
		if (entry.type !== "message") continue;
		if (entry.message?.role === "assistant") {
			stats.turns++;
			addUsage(stats, entry.message.usage);
		} else if (entry.message?.role === "toolResult") {
			addUsage(stats, entry.message.usage);
		}
	}
	return stats;
}

function isTodoDetails(value: unknown): value is { tasks: TodoTask[]; nextId: number } {
	if (!value || typeof value !== "object") return false;
	const details = value as { tasks?: unknown; nextId?: unknown };
	return Array.isArray(details.tasks) && typeof details.nextId === "number";
}

function replayTodos(entries: readonly unknown[]): TodoTask[] {
	let tasks: TodoTask[] = [];
	for (const raw of entries) {
		const entry = raw as {
			type?: string;
			message?: { role?: string; toolName?: string; details?: unknown };
		};
		if (entry.type !== "message" || entry.message?.role !== "toolResult" || entry.message.toolName !== "todo") continue;
		if (!isTodoDetails(entry.message.details)) continue;
		tasks = entry.message.details.tasks.map((task) => ({ ...task }));
	}
	return tasks;
}

function replayWorkedWorktrees(entries: readonly unknown[]): Set<string> {
	const paths = new Set<string>();
	for (const raw of entries) {
		const entry = raw as { type?: string; customType?: string; data?: { path?: unknown } };
		if (entry.type !== "custom" || entry.customType !== WORKED_WORKTREE_ENTRY) continue;
		if (typeof entry.data?.path === "string" && entry.data.path) paths.add(resolve(entry.data.path));
	}
	return paths;
}

function replaySubagents(entries: readonly unknown[]): { runs: Map<string, SubagentRun>; asyncRunDirs: Map<string, string> } {
	const runs = new Map<string, SubagentRun>();
	const asyncRunDirs = new Map<string, string>();
	for (const [index, raw] of entries.entries()) {
		const entry = raw as {
			id?: unknown;
			type?: string;
			customType?: string;
			data?: Record<string, unknown>;
			details?: unknown;
			message?: { role?: string; toolName?: string; toolCallId?: unknown; details?: unknown };
		};
		if (entry.type === "custom" && entry.customType === SUBAGENT_RUN_ENTRY) {
			const data = entry.data;
			if (!data || typeof data.key !== "string" || typeof data.agent !== "string" || !data.key || !data.agent) continue;
			runs.set(data.key, {
				key: data.key,
				agent: sanitizePlainText(data.agent),
				running: false,
				durationMs: nonNegativeNumber(data.durationMs) ?? 0,
				cost: nonNegativeNumber(data.cost) ?? 0,
			});
			continue;
		}
		if (entry.type === "custom" && entry.customType === SUBAGENT_ASYNC_ENTRY) {
			const data = entry.data;
			if (data && typeof data.runId === "string" && data.runId && typeof data.asyncDir === "string" && data.asyncDir) {
				asyncRunDirs.set(data.runId, data.asyncDir);
			}
			continue;
		}
		let details: unknown;
		let prefix: string | undefined;
		if (entry.type === "custom_message" && entry.customType === "subagent-slash-result") {
			const slash = entry.details && typeof entry.details === "object" ? entry.details as { requestId?: unknown; result?: { details?: unknown } } : undefined;
			details = slash?.result?.details;
			prefix = `slash:${typeof slash?.requestId === "string" ? slash.requestId : typeof entry.id === "string" ? entry.id : index}`;
		} else if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === "subagent") {
			details = entry.message.details;
			prefix = `foreground:${typeof entry.message.toolCallId === "string" ? entry.message.toolCallId : typeof entry.id === "string" ? entry.id : index}`;
		}
		if (!prefix) continue;
		const subagentDetails = details as { asyncId?: unknown; runId?: unknown; asyncDir?: unknown } | undefined;
		const runId = typeof subagentDetails?.asyncId === "string" ? subagentDetails.asyncId : typeof subagentDetails?.runId === "string" ? subagentDetails.runId : undefined;
		if (runId && typeof subagentDetails?.asyncDir === "string") asyncRunDirs.set(runId, subagentDetails.asyncDir);
		for (const run of subagentRunsFromDetails(details, prefix, false)) runs.set(run.key, run);
	}
	return { runs, asyncRunDirs };
}

function textContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join(" ");
}

function fallbackTitle(entries: readonly unknown[]): string | undefined {
	for (const raw of entries) {
		const entry = raw as { type?: string; message?: { role?: string; content?: unknown } };
		if (entry.type !== "message" || entry.message?.role !== "user") continue;
		const line = textContent(entry.message.content).split("\n").map((part) => part.trim()).find(Boolean);
		if (line) return line.replace(/\s+/g, " ");
	}
	return undefined;
}

function parseStatus(output: string): { branch: string; files: GitFile[] } {
	const tokens = output.split("\0");
	let branch = "detached";
	const files: GitFile[] = [];

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (!token) continue;
		if (token.startsWith("## ")) {
			const raw = token.slice(3);
			if (raw.startsWith("No commits yet on ")) branch = raw.slice("No commits yet on ".length);
			else if (raw.startsWith("Initial commit on ")) branch = raw.slice("Initial commit on ".length);
			else branch = raw.startsWith("HEAD ") ? "detached" : raw.split("...")[0]!.split(" ")[0]!;
			continue;
		}
		if (token.length < 4) continue;
		const code = token.slice(0, 2);
		const path = token.slice(3);
		const renamed = code.includes("R") || code.includes("C");
		const oldPath = renamed ? tokens[++i] : undefined;
		files.push({
			status: code.trim() || code,
			path,
			oldPath: oldPath || undefined,
			untracked: code === "??",
		});
	}
	return { branch, files };
}

function parseNumstat(output: string): Map<string, Pick<GitFile, "added" | "removed" | "binary">> {
	const deltas = new Map<string, Pick<GitFile, "added" | "removed" | "binary">>();
	const tokens = output.split("\0");

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (!token) continue;
		const [addedRaw = "", removedRaw = "", ...pathParts] = token.split("\t");
		let path = pathParts.join("\t");
		if (!path) {
			// `git diff --numstat -z` emits: stats+empty path, old path, new path.
			i++;
			path = tokens[++i] ?? "";
		}
		if (!path) continue;
		const binary = addedRaw === "-" || removedRaw === "-";
		deltas.set(path, {
			added: binary ? undefined : Number.parseInt(addedRaw, 10) || 0,
			removed: binary ? undefined : Number.parseInt(removedRaw, 10) || 0,
			binary,
		});
	}
	return deltas;
}

function applyNumstat(files: GitFile[], deltas: Map<string, Pick<GitFile, "added" | "removed" | "binary">>): GitFile[] {
	return files.map((file) => ({ ...file, ...deltas.get(file.path) }));
}

function normalizeRelativePath(path: string): string {
	return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function isInsideLinkedWorktree(path: string, worktrees: readonly string[]): boolean {
	const normalized = normalizeRelativePath(path);
	return worktrees.some((worktree) => normalized === worktree || normalized.startsWith(`${worktree}/`));
}

function parseWorktreePaths(output: string): string[] {
	const paths: string[] = [];
	let path: string | undefined;
	let bare = false;
	const flush = () => {
		if (path && !bare) paths.push(resolve(path));
		path = undefined;
		bare = false;
	};

	for (const token of output.split("\0")) {
		if (!token) {
			flush();
			continue;
		}
		if (token.startsWith("worktree ")) path = token.slice("worktree ".length);
		else if (token === "bare") bare = true;
	}
	flush();
	return paths;
}

async function enumerateWorktreeTargets(
	roots: readonly string[],
	rootLinkedWorktrees: readonly string[],
	listWorktrees: (root: string) => Promise<readonly string[]>,
): Promise<WorktreeTarget[]> {
	const groups = await Promise.all([...new Set(roots.map((root) => resolve(root)))].map(async (owner, index) => {
		let listed: readonly string[] = [];
		try {
			listed = await listWorktrees(owner);
		} catch {
			// A failed group still refreshes its discovered checkout.
		}
		const worktrees = [...new Set([owner, ...listed.map((path) => resolve(path))])];
		const linkedWorktrees = [...new Set([
			...(index === 0 ? rootLinkedWorktrees.map(normalizeRelativePath) : []),
			...worktrees
				.filter((path) => path !== owner && path.startsWith(`${owner}${sep}`))
				.map((path) => normalizeRelativePath(relative(owner, path))),
		])];
		return worktrees.map((path) => ({ owner, path, linkedWorktrees }));
	}));
	const seen = new Set<string>();
	return groups.flat().filter(({ path }) => {
		if (seen.has(path)) return false;
		seen.add(path);
		return true;
	});
}

function worktreeSignature(repo: GitRepo): string | undefined {
	if (repo.error) return undefined;
	return JSON.stringify(repo.files.map((file) => [
		file.status,
		file.path,
		file.oldPath,
		file.added,
		file.removed,
		file.binary,
		file.untracked,
	]));
}

function observeWorkedWorktrees(
	repos: readonly GitRepo[],
	worktreePaths: readonly string[],
	previous: ReadonlyMap<string, string>,
	worked: ReadonlySet<string>,
): { signatures: Map<string, string>; newlyWorked: string[] } {
	const byPath = new Map(repos.map((repo) => [repo.path, repo]));
	const signatures = new Map<string, string>();
	const newlyWorked: string[] = [];

	for (const path of new Set(worktreePaths.map((value) => resolve(value)))) {
		const repo = byPath.get(path);
		if (!repo) continue;
		const signature = worktreeSignature(repo);
		const prior = previous.get(path);
		if (signature === undefined) {
			if (prior !== undefined) signatures.set(path, prior);
			continue;
		}
		signatures.set(path, signature);
		if (prior !== undefined && prior !== signature && !worked.has(path)) newlyWorked.push(path);
	}
	return { signatures, newlyWorked };
}

async function kind(path: string): Promise<"directory" | "file" | undefined> {
	try {
		const value = await stat(path);
		if (value.isDirectory()) return "directory";
		if (value.isFile()) return "file";
	} catch {
		// Missing/unreadable paths are not repositories.
	}
	return undefined;
}

async function discoverRepositories(root: string): Promise<RepoDiscovery> {
	const repos: string[] = [];
	const linkedWorktrees: string[] = [];
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
			if (marker === "directory") {
				repos.push(path);
				continue;
			}
			if (marker === "file") {
				linkedWorktrees.push(normalizeRelativePath(relative(root, path)));
				continue;
			}
			queue.push(path);
		}
	}
	return { repos: repos.sort(), linkedWorktrees: linkedWorktrees.sort() };
}

function formatNumber(value: number): string {
	if (value < 1_000) return String(value);
	if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

function formatDuration(ms: number | undefined): string {
	if (ms === undefined) return "—";
	const seconds = Math.max(0, Math.floor(ms / 1_000));
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);
	if (hours > 0) return `${hours}h${minutes % 60}m`;
	if (minutes > 0) return `${minutes}m${seconds % 60}s`;
	return `${seconds}s`;
}

function collapseHome(path: string): string {
	const home = homedir();
	return path === home ? "~" : path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
}

function truncatePath(path: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(path) <= width) return path;
	if (width === 1) return "…";
	const name = path.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? path;
	if (visibleWidth(name) <= width) return name;
	return `…${name.slice(-(width - 1))}`;
}

function cleanStatusText(text: string): string {
	return text
		.replace(/(?:\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x9d[\s\S]*?(?:\x07|\x1b\\|\x9c))/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, (sequence) => sequence.endsWith("m") ? sequence : "")
		.replace(/\x1b(?!\[|\])[\x20-\x7e]/g, "")
		.replace(/[\r\n\t\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f-\u009f]/g, " ")
		.replace(/ {2,}/g, " ")
		.trim();
}

function sanitizePlainText(text: string): string {
	return text
		.replace(/(?:\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x9d[\s\S]*?(?:\x07|\x1b\\|\x9c))/g, "")
		.replace(/(?:\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_])/g, "")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function agentFromStatusLabel(value: string): string {
	const label = sanitizePlainText(value).replace(/^\[[^\]]+\]\s*/, "");
	return label.match(/\(([^()]+)\)$/)?.[1] ?? label;
}

function parseRunningAsyncSubagents(text: string): SubagentRun[] | undefined {
	const lines = text.split("\n");
	if (lines.includes("No active async runs.")) return [];
	const heading = lines.findIndex((line) => line.startsWith("Active async runs:"));
	if (heading < 0) return undefined;
	const running: SubagentRun[] = [];
	let runId = "unknown";
	for (const line of lines.slice(heading + 1)) {
		const run = line.match(/^- ([^ |]+) \|/);
		if (run) {
			runId = run[1]!;
			continue;
		}
		const step = line.match(/^\s+(\d+)\.\s+(.+?)\s+\|\s+running(?:\s+\||$)/);
		if (!step) continue;
		running.push({ key: `async:${runId}:${Number(step[1]!) - 1}`, agent: agentFromStatusLabel(step[2]!), running: true, durationMs: 0, cost: 0 });
	}
	return running;
}

function subagentRunsFromDetails(details: unknown, prefix: string, runningOverride?: boolean): SubagentRun[] {
	if (!details || typeof details !== "object") return [];
	const value = details as { results?: unknown; progress?: unknown };
	const results = Array.isArray(value.results) ? value.results : [];
	const progress = Array.isArray(value.progress) ? value.progress : [];
	const count = Math.max(results.length, progress.length);
	const runs: SubagentRun[] = [];
	for (let index = 0; index < count; index++) {
		const result = results[index] && typeof results[index] === "object" ? results[index] as Record<string, unknown> : {};
		const live = progress[index] && typeof progress[index] === "object" ? progress[index] as Record<string, unknown> : {};
		const resultProgress = result.progress && typeof result.progress === "object" ? result.progress as Record<string, unknown> : {};
		const summary = result.progressSummary && typeof result.progressSummary === "object" ? result.progressSummary as Record<string, unknown> : {};
		const agentValue = live.agent ?? resultProgress.agent ?? result.agent;
		if (typeof agentValue !== "string" || !agentValue) continue;
		const usage = result.usage && typeof result.usage === "object" ? result.usage as Record<string, unknown> : {};
		const totalCost = result.totalCost && typeof result.totalCost === "object" ? result.totalCost as Record<string, unknown> : {};
		const status = live.status ?? resultProgress.status;
		runs.push({
			key: `${prefix}:${index}`,
			agent: sanitizePlainText(agentValue),
			running: runningOverride ?? status === "running",
			durationMs: nonNegativeNumber(live.durationMs ?? resultProgress.durationMs ?? summary.durationMs) ?? 0,
			cost: nonNegativeNumber(totalCost.costUsd ?? usage.cost) ?? 0,
		});
	}
	return runs;
}

function runningForegroundSubagents(details: unknown): SubagentRun[] | undefined {
	if (!details || typeof details !== "object") return undefined;
	const value = details as { progress?: unknown; results?: unknown };
	if (!Array.isArray(value.progress) && !Array.isArray(value.results)) return undefined;
	return subagentRunsFromDetails(details, "foreground").filter((run) => run.running);
}

function initialForegroundSubagents(args: unknown): SubagentRun[] {
	if (!args || typeof args !== "object") return [];
	const value = args as { action?: unknown; agent?: unknown; async?: unknown; tasks?: unknown; chain?: unknown; concurrency?: unknown };
	if (value.action !== undefined || value.async === true) return [];
	let candidates: unknown[] = [];
	if (typeof value.agent === "string") candidates = [{ agent: value.agent }];
	else if (Array.isArray(value.tasks)) candidates = value.tasks.flatMap((candidate) => {
		const task = candidate as { count?: unknown };
		const count = typeof task.count === "number" && task.count > 1 ? Math.floor(task.count) : 1;
		return Array.from({ length: count }, () => candidate);
	});
	else if (Array.isArray(value.chain) && value.chain[0]) {
		const first = value.chain[0] as { agent?: unknown; parallel?: unknown };
		candidates = first.parallel ? (Array.isArray(first.parallel) ? first.parallel : [first.parallel]) : [first];
	}
	const concurrency = typeof value.concurrency === "number" && value.concurrency > 0 ? Math.floor(value.concurrency) : 4;
	return candidates.slice(0, concurrency).flatMap((candidate, index) => {
		const task = candidate as { agent?: unknown };
		if (typeof task.agent !== "string" || !task.agent) return [];
		return [{ key: `foreground:${index}`, agent: sanitizePlainText(task.agent), running: true, durationMs: 0, cost: 0 }];
	});
}

function subagentRunsFromAsyncStatus(value: unknown, runId: string, sessionId: string | undefined, now = Date.now()): SubagentRun[] | undefined {
	if (!value || typeof value !== "object") return undefined;
	const status = value as { lifecycleArtifactVersion?: unknown; runId?: unknown; sessionId?: unknown; steps?: unknown };
	if (!SUBAGENT_LIFECYCLE_VERSIONS.has(status.lifecycleArtifactVersion as number) || status.runId !== runId) return undefined;
	if (sessionId && status.sessionId !== sessionId) return undefined;
	if (!Array.isArray(status.steps)) return undefined;
	const runs: SubagentRun[] = [];
	for (const [index, raw] of status.steps.entries()) {
		if (!raw || typeof raw !== "object") return undefined;
		const step = raw as Record<string, unknown>;
		if (step.status === "pending") continue;
		if (typeof step.agent !== "string" || !step.agent) return undefined;
		const totalCost = step.totalCost && typeof step.totalCost === "object" ? step.totalCost as Record<string, unknown> : {};
		const cost = totalCost.costUsd === undefined ? 0 : nonNegativeNumber(totalCost.costUsd);
		const running = step.status === "running";
		const startedAt = nonNegativeNumber(step.startedAt);
		const recordedDuration = step.durationMs === undefined ? 0 : nonNegativeNumber(step.durationMs);
		if (cost === undefined || recordedDuration === undefined) return undefined;
		const durationMs = running && startedAt !== undefined ? Math.max(recordedDuration, now - startedAt) : recordedDuration;
		runs.push({ key: `async:${runId}:${index}`, agent: sanitizePlainText(step.agent), running, durationMs, cost });
	}
	return runs;
}

function aggregateSubagents(runs: Iterable<SubagentRun>): SubagentRun[] {
	const grouped = new Map<string, SubagentRun>();
	for (const run of runs) {
		if (!run.agent) continue;
		const current = grouped.get(run.agent);
		if (current) {
			current.running ||= run.running;
			current.durationMs += run.durationMs;
			current.cost += run.cost;
		} else {
			grouped.set(run.agent, { key: run.agent, agent: run.agent, running: run.running, durationMs: run.durationMs, cost: run.cost });
		}
	}
	return [...grouped.values()];
}

function formatSubagentDuration(ms: number): string {
	return formatDuration(ms).replace(/m0s$/, "m");
}

function codexAccountId(accessToken: string): string | undefined {
	try {
		const payload = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8")) as {
			"https://api.openai.com/auth"?: { chatgpt_account_id?: unknown };
		};
		const accountId = payload["https://api.openai.com/auth"]?.chatgpt_account_id;
		return typeof accountId === "string" && accountId ? accountId : undefined;
	} catch {
		return undefined;
	}
}

function parseCodexWeeklyQuota(payload: unknown): CodexWeeklyQuota | undefined {
	type Window = { used_percent?: unknown; limit_window_seconds?: unknown; reset_at?: unknown } | null;
	const rateLimit = (payload as { rate_limit?: { primary_window?: Window; secondary_window?: Window } } | undefined)?.rate_limit;
	const weekly = [rateLimit?.primary_window, rateLimit?.secondary_window]
		.find((window) => typeof window?.limit_window_seconds === "number"
			&& window.limit_window_seconds >= 6 * 24 * 60 * 60
			&& window.limit_window_seconds <= 8 * 24 * 60 * 60);
	const used = weekly?.used_percent;
	if (typeof used !== "number" || !Number.isFinite(used)) return undefined;
	const resetAt = weekly && typeof weekly.reset_at === "number" && Number.isFinite(weekly.reset_at)
		? weekly.reset_at * 1_000
		: undefined;
	return { remaining: Math.max(0, Math.min(100, 100 - used)), resetAt };
}

async function fetchCodexWeeklyQuota(ctx: ExtensionContext): Promise<CodexWeeklyQuota | undefined> {
	const auth = await ctx.modelRegistry.getProviderAuth("openai-codex");
	const accessToken = auth?.auth.apiKey;
	const accountId = accessToken && codexAccountId(accessToken);
	if (!accessToken || !accountId) return undefined;
	const response = await fetch(CODEX_USAGE_URL, {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"ChatGPT-Account-Id": accountId,
			Accept: "application/json",
			Origin: "https://chatgpt.com",
			Referer: "https://chatgpt.com/",
		},
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) return undefined;
	return parseCodexWeeklyQuota(await response.json());
}

function formatQuotaReset(resetAt: number, now = Date.now()): string {
	const remaining = Math.max(0, resetAt - now);
	return remaining >= 24 * 60 * 60 * 1_000
		? `${Math.floor(remaining / (24 * 60 * 60 * 1_000))}d`
		: `${Math.ceil(remaining / (60 * 60 * 1_000))}h`;
}

function weeklyQuotaBar(theme: Theme, remaining: number): string {
	const filled = Math.round((remaining / 100) * WEEKLY_QUOTA_BAR_WIDTH);
	const color = remaining <= 20 ? "error" : remaining <= 50 ? "warning" : "success";
	return `${theme.fg(color, "█".repeat(filled))}${theme.fg("dim", "░".repeat(WEEKLY_QUOTA_BAR_WIDTH - filled))}`;
}

function padAnsi(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function section(theme: Theme, title: string, items: string[], width: number): string[] {
	return ["", theme.fg("text", theme.bold(title)), theme.fg("borderMuted", "─".repeat(width)), ...items];
}

function fitSection(
	lines: string[],
	theme: Theme,
	title: string,
	items: string[],
	width: number,
	height: number,
	reserve: number,
): void {
	if (items.length === 0) return;
	const available = height - lines.length - reserve;
	if (available < 4) return;
	let shown = items.slice(0, available - 3);
	if (shown.length < items.length && shown.length > 0) {
		shown = items.slice(0, Math.max(0, shown.length - 1));
		shown.push(theme.fg("dim", `… ${items.length - shown.length} more`));
	}
	lines.push(...section(theme, title, shown, width));
}

function renderCore(state: SidebarState, theme: Theme, width: number): string[] {
	const ctx = state.ctx;
	const model = ctx?.model;
	const thinking = state.thinkingLevel;
	const title = truncateToWidth(sanitizePlainText(state.title || "(waiting for conversation name)"), Math.max(1, width - 1), "…");
	const modelName = sanitizePlainText(model?.id ?? "no model");
	const modelLine = `${theme.fg("dim", "model ")}${theme.fg("accent", truncateToWidth(modelName, Math.max(1, width - thinking.length - 9), "…"))}${theme.fg("dim", ` • ${thinking}`)}`;
	const location = truncatePath(sanitizePlainText(collapseHome(ctx?.cwd ?? "")), Math.max(1, width - 6));
	const usage = state.context;
	const contextLine = usage
		? `${usage.percent === null ? "?" : `${usage.percent.toFixed(1)}%`} • ${usage.tokens === null ? "?" : formatNumber(usage.tokens)} of ${formatNumber(usage.contextWindow)}`
		: "not available yet";
	const items = [
		theme.fg("text", title),
		modelLine,
		`${theme.fg("dim", "cwd   ")}${location}`,
		`${theme.fg("dim", "ctx   ")}${contextLine}`,
	];
	if (model?.provider === "openai-codex") {
		const quota = state.codexWeeklyQuota;
		items.push(quota === undefined
			? `${theme.fg("dim", "week  ")}${theme.fg("warning", "loading…")}`
			: quota === null
				? `${theme.fg("dim", "week  ")}${theme.fg("warning", "unavailable")}`
				: `${theme.fg("dim", "week  ")}${weeklyQuotaBar(theme, quota.remaining)} ${theme.fg("accent", `${Math.round(quota.remaining)}%`)}${quota.resetAt === undefined ? "" : theme.fg("dim", ` resets in ${formatQuotaReset(quota.resetAt)}`)}`);
	}
	items.push(`${theme.fg("dim", "compactions  ")}${state.stats.compactions}`);
	items.push(`${theme.fg("dim", "turns        ")}${state.stats.turns}`);
	items.push(`${theme.fg("dim", "cost         ")}$${state.stats.cost.toFixed(3)}`);
	return section(theme, "Conversation", items, width);
}

function subagentItems(state: SidebarState, theme: Theme): string[] {
	const agents = aggregateSubagents(state.subagentRuns.values());
	return agents.length
		? agents.map((agent) => `${theme.fg(agent.running ? "success" : "error", "●")} ${theme.fg("text", sanitizePlainText(agent.agent))} ${theme.fg("dim", `${formatSubagentDuration(agent.durationMs)} · $${agent.cost.toFixed(4)}`)}`)
		: [theme.fg("dim", "(none used)")];
}

function todoItems(state: SidebarState, theme: Theme): { title: string; items: string[] } {
	const visible = state.todos.filter((task) => task.status !== "deleted");
	const completed = visible.filter((task) => task.status === "completed").length;
	const items = visible.map((task) => {
		const glyph = task.status === "completed"
			? theme.fg("success", "✓")
			: task.status === "in_progress"
				? theme.fg("accent", "●")
				: theme.fg("dim", "○");
		const suffix = task.status === "in_progress" && task.activeForm
			? theme.fg("dim", ` (${sanitizePlainText(task.activeForm)})`)
			: "";
		return `${glyph} ${theme.fg(task.status === "completed" ? "dim" : "text", sanitizePlainText(task.subject))}${suffix}`;
	});
	return { title: `Todos (${completed}/${visible.length})`, items: items.length ? items : [theme.fg("dim", "(no todos)")] };
}

function extensionItems(theme: Theme, statuses: ReadonlyMap<string, string>): string[] {
	return [...statuses.entries()]
		.filter(([key, text]) => key !== "mcp" && key !== "mcp-auth" && cleanStatusText(text) !== "")
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => cleanStatusText(text));
}

function gitItems(state: SidebarState, theme: Theme, width: number): string[] {
	if (!state.rootRepo) return [theme.fg("dim", "(not a git repository)")];
	if (state.gitRepos.length === 0) return [theme.fg("dim", "(refreshing…)")];
	const items: string[] = [];
	for (const repo of state.gitRepos) {
		if (repo.files.length === 0 && !repo.error && repo.path !== state.rootRepo && !state.workedWorktrees.has(repo.path)) continue;
		if (items.length > 0) items.push("");
		const safeBranch = sanitizePlainText(repo.branch);
		const safeLabel = sanitizePlainText(repo.label);
		items.push(theme.fg("accent", truncatePath(safeLabel, width)));
		items.push(theme.fg("dim", truncateToWidth(`• ${safeBranch}`, width, "…")));
		if (repo.error) {
			items.push(theme.fg("warning", repo.error));
			continue;
		}
		if (repo.files.length === 0) {
			items.push(theme.fg("success", "clean"));
			continue;
		}
		for (const file of repo.files) {
			const delta = file.untracked
				? "new"
				: file.binary
					? "bin"
					: file.added !== undefined || file.removed !== undefined
						? `+${file.added ?? 0}/-${file.removed ?? 0}`
						: "";
			const suffixWidth = visibleWidth(delta) + (delta ? 1 : 0);
			const pathWidth = Math.max(1, width - 4 - suffixWidth);
			const path = truncatePath(sanitizePlainText(file.path), pathWidth);
			const codeColor = file.status.includes("D") ? "toolDiffRemoved" : file.status.includes("?") || file.status.includes("A") ? "toolDiffAdded" : "warning";
			const coloredDelta = file.untracked
				? theme.fg("toolDiffAdded", delta)
				: delta.startsWith("+")
					? `${theme.fg("toolDiffAdded", delta.split("/")[0]!)}${theme.fg("dim", "/")}${theme.fg("toolDiffRemoved", delta.split("/")[1]!)}`
					: theme.fg("dim", delta);
			items.push(`${theme.fg(codeColor, file.status.padEnd(2))} ${path}${delta ? ` ${coloredDelta}` : ""}`);
		}
	}
	return items.length ? items : [theme.fg("success", "clean")];
}

function renderSidebar(
	state: SidebarState,
	theme: Theme,
	statuses: ReadonlyMap<string, string>,
	width: number,
	height: number,
): string[] {
	const lines = renderCore(state, theme, width);
	if (lines.length >= height) return lines.slice(0, height);
	if (height - lines.length < 4) return lines.slice(0, height);
	lines.push(...section(theme, "Subagents", subagentItems(state, theme), width));

	const todos = todoItems(state, theme);
	const extensions = extensionItems(theme, statuses);
	const git = gitItems(state, theme, width);
	fitSection(lines, theme, todos.title, todos.items, width, height, 5 + (extensions.length ? 4 : 0));
	fitSection(lines, theme, "Extensions", extensions, width, height, 5);
	fitSection(lines, theme, "Git", git, width, height, 0);
	return lines.slice(0, height);
}

function findDescriptor(obj: object, key: string): { owner: object; descriptor: PropertyDescriptor } | undefined {
	let owner: object | null = obj;
	while (owner) {
		const descriptor = Object.getOwnPropertyDescriptor(owner, key);
		if (descriptor) return { owner, descriptor };
		owner = Object.getPrototypeOf(owner);
	}
	return undefined;
}

class SidebarCompositor {
	private readonly tui: { terminal?: unknown; doRender?: () => void; stopped?: boolean; requestRender(): void };
	private readonly terminal: { rows?: number; write(data: string): void };
	private readonly getState: () => SidebarState;
	private readonly getTheme: () => Theme;
	private readonly getStatuses: () => ReadonlyMap<string, string>;
	private readonly columnsDescriptor?: { owner: object; descriptor: PropertyDescriptor };
	private readonly ownColumnsDescriptor?: PropertyDescriptor;
	private readonly originalDoRender?: () => void;
	private readonly originalWrite: (data: string) => void;
	private disposed = false;

	constructor(
		tui: SidebarCompositor["tui"],
		getState: () => SidebarState,
		getTheme: () => Theme,
		getStatuses: () => ReadonlyMap<string, string>,
	) {
		this.tui = tui;
		this.terminal = (tui.terminal ?? tui) as SidebarCompositor["terminal"];
		this.getState = getState;
		this.getTheme = getTheme;
		this.getStatuses = getStatuses;
		this.columnsDescriptor = findDescriptor(this.terminal, "columns");
		this.ownColumnsDescriptor = Object.getOwnPropertyDescriptor(this.terminal, "columns");
		this.originalDoRender = tui.doRender;
		this.originalWrite = this.terminal.write.bind(this.terminal);
	}

	private rawColumns(): number {
		const descriptor = this.columnsDescriptor?.descriptor;
		const value = descriptor?.get
			? descriptor.get.call(this.terminal)
			: descriptor && "value" in descriptor
				? descriptor.value
				: process.stdout.columns;
		return typeof value === "number" && value > 0 ? value : 80;
	}

	install(): boolean {
		if (!this.columnsDescriptor || typeof this.originalDoRender !== "function") return false;
		const self = this;
		Object.defineProperty(this.terminal, "columns", {
			configurable: true,
			enumerable: this.columnsDescriptor.descriptor.enumerable ?? true,
			get() {
				const raw = self.rawColumns();
				const state = self.getState();
				return state.enabled && raw >= state.width + MIN_MAIN_WIDTH + 1 ? raw - state.width - 1 : raw;
			},
		});
		this.tui.doRender = function () {
			self.originalDoRender!.call(self.tui);
			self.paint();
		};
		return true;
	}

	paint(): void {
		if (this.disposed || this.tui.stopped) return;
		const state = this.getState();
		const rawColumns = this.rawColumns();
		if (!state.enabled || rawColumns < state.width + MIN_MAIN_WIDTH + 1) return;
		const rows = this.terminal.rows ?? process.stdout.rows ?? 24;
		const separatorColumn = rawColumns - state.width;
		const content = renderSidebar(state, this.getTheme(), this.getStatuses(), state.width, rows);
		let buffer = "\x1b[?2026h\x1b7\x1b[?7l";
		for (let row = 1; row <= rows; row++) {
			buffer += `\x1b[${row};${separatorColumn}H`;
			buffer += this.getTheme().fg("borderMuted", "│");
			buffer += `\x1b[${row};${separatorColumn + 1}H\x1b[0m`;
			const line = truncateToWidth(content[row - 1] ?? "", state.width, "", true);
			buffer += padAnsi(line, state.width);
		}
		buffer += "\x1b[0m\x1b[?7h\x1b8\x1b[?2026l";
		this.originalWrite(buffer);
	}

	requestRender(): void {
		this.tui.requestRender();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.ownColumnsDescriptor) Object.defineProperty(this.terminal, "columns", this.ownColumnsDescriptor);
		else Reflect.deleteProperty(this.terminal, "columns");
		if (this.originalDoRender) this.tui.doRender = this.originalDoRender;
		this.originalWrite("\x1b[?25h");
	}
}

async function refreshOneRepo(
	pi: ExtensionAPI,
	displayRoot: string,
	owner: string,
	path: string,
	linkedWorktrees: readonly string[],
): Promise<GitRepo> {
	const label = path === displayRoot ? basename(displayRoot) : normalizeRelativePath(relative(displayRoot, path));
	const status = await pi.exec("git", ["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all"], {
		cwd: path,
		timeout: 3_000,
	});
	if (status.code !== 0) return { path, label, branch: "?", files: [], error: status.stderr.trim() || "git status failed" };
	const parsed = parseStatus(status.stdout);
	let files = path === owner ? parsed.files.filter((file) => !isInsideLinkedWorktree(file.path, linkedWorktrees)) : parsed.files;
	if (files.some((file) => !file.untracked)) {
		const numstat = await pi.exec("git", ["diff", "--numstat", "-z", "HEAD", "--"], { cwd: path, timeout: 3_000 });
		if (numstat.code === 0) files = applyNumstat(files, parseNumstat(numstat.stdout));
	}
	return { path, label, branch: parsed.branch || "detached", files };
}

function subagentSessionId(ctx: ExtensionContext | undefined): string | undefined {
	return ctx?.sessionManager.getSessionFile() ?? ctx?.sessionManager.getSessionId() ?? undefined;
}

export const __test__ = {
	applyNumstat,
	codexAccountId,
	computeSessionStats,
	formatQuotaReset,
	parseCodexWeeklyQuota,
	discoverRepositories,
	isInsideLinkedWorktree,
	observeWorkedWorktrees,
	parseNumstat,
	parseRunningAsyncSubagents,
	parseStatus,
	parseWorktreePaths,
	enumerateWorktreeTargets,
	renderSidebar,
	runningForegroundSubagents,
	initialForegroundSubagents,
	subagentRunsFromDetails,
	subagentRunsFromAsyncStatus,
	aggregateSubagents,
	formatSubagentDuration,
	cleanStatusText,
	replaySubagents,
	replayTodos,
	replayWorkedWorktrees,
	SidebarCompositor,
	truncatePath,
};

export default function sidebarExtension(pi: ExtensionAPI) {
	const state: SidebarState = {
		enabled: true,
		width: DEFAULT_WIDTH,
		thinkingLevel: "off",
		stats: { ...EMPTY_STATS },
		todos: [],
		gitRepos: [],
		linkedWorktrees: [],
		workedWorktrees: new Set(),
		subagentRuns: new Map(),
		asyncRunDirs: new Map(),
		foregroundSubagents: new Map(),
	};
	let compositor: SidebarCompositor | undefined;
	let footerData: FooterData | undefined;
	let tickTimer: ReturnType<typeof setInterval> | undefined;
	let todoHideTimer: ReturnType<typeof setTimeout> | undefined;
	let footerFallbackTimer: ReturnType<typeof setTimeout> | undefined;
	let refreshPromise: Promise<void> | undefined;
	let quotaPromise: Promise<void> | undefined;
	let subagentStatusPromise: Promise<void> | undefined;
	let asyncMetricsPromise: Promise<void> | undefined;
	let discoveryCache: { root: string; value: RepoDiscovery } | undefined;
	let worktreeSignatures = new Map<string, string>();
	let generation = 0;
	let subagentRequestSequence = 0;

	const statuses = () => footerData?.getExtensionStatuses() ?? new Map<string, string>();
	const paint = () => compositor?.paint();
	const updateSession = (ctx: ExtensionContext) => {
		state.ctx = ctx;
		state.title = pi.getSessionName() ?? fallbackTitle(ctx.sessionManager.getBranch());
		state.thinkingLevel = String(ctx.thinkingLevel ?? pi.getThinkingLevel?.() ?? "off");
		state.stats = computeSessionStats(ctx.sessionManager.getEntries());
		state.todos = replayTodos(ctx.sessionManager.getBranch());
		state.context = ctx.getContextUsage();
	};
	const hideTodoWidget = (ctx: ExtensionContext) => {
		try { ctx.ui.setWidget(TODO_WIDGET_KEY, undefined); } catch { /* stale replacement context */ }
	};
	const persistSubagentRun = (run: SubagentRun) => {
		pi.appendEntry(SUBAGENT_RUN_ENTRY, { key: run.key, agent: run.agent, durationMs: run.durationMs, cost: run.cost });
	};
	const rememberSubagentRun = (run: SubagentRun, persist = false) => {
		const previous = state.subagentRuns.get(run.key);
		state.subagentRuns.set(run.key, run);
		if (persist && (!previous || previous.agent !== run.agent || previous.durationMs !== run.durationMs || previous.cost !== run.cost)) persistSubagentRun(run);
	};
	const rememberAsyncDir = (runId: string, asyncDir: string, persist = false) => {
		if (!runId || !asyncDir || state.asyncRunDirs.get(runId) === asyncDir) return;
		state.asyncRunDirs.set(runId, asyncDir);
		if (persist) pi.appendEntry(SUBAGENT_ASYNC_ENTRY, { runId, asyncDir });
	};
	const refreshAsyncMetrics = (): Promise<void> => {
		if (asyncMetricsPromise) return asyncMetricsPromise;
		const runGeneration = generation;
		const sessionId = subagentSessionId(state.ctx);
		const promise = Promise.all([...state.asyncRunDirs].map(async ([runId, asyncDir]) => {
			try {
				return { runId, runs: subagentRunsFromAsyncStatus(JSON.parse(await readFile(join(asyncDir, "status.json"), "utf8")), runId, sessionId) };
			} catch {
				return { runId, runs: undefined };
			}
		})).then((statuses) => {
			if (runGeneration !== generation) return;
			for (const { runId, runs } of statuses) {
				if (!runs) continue;
				const seen = new Set(runs.map((run) => run.key));
				for (const run of runs) {
					const previous = state.subagentRuns.get(run.key);
					rememberSubagentRun(run, !previous || (!run.running && (previous.running || previous.durationMs !== run.durationMs || previous.cost !== run.cost)));
				}
				for (const [key, previous] of state.subagentRuns) {
					if (key.startsWith(`async:${runId}:`) && !seen.has(key) && previous.running) state.subagentRuns.set(key, { ...previous, running: false });
				}
			}
		});
		asyncMetricsPromise = promise;
		void promise.finally(() => {
			if (asyncMetricsPromise === promise) asyncMetricsPromise = undefined;
			if (runGeneration === generation) paint();
		});
		return promise;
	};
	const requestSubagentStatus = (): Promise<string | undefined> => new Promise((resolveStatus) => {
		const requestId = `pi-sidebar-${generation}-${++subagentRequestSequence}`;
		const replyEvent = `${SUBAGENT_RPC_REPLY_PREFIX}${requestId}`;
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let unsubscribe: (() => void) | void;
		const finish = (text?: string) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			if (typeof unsubscribe === "function") unsubscribe();
			resolveStatus(text);
		};
		unsubscribe = pi.events.on(replyEvent, (raw) => {
			const reply = raw as { success?: unknown; data?: { text?: unknown } };
			finish(reply.success === true && typeof reply.data?.text === "string" ? reply.data.text : undefined);
		});
		timer = setTimeout(() => finish(), SUBAGENT_RPC_TIMEOUT_MS);
		timer.unref?.();
		pi.events.emit(SUBAGENT_RPC_REQUEST_EVENT, {
			version: 1,
			requestId,
			method: "status",
			source: { extension: "pi-sidebar" },
		});
	});
	const refreshSubagents = (): Promise<void> => {
		if (subagentStatusPromise) return subagentStatusPromise;
		const runGeneration = generation;
		const promise = requestSubagentStatus().then((text) => {
			if (runGeneration !== generation || text === undefined) return;
			const running = parseRunningAsyncSubagents(text);
			if (running === undefined) return;
			const active = new Set(running.map((run) => run.key));
			for (const [key, previous] of state.subagentRuns) {
				if (key.startsWith("async:") && previous.running && !active.has(key)) state.subagentRuns.set(key, { ...previous, running: false });
			}
			for (const run of running) {
				const previous = state.subagentRuns.get(run.key);
				rememberSubagentRun(previous ? { ...previous, agent: run.agent, running: true } : run, !previous);
			}
		});
		subagentStatusPromise = promise;
		void promise.finally(() => {
			if (subagentStatusPromise === promise) subagentStatusPromise = undefined;
			if (runGeneration === generation) paint();
		});
		return promise;
	};

	const refreshExternal = (ctx = state.ctx, rediscover = false): Promise<void> => {
		if (!ctx) return Promise.resolve();
		if (refreshPromise) return refreshPromise;
		const runGeneration = generation;
		const promise = (async () => {
			const rootResult = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: ctx.cwd, timeout: 2_000 });
			if (runGeneration !== generation) return;
			if (rootResult.code !== 0) {
				state.rootRepo = undefined;
				state.gitRepos = [];
				state.linkedWorktrees = [];
				return;
			}
			const root = resolve(rootResult.stdout.trim());
			const discovery = !rediscover && discoveryCache?.root === root
				? discoveryCache.value
				: await discoverRepositories(root);
			if (runGeneration !== generation) return;
			discoveryCache = { root, value: discovery };
			const targets = await enumerateWorktreeTargets(
				[root, ...discovery.repos],
				discovery.linkedWorktrees,
				async (owner) => {
					const result = await pi.exec("git", ["worktree", "list", "--porcelain", "-z"], { cwd: owner, timeout: 2_000 });
					return result.code === 0 ? parseWorktreePaths(result.stdout) : [];
				},
			);
			if (runGeneration !== generation) return;
			const gitRepos = await Promise.all(targets.map(({ owner, path, linkedWorktrees }) =>
				refreshOneRepo(pi, root, owner, path, linkedWorktrees)));
			if (runGeneration !== generation) return;
			const worktreePaths = targets.map(({ path }) => path);
			const observation = observeWorkedWorktrees(gitRepos, worktreePaths, worktreeSignatures, state.workedWorktrees);
			worktreeSignatures = observation.signatures;
			for (const path of observation.newlyWorked) {
				state.workedWorktrees.add(path);
				pi.appendEntry(WORKED_WORKTREE_ENTRY, { path });
			}
			state.rootRepo = root;
			state.linkedWorktrees = targets.find(({ owner }) => owner === root)?.linkedWorktrees ?? [];
			state.gitRepos = gitRepos;
		})().catch((error) => {
			if (runGeneration !== generation) return;
			state.gitRepos = [{
				path: ctx.cwd,
				label: basename(ctx.cwd),
				branch: "?",
				files: [],
				error: error instanceof Error ? error.message : String(error),
			}];
		});
		refreshPromise = promise;
		void promise.finally(() => {
			if (refreshPromise === promise) refreshPromise = undefined;
			if (runGeneration === generation) paint();
		});
		return promise;
	};

	const refreshCodexQuota = (ctx = state.ctx, force = false): Promise<void> => {
		if (!ctx || ctx.model?.provider !== "openai-codex") {
			state.codexWeeklyQuota = undefined;
			paint();
			return Promise.resolve();
		}
		if (quotaPromise) {
			const current = quotaPromise;
			return force ? current.then(() => refreshCodexQuota(ctx)) : current;
		}
		const runGeneration = generation;
		paint();
		const promise = fetchCodexWeeklyQuota(ctx)
			.then((quota) => {
				if (runGeneration !== generation || state.ctx?.model?.provider !== "openai-codex") return;
				state.codexWeeklyQuota = quota ?? null;
			})
			.catch(() => {
				if (runGeneration !== generation || state.ctx?.model?.provider !== "openai-codex") return;
				state.codexWeeklyQuota = null;
			});
		quotaPromise = promise;
		void promise.finally(() => {
			if (quotaPromise === promise) quotaPromise = undefined;
			if (runGeneration === generation) paint();
		});
		return promise;
	};

	const disposeAsyncStarted = pi.events.on("subagent:async-started", (raw) => {
		const event = raw as { id?: unknown; asyncDir?: unknown; sessionId?: unknown };
		const sessionId = subagentSessionId(state.ctx);
		if (sessionId && event.sessionId !== sessionId) return;
		if (typeof event.id === "string" && typeof event.asyncDir === "string") rememberAsyncDir(event.id, event.asyncDir, true);
		void refreshAsyncMetrics();
		void refreshSubagents();
	});
	const disposeAsyncComplete = pi.events.on("subagent:async-complete", (raw) => {
		const event = raw as { runId?: unknown; id?: unknown; asyncDir?: unknown; sessionId?: unknown };
		const sessionId = subagentSessionId(state.ctx);
		if (sessionId && event.sessionId !== sessionId) return;
		const runId = typeof event.runId === "string" ? event.runId : typeof event.id === "string" ? event.id : undefined;
		if (runId && typeof event.asyncDir === "string") rememberAsyncDir(runId, event.asyncDir, true);
		if (runId) {
			for (const [key, run] of state.subagentRuns) {
				if (key.startsWith(`async:${runId}:`)) state.subagentRuns.set(key, { ...run, running: false });
			}
		}
		void refreshAsyncMetrics();
		void refreshSubagents();
	});

	pi.on("session_start", async (_event, ctx) => {
		generation++;
		refreshPromise = undefined;
		quotaPromise = undefined;
		subagentStatusPromise = undefined;
		asyncMetricsPromise = undefined;
		discoveryCache = undefined;
		worktreeSignatures.clear();
		state.workedWorktrees = replayWorkedWorktrees(ctx.sessionManager.getBranch());
		const replayedSubagents = replaySubagents(ctx.sessionManager.getBranch());
		state.subagentRuns = replayedSubagents.runs;
		state.asyncRunDirs = replayedSubagents.asyncRunDirs;
		if (footerFallbackTimer) clearTimeout(footerFallbackTimer);
		footerFallbackTimer = undefined;
		state.codexWeeklyQuota = undefined;
		state.foregroundSubagents.clear();
		updateSession(ctx);
		if (ctx.mode !== "tui") return;

		ctx.ui.setFooter((tui, _theme, data) => {
			footerData = data;
			compositor?.dispose();
			compositor = new SidebarCompositor(
				tui as never,
				() => state,
				() => state.ctx?.ui.theme ?? _theme,
				statuses,
			);
			const installed = compositor.install();
			if (!installed) {
				ctx.ui.notify("Sidebar unavailable: this Pi TUI no longer exposes terminal/doRender internals.", "warning");
				const fallbackGeneration = generation;
				footerFallbackTimer = setTimeout(() => {
					footerFallbackTimer = undefined;
					if (fallbackGeneration !== generation || footerData !== data) return;
					try { ctx.ui.setFooter(undefined); } catch { /* stale replacement context */ }
				}, 0);
			}
			return {
				render: () => [],
				invalidate: () => paint(),
				dispose: () => {
					compositor?.dispose();
					compositor = undefined;
					footerData = undefined;
				},
			};
		});

		if (todoHideTimer) clearTimeout(todoHideTimer);
		todoHideTimer = setTimeout(() => hideTodoWidget(ctx), 0);
		if (tickTimer) clearInterval(tickTimer);
		let ticks = 0;
		tickTimer = setInterval(() => {
			paint();
			void refreshAsyncMetrics();
			void refreshSubagents();
			if (++ticks % REFRESH_TICKS === 0) void refreshExternal();
		}, 1_000);
		tickTimer.unref?.();
		void refreshExternal(ctx);
		void refreshCodexQuota(ctx);
		void refreshAsyncMetrics();
		void refreshSubagents();
	});

	pi.on("session_info_changed", async (event, ctx) => {
		state.ctx = ctx;
		state.title = event.name ?? fallbackTitle(ctx.sessionManager.getBranch());
		paint();
	});

	const replaySession = async (_event: unknown, ctx: ExtensionContext) => {
		state.workedWorktrees = replayWorkedWorktrees(ctx.sessionManager.getBranch());
		const replayedSubagents = replaySubagents(ctx.sessionManager.getBranch());
		state.subagentRuns = replayedSubagents.runs;
		state.asyncRunDirs = replayedSubagents.asyncRunDirs;
		updateSession(ctx);
		void refreshExternal(ctx);
		void refreshAsyncMetrics();
		paint();
	};
	pi.on("session_tree", replaySession);
	pi.on("session_compact", replaySession);

	pi.on("model_select", async (_event, ctx) => {
		state.ctx = ctx;
		state.context = ctx.getContextUsage();
		void refreshCodexQuota(ctx, true);
		paint();
	});
	pi.on("thinking_level_select", async (event) => {
		state.thinkingLevel = event.level;
		paint();
	});
	pi.on("before_agent_start", async (_event, ctx) => {
		state.ctx = ctx;
		state.context = ctx.getContextUsage();
		hideTodoWidget(ctx);
		paint();
	});
	pi.on("message_end", async (event, ctx) => {
		state.ctx = ctx;
		if (event.message.role === "assistant") {
			state.stats = computeSessionStats(ctx.sessionManager.getEntries());
			state.context = ctx.getContextUsage();
		} else if (event.message.role === "toolResult" && event.message.toolName === "todo") {
			if (isTodoDetails(event.message.details)) state.todos = event.message.details.tasks.map((task) => ({ ...task }));
			hideTodoWidget(ctx);
		}
		paint();
	});
	pi.on("tool_result", async (event, ctx) => {
		state.ctx = ctx;
		if (event.toolName === "todo" && isTodoDetails(event.details)) state.todos = event.details.tasks.map((task) => ({ ...task }));
		if (event.toolName === "subagent") {
			const details = event.details as { asyncId?: unknown; runId?: unknown; asyncDir?: unknown } | undefined;
			const runId = typeof details?.asyncId === "string" ? details.asyncId : typeof details?.runId === "string" ? details.runId : undefined;
			if (runId && typeof details?.asyncDir === "string") rememberAsyncDir(runId, details.asyncDir, true);
			for (const run of subagentRunsFromDetails(event.details, `foreground:${event.toolCallId}`, false)) rememberSubagentRun(run, true);
			void refreshAsyncMetrics();
			void refreshSubagents();
		}
		if (GIT_REFRESH_TOOLS.has(event.toolName)) void refreshExternal(ctx);
		paint();
	});
	pi.on("tool_execution_start", async (event, ctx) => {
		state.ctx = ctx;
		if (event.toolName === "subagent") {
			const initial = initialForegroundSubagents(event.args).map((run, index) => ({ ...run, key: `foreground:${event.toolCallId}:${index}` }));
			state.foregroundSubagents.set(event.toolCallId, initial);
			for (const run of initial) rememberSubagentRun(run, true);
		}
		paint();
	});
	pi.on("tool_execution_update", async (event) => {
		if (event.toolName !== "subagent") return;
		const partial = event.partialResult as { details?: unknown } | undefined;
		const runs = subagentRunsFromDetails(partial?.details, `foreground:${event.toolCallId}`);
		if (runs.length) {
			state.foregroundSubagents.set(event.toolCallId, runs);
			for (const run of runs) rememberSubagentRun(run);
		}
		paint();
	});
	pi.on("tool_execution_end", async (event) => {
		for (const run of state.foregroundSubagents.get(event.toolCallId) ?? []) {
			const current = state.subagentRuns.get(run.key);
			if (current?.running) state.subagentRuns.set(run.key, { ...current, running: false });
		}
		state.foregroundSubagents.delete(event.toolCallId);
		if (event.toolName === "subagent") {
			void refreshAsyncMetrics();
			void refreshSubagents();
		}
		paint();
	});
	pi.on("agent_end", async (_event, ctx) => {
		state.ctx = ctx;
		state.stats = computeSessionStats(ctx.sessionManager.getEntries());
		state.context = ctx.getContextUsage();
		void refreshExternal(ctx);
		void refreshCodexQuota(ctx, true);
		paint();
	});

	pi.on("session_shutdown", async () => {
		generation++;
		if (typeof disposeAsyncStarted === "function") disposeAsyncStarted();
		if (typeof disposeAsyncComplete === "function") disposeAsyncComplete();
		if (tickTimer) clearInterval(tickTimer);
		if (todoHideTimer) clearTimeout(todoHideTimer);
		if (footerFallbackTimer) clearTimeout(footerFallbackTimer);
		tickTimer = undefined;
		quotaPromise = undefined;
		subagentStatusPromise = undefined;
		asyncMetricsPromise = undefined;
		todoHideTimer = undefined;
		footerFallbackTimer = undefined;
		compositor?.dispose();
		compositor = undefined;
		footerData = undefined;
		process.stdout.write("\x1b[?25h");
	});

	pi.registerCommand("sidebar", {
		description: "Control sidebar: /sidebar [on|off|toggle|width N|refresh|status]",
		handler: async (args, ctx) => {
			state.ctx = ctx;
			const [action = "toggle", value] = args.trim().toLowerCase().split(/\s+/);
			if (action === "on") state.enabled = true;
			else if (action === "off") state.enabled = false;
			else if (action === "toggle") state.enabled = !state.enabled;
			else if (action === "width") {
				const width = Number.parseInt(value ?? "", 10);
				if (!Number.isFinite(width) || width < 20 || width > 80) {
					ctx.ui.notify("Usage: /sidebar width <20-80>", "warning");
					return;
				}
				state.width = width;
			} else if (action === "refresh") {
				await Promise.all([refreshExternal(ctx, true), refreshCodexQuota(ctx, true), refreshAsyncMetrics(), refreshSubagents()]);
				ctx.ui.notify("Sidebar refreshed.", "info");
				return;
			} else if (action === "status") {
				ctx.ui.notify(`Sidebar ${state.enabled ? "on" : "off"} • width ${state.width} • ${state.gitRepos.length} Git repo(s)`, "info");
				return;
			} else {
				ctx.ui.notify("Usage: /sidebar [on|off|toggle|width N|refresh|status]", "warning");
				return;
			}
			compositor?.requestRender();
			ctx.ui.notify(`Sidebar ${state.enabled ? "enabled" : "hidden"} (width ${state.width}).`, "info");
		},
	});
}
