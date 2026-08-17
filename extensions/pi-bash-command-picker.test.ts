import assert from "node:assert/strict";
import { __test__ } from "./pi-bash-command-picker.ts";

const blocks = __test__.extractCodeBlocks([
	"```bash",
	"echo one",
	"echo two",
	"```",
	"",
	"```shell",
	"printf 'one'",
	"printf 'two'",
	"```",
	"",
	"```typescript",
	"const value = 1;",
	"console.log(value);",
	"```",
	"",
	"```sh",
	"echo only-this-block",
	"echo has-no-commands",
	"```",
	"",
	"```",
	"plain text block",
	"```",
].join("\n"));

assert.deepEqual(blocks.map((block) => block.language), ["bash", "shell", "typescript", "sh", ""]);

const bashChoices = __test__.choicesForBlock(blocks[0]!, "now");
assert.deepEqual(bashChoices.map((item) => [item.kind, item.command, item.commandCount]), [
	["block", "echo one\necho two\n", 2],
	["command", "echo two", 1],
	["command", "echo one", 1],
]);

const shellChoices = __test__.choicesForBlock(blocks[1]!, "now");
assert.equal(shellChoices.length, 3);

for (const block of blocks.slice(2)) {
	const choices = __test__.choicesForBlock(block, "now");
	assert.equal(choices.length, 1, `${block.language || "untyped"} block must not split into commands`);
	assert.equal(choices[0]?.kind, "block");
	assert.equal(choices[0]?.command, `${block.code}\n`);
	assert.equal(choices[0]?.commandCount, undefined);
}
