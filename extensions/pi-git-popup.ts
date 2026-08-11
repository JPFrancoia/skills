/**
 * pi-git-popup — /git shows the Git status of the root repository, every
 * nested repository, and every worktree in one scrollable overlay.
 *
 * The content matches the Git section of pi-sidebar, except that clean
 * worktrees are listed only for the root repository. This extension keeps no
 * session history, so it cannot know which worktrees this session touched.
 *
 * Install by symlinking this file into ~/.pi/agent/extensions/ and running /reload.
 */

import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const PRUNED_DIRS = new Set([".cache", ".next", ".venv", "build", "dist", "node_modules", "target", "vendor", "venv"]);
const OVERLAY_WIDTH = 60;
const MAX_VISIBLE_LINES = 24;
const CHROME_LINES = 6;

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

type WorktreeTarget = {
	owner: string;
	path: string;
	linkedWorktrees: string[];
};

function sanitizePlainText(text: string): string {
	return text
		.replace(/(?:\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x9d[\s\S]*?(?:\x07|\x1b\\|\x9c))/g, "")
		.replace(/(?:\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_])/g, "")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function normalizeRelativePath(path: string): string {
	return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function truncatePath(path: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(path) <= width) return path;
	if (width === 1) return "…";
	const name = path.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? path;
	if (visibleWidth(name) <= width) return name;
	return `…${name.slice(-(width - 1))}`;
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

async function discoverRepositories(root: string): Promise<{ repos: string[]; linkedWorktrees: string[] }> {
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

async function readRepo(
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

async function collectRepos(pi: ExtensionAPI, cwd: string): Promise<{ rootRepo?: string; repos: GitRepo[] }> {
	const rootResult = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 2_000 });
	if (rootResult.code !== 0) return { repos: [] };
	const root = resolve(rootResult.stdout.trim());
	const discovery = await discoverRepositories(root);
	const targets = await enumerateWorktreeTargets(
		[root, ...discovery.repos],
		discovery.linkedWorktrees,
		async (owner) => {
			const result = await pi.exec("git", ["worktree", "list", "--porcelain", "-z"], { cwd: owner, timeout: 2_000 });
			return result.code === 0 ? parseWorktreePaths(result.stdout) : [];
		},
	);
	const repos = await Promise.all(targets.map(({ owner, path, linkedWorktrees }) =>
		readRepo(pi, root, owner, path, linkedWorktrees)));
	return { rootRepo: root, repos };
}

function gitItems(rootRepo: string | undefined, repos: readonly GitRepo[], theme: Theme, width: number): string[] {
	if (!rootRepo) return [theme.fg("dim", "(not a git repository)")];
	const items: string[] = [];
	for (const repo of repos) {
		if (repo.files.length === 0 && !repo.error && repo.path !== rootRepo) continue;
		if (items.length > 0) items.push("");
		items.push(theme.fg("accent", truncatePath(sanitizePlainText(repo.label), width)));
		items.push(theme.fg("dim", truncateToWidth(`• ${sanitizePlainText(repo.branch)}`, width, "…")));
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
			const path = truncatePath(sanitizePlainText(file.path), Math.max(1, width - 4 - suffixWidth));
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

class GitPopup {
	private offset = 0;

	constructor(
		private readonly rootRepo: string | undefined,
		private readonly repos: readonly GitRepo[],
		private readonly theme: Theme,
		private readonly requestRender: () => void,
		private readonly done: () => void,
		private readonly rows: () => number = () => process.stdout.rows ?? 24,
	) {}

	/** Lines of Git content that fit above the border and help rows. */
	private pageSize(): number {
		return Math.max(3, Math.min(MAX_VISIBLE_LINES, this.rows() - CHROME_LINES));
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "return") || matchesKey(data, "ctrl+c")) {
			this.done();
			return;
		}
		const page = this.pageSize();
		if (matchesKey(data, "up")) this.offset--;
		else if (matchesKey(data, "down")) this.offset++;
		else if (matchesKey(data, "pageup")) this.offset -= page;
		else if (matchesKey(data, "pagedown")) this.offset += page;
		else if (matchesKey(data, "home")) this.offset = 0;
		else if (matchesKey(data, "end")) this.offset = Number.MAX_SAFE_INTEGER;
		else return;
		this.requestRender();
	}

	render(width: number): string[] {
		const theme = this.theme;
		const inner = Math.max(1, width - 4);
		const page = this.pageSize();
		const items = gitItems(this.rootRepo, this.repos, theme, inner);
		this.offset = Math.max(0, Math.min(this.offset, Math.max(0, items.length - page)));
		const visible = items.slice(this.offset, this.offset + page);
		const hidden = items.length - this.offset - visible.length;
		const border = (text: string) => theme.fg("borderMuted", text);
		const row = (text: string) => `${border("│")} ${truncateToWidth(text, inner, "…", true)} ${border("│")}`;
		return [
			border(`╭${"─".repeat(inner + 2)}╮`),
			row(theme.fg("text", theme.bold("Git"))),
			row(theme.fg("borderMuted", "─".repeat(inner))),
			...visible.map(row),
			row(theme.fg("dim", hidden > 0 || this.offset > 0 ? `↑↓ scroll • ${hidden} more below • esc close` : "esc close")),
			border(`╰${"─".repeat(inner + 2)}╯`),
		];
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("git", {
		description: "Show Git status of the repository, nested repositories, and worktrees",
		handler: async (_args, ctx) => {
			const { rootRepo, repos } = await collectRepos(pi, ctx.cwd);
			await ctx.ui.custom<null>(
				(tui, theme, _keybindings, done) => new GitPopup(rootRepo, repos, theme, () => tui.requestRender(), () => done(null)),
				{ overlay: true, overlayOptions: { anchor: "center", width: OVERLAY_WIDTH, maxHeight: MAX_VISIBLE_LINES + CHROME_LINES } },
			);
		},
	});
}

export const __test__ = {
	applyNumstat,
	discoverRepositories,
	enumerateWorktreeTargets,
	gitItems,
	isInsideLinkedWorktree,
	parseNumstat,
	parseStatus,
	parseWorktreePaths,
	truncatePath,
	GitPopup,
};
