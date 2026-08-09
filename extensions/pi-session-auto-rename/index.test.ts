import assert from "node:assert/strict";
import {
	findBeansIdentifier,
	isBeansIdentifier,
	isValidGeneratedSessionName,
	needsAutoName,
	parseBeansTitle,
	redactBeansIdentifiers,
} from "./policy.ts";

assert.equal(isBeansIdentifier("acme_ops-1vkb"), true);
assert.equal(isBeansIdentifier("project-1234"), true);
assert.equal(isBeansIdentifier("Acme Ops 1vkb"), false);
assert.equal(isBeansIdentifier("relay-service"), false);
assert.equal(findBeansIdentifier("let's work on acme_ops-a1b2"), "acme_ops-a1b2");
assert.equal(findBeansIdentifier("let's work on relay-service"), null);
assert.equal(redactBeansIdentifiers("Fix acme_ops-1vkb"), "Fix work item");
assert.equal(redactBeansIdentifiers("Implement acme_ops-1vkb before project-1234."), "Implement work item before work item.");
assert.equal(isValidGeneratedSessionName("Acme Ops 1vkb"), true);
assert.equal(isValidGeneratedSessionName("acme_ops-1vkb"), false);
assert.equal(isValidGeneratedSessionName(""), false);
assert.equal(needsAutoName(undefined), true);
assert.equal(needsAutoName("acme_ops-1vkb"), true);
assert.equal(needsAutoName("Relay Private Access"), false);
assert.equal(parseBeansTitle('{"title":"Repair production Terraform state"}'), "Repair production Terraform state");
assert.equal(parseBeansTitle('{"status":"in-progress"}'), null);
assert.equal(parseBeansTitle("not json"), null);

console.log("ok");
