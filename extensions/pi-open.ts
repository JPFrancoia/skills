/**
 * pi-open — /open lists open MRs/PRs for the repositories in $REPOS.
 *
 * REPOS is a comma-separated list of repository URLs, for example:
 *   REPOS=https://gitlab.com/acme/group/widgets,https://github.com/acme/gadgets
 * gitlab.* hosts use `glab`, github.* hosts use `gh`. No agent runs: this is a
 * plain fetch rendered as markdown in the transcript only.
 *
 * Install by symlinking this file into ~/.pi/agent/extensions/ and running /reload.
 */

import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";

const ENTRY = "open-requests";
const TIMEOUT_MS = 60_000;

type Request = { title: string; url: string; createdAt: string };

type Repo = { host: string; path: string; forge: "gitlab" | "github" };

function parseRepos(value: string | undefined): { repos: Repo[]; errors: string[] } {
	const repos: Repo[] = [];
	const errors: string[] = [];
	for (const raw of (value ?? "").split(",")) {
		const entry = raw.trim().replace(/\/+$/, "");
		if (!entry) continue;
		let url: URL;
		try {
			url = new URL(entry.includes("://") ? entry : `https://${entry}`);
		} catch {
			errors.push(`Not a URL: ${entry}`);
			continue;
		}
		const path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
		const forge = url.hostname.startsWith("gitlab") ? "gitlab" : url.hostname.startsWith("github") ? "github" : undefined;
		if (!forge) errors.push(`Unsupported host (expected gitlab* or github*): ${entry}`);
		else if (!path.includes("/")) errors.push(`Not a repository path: ${entry}`);
		else repos.push({ host: url.hostname, path, forge });
	}
	return { repos, errors };
}

function command(repo: Repo): { command: string; args: string[] } {
	if (repo.forge === "gitlab") {
		return {
			command: "glab",
			args: ["api", "--hostname", repo.host, `projects/${encodeURIComponent(repo.path)}/merge_requests?state=opened&per_page=100`],
		};
	}
	return {
		command: "gh",
		args: ["pr", "list", "--repo", `${repo.host}/${repo.path}`, "--state", "open", "--limit", "100", "--json", "title,url,createdAt"],
	};
}

function requests(repo: Repo, stdout: string): Request[] {
	const items = JSON.parse(stdout || "[]") as Array<Record<string, string>>;
	return items.map((item) => ({
		title: item.title,
		url: repo.forge === "gitlab" ? item.web_url : item.url,
		createdAt: repo.forge === "gitlab" ? item.created_at : item.createdAt,
	}));
}

function age(createdAt: string, now: number): string {
	const hours = Math.floor((now - Date.parse(createdAt)) / 3_600_000);
	if (!Number.isFinite(hours)) return createdAt;
	if (hours < 1) return "just now";
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

function markdown(groups: Array<{ repo: Repo; requests: Request[] }>, errors: string[], now: number): string {
	const blocks: string[] = [];
	for (const group of groups) {
		const lines = [`### ${group.repo.path}`];
		if (group.requests.length === 0) lines.push("_No open requests._");
		for (const request of [...group.requests].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))) {
			lines.push(`- [${request.title}](${request.url}) — ${age(request.createdAt, now)}`);
		}
		blocks.push(lines.join("\n"));
	}
	if (errors.length > 0) blocks.push(errors.map((error) => `- ⚠️ ${error}`).join("\n"));
	return blocks.join("\n\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerEntryRenderer<{ markdown: string }>(ENTRY, (entry) => new Markdown(entry.data?.markdown ?? "", 1, 0, getMarkdownTheme()));

	pi.registerCommand("open", {
		description: "List open MRs/PRs for the repositories in $REPOS",
		handler: async (_args, ctx) => {
			const { repos, errors } = parseRepos(process.env.REPOS);
			if (repos.length === 0 && errors.length === 0) {
				ctx.ui.notify("REPOS is not set (comma-separated list of GitLab/GitHub repository URLs).", "error");
				return;
			}

			const results = await Promise.all(
				repos.map(async (repo) => {
					const { command: bin, args } = command(repo);
					return { repo, bin, result: await pi.exec(bin, args, { timeout: TIMEOUT_MS }) };
				}),
			);

			const groups: Array<{ repo: Repo; requests: Request[] }> = [];
			for (const { repo, bin, result } of results) {
				if (result.code !== 0) {
					errors.push(`${repo.path}: ${result.stderr.trim() || `${bin} exited with ${result.code}`}`);
					continue;
				}
				try {
					groups.push({ repo, requests: requests(repo, result.stdout) });
				} catch (error) {
					errors.push(`${repo.path}: could not parse ${bin} output (${(error as Error).message})`);
				}
			}

			pi.appendEntry(ENTRY, { markdown: markdown(groups, errors, Date.now()) });
		},
	});
}

export const __test__ = { age, command, markdown, parseRepos, requests };
