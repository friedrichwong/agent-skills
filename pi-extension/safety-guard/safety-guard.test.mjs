import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
globalThis.require = require;
const safetyGuard = require("./index.ts").default;

async function inspect(command, cwd = "/Users/william") {
	let handler;
	safetyGuard({
		on(event, callback) {
			if (event === "tool_call") handler = callback;
		},
	});
	assert.ok(handler, "safety guard must register a tool_call handler");

	let confirmations = 0;
	let dialog = "";
	const originalWrite = process.stdout.write;
	process.stdout.write = () => true;
	try {
		await handler(
			{ toolName: "bash", input: { command } },
			{
				cwd,
				ui: {
					confirm: async (_title, body) => {
						confirmations += 1;
						dialog = body;
						return true;
					},
				},
			},
		);
	} finally {
		process.stdout.write = originalWrite;
	}

	return { confirmations, dialog };
}

for (const command of [
	"rm -rf /tmp/*",
	"rm -rf /private/tmp/*",
	"set -euo pipefail\nnode --check foo.js\nrm -f /tmp/quark-browse-probe.out",
	"set -euo pipefail\nnode --check foo.js\nrm -f /private/tmp/quark-browse-probe.out",
	"test -d /tmp/safety-guard-test && rm -r /tmp/safety-guard-test",
	'archive="$(mktemp /tmp/safety-guard.XXXXXX.zip)"; rm -f "$archive"',
	'archive="$(mktemp /tmp/safety-guard.XXXXXX.zip)"; trap \'rm -f "$archive"\' EXIT',
]) {
	test(`allows proven temporary cleanup: ${command}`, async () => {
		assert.equal((await inspect(command)).confirmations, 0);
	});
}

for (const command of [
	'target=/etc; rm -rf "$target"',
	"rm -rf /tmp/../etc/x",
	"set -euo pipefail\nrm -rf /tmp/../etc/x",
	"rm -rf /tmp/./x",
	'archive="$(mktemp /tmp/safety-guard.XXXXXX)"; archive=/etc; rm -rf "$archive"',
	"rm -rf /tmp",
	'archive="$(mktemp /tmp/safety-guard.XXXXXX)"; trap \'rm -f "$archive"\' EXIT; archive=/etc',
	'rm -f "$archive"',
]) {
	test(`confirms unproven or unsafe cleanup: ${command}`, async () => {
		assert.equal((await inspect(command)).confirmations, 1);
	});
}

test("allows cleanup inside cwd even when cwd resolves under /private", async () => {
	const { confirmations } = await inspect(
		"set -euo pipefail\nrm -rf /private/safety-guard-cwd/child",
		"/private/safety-guard-cwd",
	);
	assert.equal(confirmations, 0);
});

test("confirms a temporary-path symlink that resolves outside the temporary root", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "safety-guard-test-"));
	const link = path.join(directory, "outside");
	fs.symlinkSync("/etc", link);
	try {
		const { confirmations, dialog } = await inspect(`rm -rf ${link}/hosts`);
		assert.equal(confirmations, 1);
		assert.match(dialog, /Remove system directory: \/(?:private\/)?etc\/hosts/);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
