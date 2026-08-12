/**
 * pi-compaction-count — show the active branch's compaction count in Pi's footer status line.
 *
 * Install by symlinking this file into ~/.pi/agent/extensions/ and running /reload.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS = "compaction-count";

function countCompactions(entries: readonly { type?: string }[]): number {
	return entries.filter((entry) => entry.type === "compaction").length;
}

export default function (pi: ExtensionAPI) {
	const update = (ctx: ExtensionContext) => {
		const count = countCompactions(ctx.sessionManager.getBranch());
		ctx.ui.setStatus(STATUS, ctx.ui.theme.fg("dim", `🧹 ${count}`));
	};

	pi.on("session_start", (_event, ctx) => update(ctx));
	pi.on("session_compact", (_event, ctx) => update(ctx));
	pi.on("session_tree", (_event, ctx) => update(ctx));
}

export const __test__ = { countCompactions };
