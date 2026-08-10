import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const fs = require("node:fs") as typeof import("node:fs");
const os = require("node:os") as typeof import("node:os");
const path = require("node:path") as typeof import("node:path");

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
	{
		pattern:
			/DROP\s+(TABLE|DATABASE|SCHEMA|INDEX|VIEW|FUNCTION|PROCEDURE|TRIGGER|USER|ROLE)/i,
		label: "DROP database object",
	},
	{ pattern: /\bTRUNCATE\s+(TABLE\s+)?/i, label: "TRUNCATE table" },
	{ pattern: /\bDELETE\s+FROM\s+/i, label: "DELETE FROM (no WHERE?)" },
	{ pattern: /\bchmod\s+(-R\s+)?777\b/, label: "chmod 777" },
	{ pattern: /\b(sudo|su\s+-)\b/, label: "Privilege escalation" },
	// Match disk formatting/partitioning commands, not benign flags such as ImageMagick's `identify -format`.
	{
		pattern: /(^|[;&|]\s*)(format|mkfs(?:\.[\w+-]+)?|fdisk|parted)\b/i,
		label: "Disk formatting/partitioning",
	},
	{ pattern: /\bdd\s+if=/, label: "Raw disk write" },
	{ pattern: />\s*\/dev\/(sd|nvme|hd|md|dm)/, label: "Write to block device" },
	{
		pattern: /\bgit\s+push\s+.*(--force|--force-with-lease|-f)\b/,
		label: "Force push",
	},
	{ pattern: /\bgcloud\s+.*\bdelete\b/, label: "GCloud delete" },
	{ pattern: /\bkubectl\s+delete\b/, label: "kubectl delete" },
	{ pattern: /\bdocker\s+(rm|rmi|system\s+prune)\b/, label: "Docker cleanup" },
	{
		pattern: /\bterraform\s+(destroy|apply\s.*-auto-approve)\b/,
		label: "Terraform destroy/auto-apply",
	},
	{
		pattern: /\bnpm\s+(unpublish|deprecate)\b/,
		label: "npm unpublish/deprecate",
	},
	{
		pattern: /\bgh\s+(repo\s+delete|secret\s+(remove|delete))\b/,
		label: "GitHub destructive action",
	},
	{ pattern: /shutdown|reboot|init\s+[06]/, label: "System shutdown/reboot" },
	{ pattern: /\bkill\s+-9\b/, label: "Force kill" },
];

const SYSTEM_DIRECTORY_ROOTS = [
	"/",
	"/System",
	"/Library",
	"/Applications",
	"/bin",
	"/sbin",
	"/usr",
	"/etc",
	"/var",
	"/private",
	"/opt",
	"/Volumes",
	"/dev",
	"/proc",
	"/sys",
];

function unique(values: string[]): string[] {
	return [...new Set(values)];
}

function isInsideOrEqual(childPath: string, parentPath: string): boolean {
	const relative = path.relative(parentPath, childPath);
	return (
		relative === "" ||
		(relative.length > 0 &&
			!relative.startsWith("..") &&
			!path.isAbsolute(relative))
	);
}

function realpathForSafety(absolutePath: string): string {
	let current = path.resolve(absolutePath);
	const missingParts: string[] = [];

	while (!fs.existsSync(current)) {
		const parent = path.dirname(current);
		if (parent === current) return path.resolve(absolutePath);
		missingParts.unshift(path.basename(current));
		current = parent;
	}

	try {
		return path.resolve(fs.realpathSync.native(current), ...missingParts);
	} catch {
		return path.resolve(absolutePath);
	}
}

const ALLOWED_TEMPORARY_ROOTS = unique(
	["/tmp", "/private/tmp"].map(realpathForSafety),
);

function isStrictlyInside(childPath: string, parentPath: string): boolean {
	return childPath !== parentPath && isInsideOrEqual(childPath, parentPath);
}

