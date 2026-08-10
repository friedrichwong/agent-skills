import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const DEFAULT_TIMEOUT_SECONDS = 5 * 60;
const MIN_TIMEOUT_SECONDS = 10;
const MAX_TIMEOUT_SECONDS = 30 * 60;
const STDOUT_CAP_BYTES = 512 * 1024;
const STDERR_CAP_BYTES = 128 * 1024;
const MODEL_STDOUT_CAP_BYTES = 32 * 1024;
const MODEL_STDERR_CAP_BYTES = 8 * 1024;
const KILL_GRACE_MS = 2_500;
const DEFAULT_AGY_MODEL = "gemini-3.6-flash-high";
const DEFAULT_AGY_EFFORT = "high";

const MODE_VALUES = ["research", "edit", "test", "review"] as const;
const EFFORT_VALUES = ["low", "medium", "high"] as const;
const OUTPUT_STYLE_VALUES = ["concise", "patch_summary", "verification_focused", "full"] as const;

type AgyMode = (typeof MODE_VALUES)[number];
type AgyEffort = (typeof EFFORT_VALUES)[number];
type OutputStyle = (typeof OUTPUT_STYLE_VALUES)[number];

type AgyDelegateInput = {
	task: string;
	mode?: AgyMode;
	effort?: AgyEffort;
	timeout?: number;
	additionalDirs?: string[];
	outputStyle?: OutputStyle;
};

type CappedBuffer = {
	chunks: string[];
	bytes: number;
	truncatedBytes: number;
	capBytes: number;
};

type RunResult = {
	mode: AgyMode;
	usesPty: boolean;
	cwd: string;
	additionalDirs: string[];
	model?: string;
	effort: AgyEffort;
	sandbox: boolean;
	timeoutSeconds: number;
	durationMs: number;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	timedOut: boolean;
	aborted: boolean;
	stdout: string;
	stderr: string;
	stdoutTruncatedBytes: number;
	stderrTruncatedBytes: number;
	gitStatusBefore: string | null;
	gitStatusAfter: string | null;
	gitStatusError?: string;
	argvPreview: string[];
};

function clampTimeoutSeconds(value: unknown): number {
	const numeric = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_TIMEOUT_SECONDS;
	return Math.max(MIN_TIMEOUT_SECONDS, Math.min(MAX_TIMEOUT_SECONDS, Math.round(numeric)));
}

function normalizeTimeoutSeconds(input: Record<string, unknown>): number | undefined {
	if (typeof input.timeout === "number" && Number.isFinite(input.timeout)) return input.timeout;
	if (typeof input.timeoutSeconds === "number" && Number.isFinite(input.timeoutSeconds)) return input.timeoutSeconds;
	if (typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)) return Math.ceil(input.timeoutMs / 1000);
	return undefined;
}

function getAgyBinary(): string {
	if (process.env.AGY_BIN?.trim()) return process.env.AGY_BIN.trim();
	const homeCandidate = path.join(os.homedir(), ".local", "bin", "agy");
	if (fs.existsSync(homeCandidate)) return homeCandidate;
	return "agy";
}

function createCappedBuffer(capBytes: number): CappedBuffer {
	return { chunks: [], bytes: 0, truncatedBytes: 0, capBytes };
}

function appendCapped(buffer: CappedBuffer, data: Buffer | string): void {
	const text = Buffer.isBuffer(data) ? data.toString("utf8") : data;
	const incomingBytes = Buffer.byteLength(text, "utf8");
	if (incomingBytes === 0) return;

	const previous = buffer.chunks.join("");
	let combined = previous + text;
	let combinedBytes = buffer.bytes + incomingBytes;

	if (combinedBytes <= buffer.capBytes) {
		buffer.chunks = [combined];
		buffer.bytes = combinedBytes;
		return;
	}

	let droppedBytes = 0;
	while (combinedBytes > buffer.capBytes && combined.length > 0) {
		const overflowBytes = combinedBytes - buffer.capBytes;
		const dropChars = Math.min(combined.length, Math.max(1, Math.ceil(overflowBytes / 4)));
		const dropped = combined.slice(0, dropChars);
		const bytes = Buffer.byteLength(dropped, "utf8");
		combined = combined.slice(dropChars);
		combinedBytes -= bytes;
		droppedBytes += bytes;
	}

	buffer.chunks = [combined];
	buffer.bytes = Math.max(0, combinedBytes);
	buffer.truncatedBytes += droppedBytes;
}

