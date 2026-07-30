/**
 * pi-message-timestamps — show a local-time separator before each user and assistant message.
 *
 * Install by symlinking this file into ~/.pi/agent/extensions/ and running /reload.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const ENTRY = "message-timestamp";

type TimestampData = { timestamp: number };

function formatTime(timestamp: number): string {
	const time = new Date(timestamp);
	return [time.getHours(), time.getMinutes(), time.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":");
}

export default function (pi: ExtensionAPI) {
	pi.registerEntryRenderer<TimestampData>(ENTRY, (entry, _options, theme) =>
		new Text(theme.fg("dim", `── ${formatTime(entry.data?.timestamp ?? Date.now())} ──`), 0, 0),
	);

	pi.on("message_start", (event) => {
		if (event.message.role === "user" || event.message.role === "assistant") {
			pi.appendEntry<TimestampData>(ENTRY, { timestamp: event.message.timestamp });
		}
	});
}

export const __test__ = { formatTime };