function isInsideAllowedTemporaryRoot(realTarget: string): boolean {
	return ALLOWED_TEMPORARY_ROOTS.some((root) =>
		isStrictlyInside(realTarget, root),
	);
}

function hasDotPathSegment(target: string): boolean {
	return target.split("/").some((segment) => segment === "." || segment === "..");
}

function isAllowedTemporaryRootGlob(target: string, cwd: string): boolean {
	if (path.basename(target) !== "*" || hasDotPathSegment(target)) return false;

	const absoluteTarget = path.resolve(cwd, target);
	const realParent = realpathForSafety(path.dirname(absoluteTarget));
	return ALLOWED_TEMPORARY_ROOTS.some((root) => realParent === root);
}

function isVerifiedTemporaryTarget(target: string, cwd: string): boolean {
	if (!target || target.includes("\0") || hasDotPathSegment(target)) return false;

	if (target.includes("*")) {
		return (
			!/[?\[\]{}]/.test(target) &&
			isAllowedTemporaryRootGlob(target, cwd)
		);
	}

	if (/[?\[\]{}]/.test(target)) return false;

	return isInsideAllowedTemporaryRoot(
		realpathForSafety(path.resolve(cwd, target)),
	);
}

function parseVerifiedMktempAssignment(
	segment: string,
	cwd: string,
): { name: string; template: string } | undefined {
	const match = segment.trim().match(
		/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:"\$\(\s*mktemp\s+([^\s"'`$\\;&|<>()*?\[\]{}]+)\s*\)"|\$\(\s*mktemp\s+([^\s"'`$\\;&|<>()*?\[\]{}]+)\s*\))\s*$/,
	);
	if (!match) return undefined;

	const template = match[2] ?? match[3];
	if (!template || !isVerifiedTemporaryTarget(template, cwd)) return undefined;

	return { name: match[1], template };
}

function splitShellSegments(command: string): string[] | undefined {
	const segments: string[] = [];
	let quote: "'" | '"' | undefined;
	let escaped = false;
	let current = "";

	for (const char of command) {
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}

		if (char === "\\" && quote !== "'") {
			current += char;
			escaped = true;
			continue;
		}

		if (quote) {
			if (char === quote) quote = undefined;
			current += char;
			continue;
		}

		if (char === "'" || char === '"') {
			quote = char;
			current += char;
			continue;
		}

		if (/[;&|<>\n]/.test(char)) {
			if (current.trim()) segments.push(current.trim());
			current = "";
			continue;
		}

		current += char;
	}

	if (quote || escaped) return undefined;
	if (current.trim()) segments.push(current.trim());

	return segments;
}

function expandShellVariable(
	input: string,
	index: number,
	verifiedVariables?: ReadonlyMap<string, string>,
): { nextIndex: number; value?: string } | undefined {
	const next = input[index + 1];
	if (!next) return undefined;

	let name = "";
	let nextIndex = index + 1;

	if (next === "{") {
		const end = input.indexOf("}", index + 2);
		if (end === -1) return undefined;
		name = input.slice(index + 2, end);
		nextIndex = end + 1;
	} else if (/[A-Za-z_]/.test(next)) {
		let cursor = index + 1;
		while (cursor < input.length && /[A-Za-z0-9_]/.test(input[cursor]))
			cursor += 1;
		name = input.slice(index + 1, cursor);
		nextIndex = cursor;
	} else {
		return undefined;
	}

	const value = verifiedVariables?.get(name);
	if (!value || /\s/.test(value)) return undefined;

	return { nextIndex, value };
}

function tokenizeSimpleShellWords(
	segment: string,
	verifiedVariables?: ReadonlyMap<string, string>,
): string[] | undefined {
	const tokens: string[] = [];
	let quote: "single" | "double" | undefined;
	let escaped = false;
	let current = "";
	let tokenStarted = false;

	for (let index = 0; index < segment.length; index += 1) {
		const char = segment[index];

		if (escaped) {
			current += char;
			tokenStarted = true;
			escaped = false;
			continue;
		}

		if (char === "\\" && quote !== "single") {
			escaped = true;
			tokenStarted = true;
			continue;
		}

		if (quote === "single") {
			if (char === "'") {
				quote = undefined;
			} else {
				current += char;
			}
			tokenStarted = true;
			continue;
		}

		if (quote === "double") {
			if (char === '"') {
				quote = undefined;
			} else if (char === "$") {
				const expansion = expandShellVariable(segment, index, verifiedVariables);
				if (!expansion) return undefined;
				current += expansion.value;
				index = expansion.nextIndex - 1;
			} else {
				current += char;
			}
			tokenStarted = true;
			continue;
		}

		if (/\s/.test(char)) {
			if (tokenStarted) tokens.push(current);
			current = "";
			tokenStarted = false;
			continue;
		}

		if (char === "'") {
			quote = "single";
			tokenStarted = true;
			continue;
		}

		if (char === '"') {
			quote = "double";
			tokenStarted = true;
			continue;
		}

		if (
			char === "~" &&
			!tokenStarted &&
			(index + 1 === segment.length || segment[index + 1] === "/")
		) {
			current += os.homedir();
			tokenStarted = true;
			continue;
		}

		if (char === "$") {
			const expansion = expandShellVariable(segment, index, verifiedVariables);
			if (!expansion) return undefined;
			current += expansion.value;
			index = expansion.nextIndex - 1;
			tokenStarted = true;
			continue;
		}

		current += char;
		tokenStarted = true;
	}

	if (quote || escaped) return undefined;
	if (tokenStarted) tokens.push(current);

	return tokens;
}

function parseRmTargets(tokens: string[]): string[] | undefined {
	if (tokens.length < 2 || tokens[0] !== "rm") return undefined;

	const targets: string[] = [];
	let parsingOptions = true;

	for (const token of tokens.slice(1)) {
		if (parsingOptions && token === "--") {
			parsingOptions = false;
			continue;
		}

		if (parsingOptions && token.startsWith("-") && token !== "-") continue;

		parsingOptions = false;
		targets.push(token);
	}

	return targets.length > 0 ? targets : undefined;
}

function isSystemDirectory(realTarget: string): boolean {
	return SYSTEM_DIRECTORY_ROOTS.some((root) => {
		const realRoot = realpathForSafety(root);
		return root === "/"
			? realTarget === realRoot
			: isInsideOrEqual(realTarget, realRoot);
	});
}

function parseVerifiedTemporaryRmTargets(
	segment: string,
	cwd: string,
	verifiedVariables?: ReadonlyMap<string, string>,
): string[] | undefined {
	const tokens = tokenizeSimpleShellWords(segment, verifiedVariables);
	const targets = tokens ? parseRmTargets(tokens) : undefined;
	return targets?.every((target) => isVerifiedTemporaryTarget(target, cwd))
		? targets
		: undefined;
}

function hasSingleSequenceSeparator(command: string): boolean {
	if (/&&|\|\||[|<>]/.test(command)) return false;
	return (command.match(/[;\n]/g) ?? []).length === 1;
}

function isVerifiedTestAndRmChain(
	command: string,
	segments: string[],
	cwd: string,
): boolean {
	if (segments.length !== 2 || (command.match(/&&/g) ?? []).length !== 1) {
		return false;
	}
	if (/[;|<>\n$`*?\[\]{}]/.test(command)) return false;
	if (command.replace("&&", "").includes("&")) return false;

	const testTokens = tokenizeSimpleShellWords(segments[0]);
	const targets = parseVerifiedTemporaryRmTargets(segments[1], cwd);
	return Boolean(
		testTokens &&
		testTokens.length === 3 &&
		testTokens[0] === "test" &&
		testTokens[1] === "-d" &&
		targets?.length === 1 &&
		testTokens[2] === targets[0] &&
		isVerifiedTemporaryTarget(testTokens[2], cwd),
	);
}