function cappedToString(buffer: CappedBuffer, label: string): string {
	const body = buffer.chunks.join("");
	if (buffer.truncatedBytes <= 0) return body;
	const marker = `[agy_delegate omitted ${buffer.truncatedBytes} leading ${label} byte(s); kept tail]\n`;
	return `${marker}${body}`;
}

function capTextBytes(text: string, capBytes: number, label: string): string {
	const byteLength = Buffer.byteLength(text, "utf8");
	if (byteLength <= capBytes) return text;
	let slice = text;
	while (Buffer.byteLength(slice, "utf8") > capBytes && slice.length > 0) {
		slice = slice.slice(0, -1);
	}
	return `${slice}\n[agy_delegate model output truncated ${byteLength - Buffer.byteLength(slice, "utf8")} ${label} byte(s); expand tool details for captured output]\n`;
}

function expandUserPath(input: string): string {
	if (input === "~") return os.homedir();
	if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
	return input;
}

function resolveDirectory(raw: string, cwd: string): string {
	const expanded = expandUserPath(raw.trim());
	const resolved = path.resolve(cwd, expanded);
	const stat = fs.statSync(resolved);
	if (!stat.isDirectory()) {
		throw new Error(`additionalDirs entry is not a directory: ${raw}`);
	}
	return resolved;
}

function resolveAdditionalDirs(additionalDirs: string[] | undefined, cwd: string): string[] {
	const resolved: string[] = [];
	const seen = new Set<string>([path.resolve(cwd)]);
	for (const raw of additionalDirs ?? []) {
		if (!raw?.trim()) continue;
		const dir = resolveDirectory(raw, cwd);
		if (seen.has(dir)) continue;
		seen.add(dir);
		resolved.push(dir);
	}
	return resolved;
}

function readGitStatus(cwd: string): { status: string | null; error?: string } {
	try {
		execFileSync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 5_000,
		});
		const status = execFileSync("git", ["-C", cwd, "status", "--short"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 5_000,
		});
		return { status: capTextBytes(status.trim(), 12 * 1024, "git status") || "(clean)" };
	} catch (error) {
		return { status: null, error: error instanceof Error ? error.message : String(error) };
	}
}

function shellQuoteForPreview(arg: string): string {
	if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(arg)) return arg;
	return JSON.stringify(arg);
}

function shellQuote(arg: string): string {
	if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(arg)) return arg;
	return `'${arg.replace(/'/g, `'"'"'`)}'`;
}

type SpawnInvocation = {
	command: string;
	args: string[];
	argvPreview: string[];
	usesPty: boolean;
};

function buildSpawnInvocation(agyBin: string, agyArgs: string[]): SpawnInvocation {
	const scriptBin = "/usr/bin/script";
	const ptyDisabled = process.env.AGY_DELEGATE_NO_PTY === "1";
	if (!ptyDisabled && fs.existsSync(scriptBin)) {
		if (process.platform === "darwin") {
			const args = ["-q", "-e", "/dev/null", agyBin, ...agyArgs];
			return {
				command: scriptBin,
				args,
				argvPreview: [scriptBin, ...args.slice(0, -1).map(shellQuoteForPreview), "<prompt>"],
				usesPty: true,
			};
		}

		const commandLine = [agyBin, ...agyArgs].map(shellQuote).join(" ");
		const args = ["-q", "-e", "-c", commandLine, "/dev/null"];
		return {
			command: scriptBin,
			args,
			argvPreview: [scriptBin, "-q", "-e", "-c", "<agy command with prompt>", "/dev/null"],
			usesPty: true,
		};
	}

	return {
		command: agyBin,
		args: agyArgs,
		argvPreview: [agyBin, ...agyArgs.slice(0, -1).map(shellQuoteForPreview), "<prompt>"],
		usesPty: false,
	};
}

