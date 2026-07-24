/**
 * pi-sidebar — fixed right sidebar for this Pi setup.
 *
 * Shows session/model/context/stats, MCP, rpiv-todo, extension statuses, and
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

const DEFAULT_WIDTH = 42;
const MIN_MAIN_WIDTH = 70;
const REFRESH_TICKS = 15;
const TODO_WIDGET_KEY = "rpiv-todos";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const WEEKLY_QUOTA_BAR_WIDTH = 10;
const PRUNED_DIRS = new Set([".cache", ".next", ".venv", "build", "dist", "node_modules", "target", "vendor", "venv"]);
const GIT_REFRESH_TOOLS = new Set(["edit", "write"]);

type Usage = {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
};

type SessionStats = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
	cacheHitPercent?: number;
};

type TodoTask = {
	id: number;
	subject: string;
	activeForm?: string;
	status: "pending" | "in_progress" | "completed" | "deleted";
};

type McpServer = {
	name: string;
	direct: number;
	total: number;
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

type FooterData = {
	getExtensionStatuses(): ReadonlyMap<string, string>;
};

type CodexWeeklyQuota = {
	remaining: number;
	resetAt?: number;
};

type SidebarState = {
	enabled: boolean;
	width: number;
	ctx?: ExtensionContext;
	title?: string;
	thinkingLevel: string;
	stats: SessionStats;
	todos: TodoTask[];
	mcpServers: McpServer[];
	gitRepos: GitRepo[];
	rootRepo?: string;
	linkedWorktrees: string[];
	context?: { tokens: number | null; contextWindow: number; percent: number | null };
	codexWeeklyQuota?: CodexWeeklyQuota | null;
	messageStartedAt?: number;
	lastResponseMs?: number;
	liveSpeed?: number;
	lastSpeed?: number;
	lastTool?: string;
	activeTools: Map<string, { name: string; startedAt: number }>;
	speedSamples: Array<{ at: number; tokens: number }>;
	sessionStartedAt: number;
};

const EMPTY_STATS: SessionStats = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	turns: 0,
};

function number(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function addUsage(stats: SessionStats, usage: Usage | undefined): void {
	if (!usage) return;
	stats.input += number(usage.input);
	stats.output += number(usage.output);
	stats.cacheRead += number(usage.cacheRead);
	stats.cacheWrite += number(usage.cacheWrite);
	stats.cost += number(usage.cost?.total);
}

function computeSessionStats(entries: readonly unknown[]): SessionStats {
	const stats: SessionStats = { ...EMPTY_STATS };
	let latestUsage: Usage | undefined;

	for (const raw of entries) {
		const entry = raw as {
			type?: string;
			usage?: Usage;
			message?: { role?: string; usage?: Usage };
		};
		if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			addUsage(stats, entry.usage);
			continue;
		}
		if (entry.type !== "message") continue;
		if (entry.message?.role === "assistant") {
			stats.turns++;
			latestUsage = entry.message.usage;
			addUsage(stats, entry.message.usage);
		} else if (entry.message?.role === "toolResult") {
			addUsage(stats, entry.message.usage);
		}
	}

	if (latestUsage) {
		const prompt = number(latestUsage.input) + number(latestUsage.cacheRead) + number(latestUsage.cacheWrite);
		if (prompt > 0) stats.cacheHitPercent = (number(latestUsage.cacheRead) / prompt) * 100;
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

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function serverMap(config: Record<string, unknown> | undefined): Record<string, Record<string, unknown>> {
	const merged: Record<string, Record<string, unknown>> = {};
	for (const raw of [config?.["mcp-servers"], config?.mcpServers]) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		for (const [name, definition] of Object.entries(raw as Record<string, Record<string, unknown>>)) {
			merged[name] = { ...(merged[name] ?? {}), ...definition };
		}
	}
	return merged;
}

async function loadMcpServers(cwd: string): Promise<McpServer[]> {
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	const configs = await Promise.all([
		readJson(join(homedir(), ".config", "mcp", "mcp.json")),
		readJson(join(agentDir, "mcp.json")),
		readJson(join(cwd, ".mcp.json")),
		readJson(join(cwd, ".pi", "mcp.json")),
	]);
	const cache = await readJson(join(agentDir, "mcp-cache.json"));
	const cachedServers = cache?.servers && typeof cache.servers === "object"
		? cache.servers as Record<string, { tools?: Array<{ name?: string }>; resources?: unknown[] }>
		: {};
	const merged: Record<string, Record<string, unknown>> = {};
	let globalDirect: boolean | undefined;
	for (const config of configs) {
		for (const [name, definition] of Object.entries(serverMap(config))) {
			merged[name] = { ...(merged[name] ?? {}), ...definition };
		}
		const settings = config?.settings as { directTools?: boolean } | undefined;
		if (typeof settings?.directTools === "boolean") globalDirect = settings.directTools;
	}

	return Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)).map(([name, definition]) => {
		const tools = cachedServers[name]?.tools ?? [];
		const excluded = new Set(Array.isArray(definition.excludeTools) ? definition.excludeTools.filter((item): item is string => typeof item === "string") : []);
		const visible = tools.filter((tool) => typeof tool.name === "string" && !excluded.has(tool.name));
		const filter = definition.directTools ?? globalDirect ?? false;
		const direct = filter === true
			? visible.length
			: Array.isArray(filter)
				? visible.filter((tool) => filter.includes(tool.name)).length
				: 0;
		return { name, direct, total: visible.length };
	});
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

function plainPad(text: string, width: number): string {
	return truncateToWidth(text, width, "").padEnd(width);
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
	return section(theme, "Conversation", items, width);
}

function renderStats(state: SidebarState, theme: Theme, width: number): string[] {
	const stats = state.stats;
	const tokenTotal = stats.input + stats.output + stats.cacheRead + stats.cacheWrite;
	const speed = state.liveSpeed ?? state.lastSpeed;
	const activeTool = [...state.activeTools.values()].at(-1);
	const left: Array<[string, string]> = [
		["time", formatDuration(Date.now() - state.sessionStartedAt)],
		["last", formatDuration(state.lastResponseMs)],
		["speed", speed === undefined ? "—" : `${speed.toFixed(0)} tok/s`],
		["turns", String(stats.turns)],
		["cost", `$${stats.cost.toFixed(3)}`],
	];
	const right: Array<[string, string]> = [
		["in", stats.input ? formatNumber(stats.input) : "—"],
		["out", stats.output ? formatNumber(stats.output) : "—"],
		["total", tokenTotal ? formatNumber(tokenTotal) : "—"],
		["cache", stats.cacheHitPercent === undefined ? "—" : `${stats.cacheHitPercent.toFixed(0)}%`],
		["tool", activeTool
			? `${activeTool.name} (${formatDuration(Date.now() - activeTool.startedAt)})${state.activeTools.size > 1 ? ` +${state.activeTools.size - 1}` : ""}`
			: state.lastTool ?? "—"],
	];
	const gap = 1;
	const column = Math.floor((width - gap) / 2);
	const rows = [theme.fg("dim", `${plainPad("Stats", column)} ${plainPad("Tokens", width - column - gap)}`)];
	for (let i = 0; i < left.length; i++) {
		const [ll, lv] = left[i]!;
		const [rl, rv] = right[i]!;
		const first = `${ll.padEnd(6)}${lv}`;
		const second = `${rl.padEnd(6)}${rv}`;
		rows.push(`${theme.fg("dim", plainPad(first, column))} ${theme.fg("dim", truncateToWidth(second, width - column - gap, "…"))}`);
	}
	return section(theme, "Stats", rows, width);
}

function mcpItems(state: SidebarState, theme: Theme, statuses: ReadonlyMap<string, string>): string[] {
	const items: string[] = [];
	const live = statuses.get("mcp");
	if (live) items.push(cleanStatusText(live));
	for (const server of state.mcpServers) {
		const glyph = server.total > 0 && server.direct === server.total
			? theme.fg("success", "●")
			: server.direct > 0
				? theme.fg("warning", "◐")
				: theme.fg("dim", "○");
		items.push(`${glyph} ${theme.fg("accent", sanitizePlainText(server.name))} ${theme.fg("dim", `${server.direct}/${server.total}`)}`);
	}
	return items;
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
		if (repo.path !== state.rootRepo && repo.files.length === 0 && !repo.error) continue;
		if (items.length > 0) items.push("");
		const safeBranch = sanitizePlainText(repo.branch);
		const safeLabel = sanitizePlainText(repo.label);
		const branch = ` • ${safeBranch}`;
		const label = truncatePath(safeLabel, Math.max(1, width - visibleWidth(branch)));
		items.push(`${theme.fg("accent", label)}${theme.fg("dim", branch)}`);
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
	const lines = [...renderCore(state, theme, width), ...renderStats(state, theme, width)];
	if (lines.length >= height) return lines.slice(0, height);

	const todos = todoItems(state, theme);
	const extensions = extensionItems(theme, statuses);
	const git = gitItems(state, theme, width);
	const optionalSections = (state.mcpServers.length || statuses.has("mcp") ? 1 : 0) + 1 + (extensions.length ? 1 : 0);
	fitSection(lines, theme, "MCP Servers", mcpItems(state, theme, statuses), width, height, 5 + (optionalSections - 1) * 4);
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

async function refreshOneRepo(pi: ExtensionAPI, root: string, path: string, linkedWorktrees: readonly string[]): Promise<GitRepo> {
	const label = path === root ? basename(root) : normalizeRelativePath(relative(root, path));
	const status = await pi.exec("git", ["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all"], {
		cwd: path,
		timeout: 3_000,
	});
	if (status.code !== 0) return { path, label, branch: "?", files: [], error: status.stderr.trim() || "git status failed" };
	const parsed = parseStatus(status.stdout);
	let files = path === root ? parsed.files.filter((file) => !isInsideLinkedWorktree(file.path, linkedWorktrees)) : parsed.files;
	if (files.some((file) => !file.untracked)) {
		const numstat = await pi.exec("git", ["diff", "--numstat", "-z", "HEAD", "--"], { cwd: path, timeout: 3_000 });
		if (numstat.code === 0) files = applyNumstat(files, parseNumstat(numstat.stdout));
	}
	return { path, label, branch: parsed.branch || "detached", files };
}

function sessionStartTime(ctx: ExtensionContext): number {
	const header = ctx.sessionManager.getHeader?.() as { timestamp?: string } | undefined;
	const timestamp = header?.timestamp ? Date.parse(header.timestamp) : Number.NaN;
	return Number.isFinite(timestamp) ? timestamp : Date.now();
}

export const __test__ = {
	applyNumstat,
	codexAccountId,
	computeSessionStats,
	formatQuotaReset,
	parseCodexWeeklyQuota,
	discoverRepositories,
	isInsideLinkedWorktree,
	parseNumstat,
	parseStatus,
	parseWorktreePaths,
	renderSidebar,
	serverMap,
	cleanStatusText,
	replayTodos,
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
		mcpServers: [],
		gitRepos: [],
		linkedWorktrees: [],
		activeTools: new Map(),
		speedSamples: [],
		sessionStartedAt: Date.now(),
	};
	let compositor: SidebarCompositor | undefined;
	let footerData: FooterData | undefined;
	let tickTimer: ReturnType<typeof setInterval> | undefined;
	let todoHideTimer: ReturnType<typeof setTimeout> | undefined;
	let footerFallbackTimer: ReturnType<typeof setTimeout> | undefined;
	let refreshPromise: Promise<void> | undefined;
	let quotaPromise: Promise<void> | undefined;
	let discoveryCache: { root: string; value: RepoDiscovery } | undefined;
	let generation = 0;

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

	const refreshExternal = (ctx = state.ctx, rediscover = false): Promise<void> => {
		if (!ctx) return Promise.resolve();
		if (refreshPromise) return refreshPromise;
		const runGeneration = generation;
		const promise = (async () => {
			const mcpServers = await loadMcpServers(ctx.cwd);
			if (runGeneration !== generation) return;
			state.mcpServers = mcpServers;
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
			const worktreeResult = await pi.exec("git", ["worktree", "list", "--porcelain", "-z"], { cwd: root, timeout: 2_000 });
			if (runGeneration !== generation) return;
			const worktrees = worktreeResult.code === 0 ? parseWorktreePaths(worktreeResult.stdout) : [];
			const linkedWorktrees = [...new Set([
				...discovery.linkedWorktrees,
				...worktrees
					.filter((path) => path !== root && path.startsWith(`${root}${sep}`))
					.map((path) => normalizeRelativePath(relative(root, path))),
			])];
			const paths = [...new Set([root, ...worktrees, ...discovery.repos])];
			const gitRepos = await Promise.all(paths.map((path) => refreshOneRepo(pi, root, path, linkedWorktrees)));
			if (runGeneration !== generation) return;
			state.rootRepo = root;
			state.linkedWorktrees = linkedWorktrees;
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

	pi.on("session_start", async (_event, ctx) => {
		generation++;
		refreshPromise = undefined;
		quotaPromise = undefined;
		discoveryCache = undefined;
		if (footerFallbackTimer) clearTimeout(footerFallbackTimer);
		footerFallbackTimer = undefined;
		state.sessionStartedAt = sessionStartTime(ctx);
		state.messageStartedAt = undefined;
		state.lastResponseMs = undefined;
		state.liveSpeed = undefined;
		state.lastSpeed = undefined;
		state.lastTool = undefined;
		state.codexWeeklyQuota = undefined;
		state.activeTools.clear();
		state.speedSamples = [];
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
			if (++ticks % REFRESH_TICKS === 0) void refreshExternal();
		}, 1_000);
		tickTimer.unref?.();
		void refreshExternal(ctx);
		void refreshCodexQuota(ctx);
	});

	pi.on("session_info_changed", async (event, ctx) => {
		state.ctx = ctx;
		state.title = event.name ?? fallbackTitle(ctx.sessionManager.getBranch());
		paint();
	});

	const replaySession = async (_event: unknown, ctx: ExtensionContext) => {
		updateSession(ctx);
		void refreshExternal(ctx);
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
	pi.on("message_start", async (event) => {
		if (event.message.role !== "assistant") return;
		state.messageStartedAt = Date.now();
		state.liveSpeed = undefined;
		state.speedSamples = [];
	});
	pi.on("message_update", async (event) => {
		if (event.message.role !== "assistant") return;
		const now = Date.now();
		const output = number(event.message.usage?.output) || Math.round(textContent(event.message.content).length / 4);
		if (output <= 0) return;
		state.speedSamples.push({ at: now, tokens: output });
		while (state.speedSamples.length > 1 && now - state.speedSamples[0]!.at > 2_000) state.speedSamples.shift();
		const first = state.speedSamples[0];
		if (first && now > first.at && output > first.tokens) state.liveSpeed = (output - first.tokens) / ((now - first.at) / 1_000);
		paint();
	});
	pi.on("message_end", async (event, ctx) => {
		state.ctx = ctx;
		if (event.message.role === "assistant") {
			const elapsed = state.messageStartedAt === undefined ? undefined : Date.now() - state.messageStartedAt;
			state.lastResponseMs = elapsed;
			const output = number(event.message.usage?.output);
			state.lastSpeed = elapsed && elapsed > 0 && output > 0 ? output / (elapsed / 1_000) : state.lastSpeed;
			state.messageStartedAt = undefined;
			state.liveSpeed = undefined;
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
		if (GIT_REFRESH_TOOLS.has(event.toolName)) void refreshExternal(ctx);
		paint();
	});
	pi.on("tool_execution_start", async (event, ctx) => {
		state.ctx = ctx;
		state.activeTools.set(event.toolCallId, { name: event.toolName, startedAt: Date.now() });
		state.lastTool = event.toolName;
		paint();
	});
	pi.on("tool_execution_end", async (event) => {
		state.activeTools.delete(event.toolCallId);
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
		if (tickTimer) clearInterval(tickTimer);
		if (todoHideTimer) clearTimeout(todoHideTimer);
		if (footerFallbackTimer) clearTimeout(footerFallbackTimer);
		tickTimer = undefined;
		quotaPromise = undefined;
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
				await Promise.all([refreshExternal(ctx, true), refreshCodexQuota(ctx, true)]);
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