function isVerifiedTemporaryTrap(
	segment: string,
	cwd: string,
	verifiedVariables: ReadonlyMap<string, string>,
): boolean {
	const tokens = tokenizeSimpleShellWords(segment, verifiedVariables);
	if (!tokens || tokens[0] !== "trap" || tokens.length !== 3 || tokens[2] !== "EXIT") {
		return false;
	}

	const payloadSegments = splitShellSegments(tokens[1]);
	return Boolean(
		payloadSegments?.length === 1 &&
		parseVerifiedTemporaryRmTargets(
			payloadSegments[0],
			cwd,
			verifiedVariables,
		),
	);
}

function isVerifiedTemporaryCleanup(command: string, cwd: string): boolean {
	const segments = splitShellSegments(command);
	if (!segments) return false;

	if (segments.length === 1) {
		return Boolean(parseVerifiedTemporaryRmTargets(segments[0], cwd));
	}

	if (isVerifiedTestAndRmChain(command, segments, cwd)) return true;
	if (segments.length !== 2 || !hasSingleSequenceSeparator(command)) return false;

	const assignment = parseVerifiedMktempAssignment(segments[0], cwd);
	if (!assignment) return false;

	const verifiedVariables = new Map([[assignment.name, assignment.template]]);
	return Boolean(
		parseVerifiedTemporaryRmTargets(
			segments[1],
			cwd,
			verifiedVariables,
		) || isVerifiedTemporaryTrap(segments[1], cwd, verifiedVariables),
	);
}