function cleanPtyOutput(text: string): string {
	return text
		.replace(/\x04\x08\x08/g, "")
		.replace(/\^D\x08\x08/g, "")
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function buildAgyPrompt(params: Required<Pick<AgyDelegateInput, "task">> & AgyDelegateInput, cwd: string, allDirs: string[]): string {
	const mode = params.mode ?? "edit";
	const outputStyle = params.outputStyle ?? "concise";
	const dirs = allDirs.map((dir) => `- ${dir}`).join("\n");

	return `You are an Antigravity CLI subprocess delegated by Pi to save Pi context tokens.\n\n` +
		`Delegation mode: ${mode}\n` +
		`Expected output style: ${outputStyle}\n` +
		`Reasoning effort: ${params.effort ?? DEFAULT_AGY_EFFORT}\n` +
		`Primary cwd: ${cwd}\n` +
		`Allowed workspace directories:\n${dirs}\n\n` +
		`Hard rules:\n` +
		`1. Operate only inside the allowed workspace directories above. Do not read, write, or run project commands outside that scope.\n` +
		`2. You may directly edit files when needed for the delegated task, but make the smallest viable change only. Do not opportunistically refactor, reformat, or expand scope.\n` +
		`3. Do not perform destructive external actions: no git push/force-push, deploys, production mutations, cloud/Kubernetes/Terraform mutations, package publishing, credential changes, or deletion of user data.\n` +
		`4. Avoid huge logs. Summarize long command output; include only essential failing lines and command names.\n` +
		`5. Do not include hidden reasoning, chain-of-thought, or verbose thinking transcripts in the final output.\n` +
		`6. If requirements are ambiguous or risky, stop and report the needed clarification instead of guessing.\n` +
		`7. Before final response, inspect changed files when feasible and run targeted verification when appropriate for the task.\n\n` +
		`Final response must be concise and use this shape:\n` +
		`AGY_RESULT\n` +
		`status: success | partial | failed | blocked\n` +
		`changed_files:\n- <path or none>\n` +
		`verification:\n- <command/check and result, or not run with reason>\n` +
		`summary:\n- <1-5 bullets>\n` +
		`risks:\n- <residual risk or none>\n\n` +
		`Delegated task:\n${params.task.trim()}\n`;
}

function extractAgyFinal(stdout: string): { text: string; markerFound: boolean } {
	const cleaned = stdout.trim();
	const markerIndex = cleaned.lastIndexOf("AGY_RESULT");
	if (markerIndex >= 0) return { text: cleaned.slice(markerIndex).trim(), markerFound: true };
	return { text: cleaned, markerFound: false };
}

function summarizeForModel(result: RunResult): string {
	const status = result.timedOut ? "timed_out" : result.aborted ? "aborted" : result.exitCode === 0 ? "completed" : "failed";
	const parts: string[] = [];
	parts.push(`agy_delegate ${status}`);
	parts.push(`mode: ${result.mode}`);
	parts.push(`cwd: ${result.cwd}`);
	parts.push(`duration: ${(result.durationMs / 1000).toFixed(1)}s`);
	parts.push(`exit: ${result.exitCode ?? "null"}${result.signal ? ` signal=${result.signal}` : ""}`);
	parts.push(`sandbox: ${result.sandbox ? "on" : "off"}`);
	if (result.model) parts.push(`model: ${result.model}`);
	parts.push(`effort: ${result.effort}`);
	parts.push(`pty: ${result.usesPty ? "on" : "off"}`);
	if (result.gitStatusBefore && result.gitStatusBefore !== "(clean)") {
		parts.push(`git_status_before:\n${capTextBytes(result.gitStatusBefore, 4 * 1024, "git status before")}`);
	}
	if (result.gitStatusAfter) {
		parts.push(`git_status_after:\n${capTextBytes(result.gitStatusAfter, 8 * 1024, "git status after")}`);
	} else if (result.gitStatusError) {
		parts.push(`git_status_after: unavailable (${result.gitStatusError.split("\n")[0]})`);
	}
	const final = extractAgyFinal(result.stdout);
	const stdout = capTextBytes(final.text, MODEL_STDOUT_CAP_BYTES, final.markerFound ? "AGY_RESULT" : "stdout tail");
	if (stdout) parts.push(`${final.markerFound ? "agy_result" : "agy_stdout_tail"}:\n${stdout}`);
	const stderr = capTextBytes(result.stderr.trim(), MODEL_STDERR_CAP_BYTES, "stderr");
	if (stderr) parts.push(`agy_stderr_tail:\n${stderr}`);
	return parts.join("\n\n");
}

function terminateChild(child: ReturnType<typeof spawn>): void {
	if (!child.pid || child.killed) return;
	try {
		if (process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
		else child.kill("SIGTERM");
	} catch {
		try {
			child.kill("SIGTERM");
		} catch {
			// ignore
		}
	}
	setTimeout(() => {
		if (!child.pid || child.killed) return;
		try {
			if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
			else child.kill("SIGKILL");
		} catch {
			// ignore
		}
	}, KILL_GRACE_MS).unref();
}

async function runAgy(params: AgyDelegateInput, signal: AbortSignal | undefined, cwd: string, onUpdate?: (partial: any) => void): Promise<RunResult> {
	if (!params.task?.trim()) throw new Error("agy_delegate requires a non-empty task");
	const mode = params.mode ?? "edit";
	const sandbox = false;
	const model = DEFAULT_AGY_MODEL;
	const effort = params.effort ?? DEFAULT_AGY_EFFORT;
	const timeoutSeconds = clampTimeoutSeconds(params.timeout);
	const additionalDirs = resolveAdditionalDirs(params.additionalDirs, cwd);
	const allDirs = [cwd, ...additionalDirs];
	const prompt = buildAgyPrompt({ ...params, task: params.task, mode }, cwd, allDirs);
	const agyBin = getAgyBinary();
	// agy currently treats arguments after --print as prompt content, so all flags must precede --print.
	// Run in yolo-style delegated mode: no --sandbox, always --dangerously-skip-permissions, fixed model, configurable effort.
	const args: string[] = ["--print-timeout", `${timeoutSeconds}s`, "--add-dir", cwd, "--dangerously-skip-permissions", "--model", model, "--effort", effort];
	for (const dir of additionalDirs) args.push("--add-dir", dir);
	args.push("--print", prompt);

	const before = readGitStatus(cwd);
	const stdoutBuffer = createCappedBuffer(STDOUT_CAP_BYTES);
	const stderrBuffer = createCappedBuffer(STDERR_CAP_BYTES);
	const started = Date.now();
	let timedOut = false;
	let aborted = false;

	onUpdate?.({
		content: [{ type: "text", text: `Delegating to agy (${mode}, timeout ${timeoutSeconds}s)...` }],
		details: { mode, cwd, status: "running", timeoutSeconds, sandbox, model, effort },
	});

	const invocation = buildSpawnInvocation(agyBin, args);

	const child = spawn(invocation.command, invocation.args, {
		cwd,
		env: {
			...process.env,
			PATH: `${path.join(os.homedir(), ".local", "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
		},
		stdio: ["ignore", "pipe", "pipe"],
		detached: process.platform !== "win32",
	});

	const timeoutHandle = setTimeout(() => {
		timedOut = true;
		terminateChild(child);
	}, timeoutSeconds * 1000);
	timeoutHandle.unref();

	const abortHandler = () => {
		aborted = true;
		terminateChild(child);
	};
	if (signal) {
		if (signal.aborted) abortHandler();
		else signal.addEventListener("abort", abortHandler, { once: true });
	}

	child.stdout?.on("data", (chunk) => appendCapped(stdoutBuffer, chunk));
	child.stderr?.on("data", (chunk) => appendCapped(stderrBuffer, chunk));

	const { code, signal: exitSignal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (code, exitSignal) => resolve({ code, signal: exitSignal }));
	});

	clearTimeout(timeoutHandle);
	if (signal) signal.removeEventListener("abort", abortHandler);
	const after = readGitStatus(cwd);

	return {
		mode,
		cwd,
		additionalDirs,
		model,
		effort,
		sandbox,
		timeoutSeconds,
		durationMs: Date.now() - started,
		exitCode: code,
		signal: exitSignal,
		timedOut,
		aborted,
		stdout: cleanPtyOutput(cappedToString(stdoutBuffer, "stdout")),
		stderr: cleanPtyOutput(cappedToString(stderrBuffer, "stderr")),
		stdoutTruncatedBytes: stdoutBuffer.truncatedBytes,
		stderrTruncatedBytes: stderrBuffer.truncatedBytes,
		gitStatusBefore: before.status,
		gitStatusAfter: after.status,
		gitStatusError: after.error ?? before.error,
		usesPty: invocation.usesPty,
		argvPreview: invocation.argvPreview,
	};
}

export default function agyDelegateExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "agy_delegate",
		label: "Agy Delegate",
		description:
			"Delegate a bounded, clear coding subtask to the local Antigravity agy CLI. Agy may directly edit files; Pi remains responsible for review and final verification.",
		promptSnippet:
			"Delegate bounded clear/tedious coding subtasks to local Antigravity CLI via agy_delegate to save Pi context tokens.",
		promptGuidelines: [
			"Use agy_delegate proactively for clear, bounded, tedious, repetitive, or broad-context subtasks where an isolated agy CLI run can do the work with less Pi-token usage.",
			"Use agy_delegate for bulk code search, mechanical edits, localized implementation, targeted test-fix loops, and first-pass review; do not use it for ambiguous product decisions, high-risk architecture, secrets, deployments, or destructive external actions.",
			"When calling agy_delegate, pass a self-contained task, choose mode research/edit/test/review, choose a realistic timeout for the task size, include additionalDirs only when necessary, and request concise output.",
			"After agy_delegate returns, Pi must inspect the result/diff, run or request appropriate verification, and remain responsible for the final answer and residual-risk assessment.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "Self-contained delegated task for agy. Include goal, scope, constraints, and verification expectations." }),
			mode: Type.Optional(StringEnum(MODE_VALUES)),
			effort: Type.Optional(StringEnum(EFFORT_VALUES, { description: "Reasoning effort for agy. Defaults to high." })),
			timeout: Type.Optional(Type.Number({ description: "Wall-clock timeout in seconds for agy --print and the wrapper process. Default 5m; choose longer for broad edits/test-fix loops, up to 30m.", minimum: MIN_TIMEOUT_SECONDS, maximum: MAX_TIMEOUT_SECONDS })),
			additionalDirs: Type.Optional(Type.Array(Type.String({ description: "Extra directory to expose with --add-dir. Relative paths resolve from the current Pi cwd." }), { description: "Additional workspace directories for agy." })),
			outputStyle: Type.Optional(StringEnum(OUTPUT_STYLE_VALUES)),
		}),
		prepareArguments(args) {
			if (!args || typeof args !== "object") return args;
			const input = args as Record<string, unknown>;
			return {
				...input,
				timeout: normalizeTimeoutSeconds(input),
				additionalDirs: input.additionalDirs ?? input.addDirs ?? input.dirs,
				outputStyle: input.outputStyle ?? input.expectedOutputStyle ?? input.expected_output_style,
			};
		},
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const result = await runAgy(params as AgyDelegateInput, signal, ctx.cwd, onUpdate);
			return {
				content: [{ type: "text", text: summarizeForModel(result) }],
				details: result,
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const input = args as Partial<AgyDelegateInput>;
			const mode = input.mode ?? "edit";
			const task = input.task ? input.task.replace(/\s+/g, " ").slice(0, 80) : "...";
			text.setText(`${theme.fg("toolTitle", theme.bold("agy_delegate"))} ${theme.fg("muted", mode)} ${theme.fg("dim", task)}`);
			return text;
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			if (isPartial) {
				text.setText(theme.fg("warning", "Delegating to agy..."));
				return text;
			}
			const details = result.details as RunResult | undefined;
			if (!details) {
				text.setText(theme.fg("muted", "agy_delegate finished"));
				return text;
			}
			const ok = details.exitCode === 0 && !details.timedOut && !details.aborted;
			let rendered = ok ? theme.fg("success", "✓ agy finished") : theme.fg("error", "✗ agy issue");
			rendered += theme.fg("dim", ` ${(details.durationMs / 1000).toFixed(1)}s mode=${details.mode} exit=${details.exitCode ?? "null"}`);
			if (details.gitStatusAfter && details.gitStatusAfter !== "(clean)") {
				rendered += `\n${theme.fg("muted", "git status:")} ${theme.fg("toolOutput", details.gitStatusAfter.split("\n").slice(0, expanded ? 40 : 8).join("\n"))}`;
			}
			if (expanded) {
				const stdout = details.stdout.trim();
				const stderr = details.stderr.trim();
				if (stdout) rendered += `\n\n${theme.fg("muted", "agy stdout:")}\n${stdout}`;
				if (stderr) rendered += `\n\n${theme.fg("muted", "agy stderr:")}\n${stderr}`;
			} else if (details.stdout.trim()) {
				const firstLines = details.stdout.trim().split("\n").slice(0, 6).join("\n");
				rendered += `\n${theme.fg("toolOutput", firstLines)}`;
			}
			text.setText(rendered);
			return text;
		},
	});

	pi.registerCommand("agy", {
		description: "Delegate a task to local Antigravity agy CLI via agy_delegate",
		handler: async (args, ctx) => {
			const task = args.trim();
			if (!task) {
				ctx.ui.notify("Usage: /agy <bounded task to delegate>", "warning");
				return;
			}
			const message = `Use agy_delegate now for this bounded delegated task. Mode: edit unless a read-only/review/test mode is clearly better. Keep output concise and review the result afterwards.\n\n${task}`;
			if (ctx.isIdle()) pi.sendUserMessage(message);
			else {
				pi.sendUserMessage(message, { deliverAs: "followUp" });
				ctx.ui.notify("Queued /agy delegation as a follow-up", "info");
			}
		},
	});
}
