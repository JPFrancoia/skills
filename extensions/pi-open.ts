/**
 * pi-open — /open lists open MRs/PRs for the repositories in $REPOS.
 *
 * REPOS is a comma-separated list of repository URLs, for example:
 *   REPOS=https://gitlab.com/acme/group/widgets,https://github.com/acme/gadgets
 * gitlab.* hosts use `glab`, github.* hosts use `gh`. This is a plain fetch
 * added to the conversation context without triggering an agent turn.
 *
 * Install by symlinking this file into ~/.pi/agent/extensions/ and running /reload.
 */

import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";

const ENTRY = "open-requests";
const TIMEOUT_MS = 60_000;

type Request = { title: string; url: string; createdAt: string; author: string; approved: boolean };

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
		// GraphQL, not REST: the REST merge_requests list omits approval state,
		// which would cost one extra /approvals call per merge request.
		return {
			command: "glab",
			args: [
				"api",
				"--hostname",
				repo.host,
				"graphql",
				"-f",
				`query={project(fullPath:"${repo.path}"){mergeRequests(state:opened,first:100){nodes{title webUrl createdAt approved author{username}}}}}`,
			],
		};
	}
	return {
		command: "gh",
		args: ["pr", "list", "--repo", `${repo.host}/${repo.path}`, "--state", "open", "--limit", "100", "--json", "title,url,createdAt,author,reviewDecision"],
	};
}

function requests(repo: Repo, stdout: string): Request[] {
	const parsed = JSON.parse(stdout || "[]");
	const items = (repo.forge === "gitlab" ? parsed?.data?.project?.mergeRequests?.nodes : parsed) as Array<Record<string, any>> | undefined;
	return (items ?? []).map((item) => ({
		title: item.title,
		url: repo.forge === "gitlab" ? item.webUrl : item.url,
		createdAt: item.createdAt,
		author: (repo.forge === "gitlab" ? item.author?.username : item.author?.login) ?? "unknown",
		approved: repo.forge === "gitlab" ? item.approved === true : item.reviewDecision === "APPROVED",
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
	const blocks: string[] = ["---"];
	for (const group of groups.filter(({ requests }) => requests.length > 0)) {
		const lines = [`### ${group.repo.path}`];
		for (const request of [...group.requests].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))) {
			lines.push(`- [${request.title}](${request.url}) — ${age(request.createdAt, now)}${request.approved ? " (approved)" : ""} [${request.author}]`);
		}
		blocks.push(lines.join("\n"));
	}
	if (errors.length > 0) blocks.push(errors.map((error) => `- ⚠️ ${error}`).join("\n"));
	return blocks.join("\n\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerMessageRenderer(ENTRY, (message) => new Markdown(typeof message.content === "string" ? message.content : "", 1, 0, getMarkdownTheme()));

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

			pi.sendMessage({ customType: ENTRY, content: markdown(groups, errors, Date.now()), display: true }, { triggerTurn: false });
		},
	});
}

export const __test__ = { age, command, markdown, parseRepos, requests };