function restrictedRmHits(command: string, cwd: string): string[] {
	if (isVerifiedTemporaryCleanup(command, cwd)) return [];

	const segments = splitShellSegments(command);
	if (!segments) {
		return /\brm\b/.test(command)
			? ["Unable to safely parse rm command"]
			: [];
	}

	const realCwd = realpathForSafety(path.resolve(cwd));
	const hits: string[] = [];

	for (const segment of segments) {
		const tokens = tokenizeSimpleShellWords(segment);
		if (!tokens) {
			if (/\brm\b/.test(segment)) hits.push("Unable to safely parse rm command");
			continue;
		}

		if (tokens[0] === "trap") {
			if (/\brm\b/.test(segment)) hits.push("Unable to safely parse rm command");
			continue;
		}

		if (tokens[0] !== "rm") {
			if (path.basename(tokens[0]) === "rm") {
				hits.push("Unable to safely parse rm command");
			}
			continue;
		}

		const targets = parseRmTargets(tokens);
		if (!targets) continue;

		const isAllowedTemporaryRm = targets.every((target) =>
			isVerifiedTemporaryTarget(target, cwd),
		);

		for (const target of targets) {
			const realTarget = realpathForSafety(path.resolve(cwd, target));

			if (isAllowedTemporaryRm || isInsideOrEqual(realTarget, realCwd)) {
				continue;
			}

			if (isSystemDirectory(realTarget)) {
				hits.push(`Remove system directory: ${realTarget}`);
			} else if (!isInsideOrEqual(realTarget, realCwd)) {
				hits.push(`Remove outside working directory: ${realTarget}`);
			}
		}
	}

	return unique(hits);
}

function truncate(value: string, maxChars: number): string {
	return value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value;
}

function notificationText(value: string): string {
	return value.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, " ");
}

function powerShellString(value: string): string {
	return `'${notificationText(value).replace(/'/g, "''")}'`;
}

