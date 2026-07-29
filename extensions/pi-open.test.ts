import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

// The repository intentionally has no node_modules. Make Pi's own extension
// peers visible so the documented direct jiti command is self-contained.
const require = createRequire(import.meta.url);
const Module = require("node:module") as { _initPaths(): void };
process.env.NODE_PATH = [
	join(homedir(), ".pi", "agent", "npm", "node_modules"),
	join(homedir(), ".npm-global", "lib", "node_modules", "@earendil-works", "pi-coding-agent", "node_modules"),
	join(homedir(), ".npm-global", "lib", "node_modules"),
	"/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules",
	"/opt/homebrew/lib/node_modules",
	process.env.NODE_PATH,
].filter(Boolean).join(delimiter);
Module._initPaths();

const { __test__ } = await import("./pi-open.ts");
const { age, command, markdown, parseRepos, requests } = __test__;

const parsed = parseRepos("https://gitlab.com/acme/group/sub/widgets/, https://github.com/acme/gadgets.git, ftp://x.io/y, https://gitlab.com/group");
assert.deepEqual(parsed.repos, [
	{ host: "gitlab.com", path: "acme/group/sub/widgets", forge: "gitlab" },
	{ host: "github.com", path: "acme/gadgets", forge: "github" },
]);
assert.equal(parsed.errors.length, 2);
assert.deepEqual(parseRepos(undefined), { repos: [], errors: [] });

assert.deepEqual(command(parsed.repos[0]), {
	command: "glab",
	args: ["api", "--hostname", "gitlab.com", "projects/acme%2Fgroup%2Fsub%2Fwidgets/merge_requests?state=opened&per_page=100"],
});
assert.deepEqual(command(parsed.repos[1]), {
	command: "gh",
	args: ["pr", "list", "--repo", "github.com/acme/gadgets", "--state", "open", "--limit", "100", "--json", "title,url,createdAt"],
});

assert.deepEqual(requests(parsed.repos[0], JSON.stringify([{ title: "Fix", web_url: "u", created_at: "c" }])), [
	{ title: "Fix", url: "u", createdAt: "c" },
]);
assert.deepEqual(requests(parsed.repos[1], JSON.stringify([{ title: "T", url: "u", createdAt: "c" }])), [
	{ title: "T", url: "u", createdAt: "c" },
]);

const now = Date.parse("2026-01-10T00:00:00Z");
assert.equal(age("2026-01-09T23:30:00Z", now), "just now");
assert.equal(age("2026-01-09T12:00:00Z", now), "12h ago");
assert.equal(age("2026-01-09T00:00:00Z", now), "1d ago");

const rendered = markdown(
	[
		{
			repo: parsed.repos[0],
			requests: [
				{ title: "Old", url: "u1", createdAt: "2026-01-01T00:00:00Z" },
				{ title: "New", url: "u2", createdAt: "2026-01-09T12:00:00Z" },
			],
		},
		{ repo: parsed.repos[1], requests: [] },
	],
	["boom"],
	now,
);
assert.equal(
	rendered,
	["### acme/group/sub/widgets", "- [New](u2) — 12h ago", "- [Old](u1) — 9d ago", "", "### acme/gadgets", "_No open requests._", "", "- ⚠️ boom"].join("\n"),
);

console.log("ok");