function windowsToastScript(title: string, body: string): string {
	const type = "Windows.UI.Notifications";
	const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
	const template = `[${type}.ToastTemplateType]::ToastText01`;
	const toast = `[${type}.ToastNotification]::new($xml)`;
	return [
		`${mgr} > $null`,
		`$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
		`$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode(${powerShellString(body)})) > $null`,
		`[${type}.ToastNotificationManager]::CreateToastNotifier(${powerShellString(title)}).Show(${toast})`,
	].join("; ");
}

function wrapForTmux(sequence: string): string {
	if (!process.env.TMUX) return sequence;

	const escaped = sequence.split("\x1b").join("\x1b\x1b");
	return `\x1bPtmux;${escaped}\x1b\\`;
}

function notifyOSC777(title: string, body: string): void {
	const sequence = `\x1b]777;notify;${title};${body}\x07`;
	process.stdout.write(wrapForTmux(sequence));
}

function notifyOSC9(message: string): void {
	const sequence = `\x1b]9;${message}\x07`;
	process.stdout.write(wrapForTmux(sequence));
}

function notifyOSC99(title: string, body: string): void {
	const titleSequence = `\x1b]99;i=1:d=0;${title}\x1b\\`;
	const bodySequence = `\x1b]99;i=1:p=body;${body}\x1b\\`;
	process.stdout.write(wrapForTmux(titleSequence));
	process.stdout.write(wrapForTmux(bodySequence));
}

function notifyWindows(title: string, body: string): void {
	const { execFile } = require("node:child_process");
	execFile("powershell.exe", [
		"-NoProfile",
		"-Command",
		windowsToastScript(title, body),
	]);
}

function runSoundHook(): void {
	const command = process.env.PI_NOTIFY_SOUND_CMD?.trim();
	if (!command) return;

	try {
		const { spawn } = require("node:child_process");
		const child = spawn(command, {
			shell: true,
			detached: true,
			stdio: "ignore",
		});
		child.unref();
	} catch {
		// Notification should never block or fail the safety prompt.
	}
}

function notify(title: string, body: string): void {
	const safeTitle = notificationText(title);
	const safeBody = notificationText(body);
	const isIterm2 =
		process.env.TERM_PROGRAM === "iTerm.app" ||
		Boolean(process.env.ITERM_SESSION_ID);

	if (process.env.WT_SESSION) {
		notifyWindows(safeTitle, safeBody);
	} else if (process.env.KITTY_WINDOW_ID) {
		notifyOSC99(safeTitle, safeBody);
	} else if (isIterm2) {
		notifyOSC9(`${safeTitle}: ${safeBody}`);
	} else {
		notifyOSC777(safeTitle, safeBody);
	}

	runSoundHook();
}

function notifyApprovalRequired(command: string, hits: string[]): void {
	const normalizedCommand = command.replace(/\s+/g, " ").trim();
	const title = "Pi 等待授权";
	const body = truncate(
		`危险命令确认：${hits.join("、")}\n${normalizedCommand}`,
		220,
	);

	notify(title, body);
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return;

		const command = (event.input as { command?: string })?.command;
		if (!command) return;

		const hits = restrictedRmHits(command, ctx.cwd);
		for (const { pattern, label } of DANGEROUS_PATTERNS) {
			if (pattern.test(command)) hits.push(label);
		}

		if (hits.length === 0) return;

		// Also check for production flags on non-rm dangerous commands.
		const hasProdFlag = /(--prod|--production|prod\b|production\b)/.test(
			command,
		);

		const warningLines = hits.map((h) => `  • ${h}`);
		const extraWarning = hasProdFlag ? "\n⚠️  Production flag detected!" : "";

		notifyApprovalRequired(command, hits);

		const ok = await ctx.ui.confirm(
			`⚠️  Dangerous Command`,
			`This command triggered safety checks:\n${warningLines.join("\n")}${extraWarning}\n\nCommand:\n  ${command.slice(0, 200)}${command.length > 200 ? "…" : ""}\n\nExecute anyway?`,
		);

		if (!ok) {
			return {
				block: true,
				reason: "Blocked by safety guard — user denied execution",
			};
		}
	});
}
