/**
 * pi-kimi-cron — Cron Scheduler extension for the Pi coding agent.
 *
 * Inspired by and ported from Kimi Code's cron module
 * (https://github.com/MoonshotAI/kimi-code).
 *
 * Registers CronCreate / CronDelete / CronList tools and runs a tick-loop
 * scheduler that injects prompts into the conversation on schedule.
 *
 * Limitation: tasks only fire while Pi is running. On restart, tasks are
 * rehydrated from disk and resume from their last fire time.
 *
 * Persistence: ~/.pi/agent/cron/<session-id>/<8-hex-id>.json
 *
 * Single-file port: all modules consolidated into one file because
 * Pi's jiti loader does not follow re-export chains.
 */

import type {
	ExtensionAPI,
	AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import {
	mkdir,
	readdir,
	readFile,
	rename,
	open,
	unlink,
} from "node:fs/promises";

// ════════════════════════════════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════════════════════════════════

/** Cron task data model. Ported from Kimi Code cron module. */
export interface CronTask {
	id: string;           // 8-hex-char unique id
	cron: string;         // 5-field cron expression
	prompt: string;       // Prompt text injected when the task fires
	recurring?: boolean;  // Whether the task repeats after firing (default true)
	createdAt: number;    // Epoch ms when the task was created
	lastFiredAt: number;  // Epoch ms of the last successful fire (0 = never fired)
	fires?: FireRecord[]; // Per-task fire audit trail; appended on each fire
	executionMode?: ExecutionMode; // How the task runs when fired (default: sub-agent)
}

export type ExecutionMode = "main" | "sub-agent";

export type FireStatus = "spawned" | "completed" | "failed";

export interface FireRecord {
	fireId: string;       // 8-hex unique per fire
	firedAt: number;      // Epoch ms when cron fired
	startedAt: number;    // Epoch ms when sub-agent was spawned
	endedAt?: number;     // Epoch ms when CronReport was called
	agentId?: string;     // Sub-agent ID (filled by main agent via CronReport)
	logFile?: string;     // Path to sub-agent output file (filled by CronReport)
	status: FireStatus;
	summary?: string;     // Brief summary from sub-agent (must include taskId for traceability)
	error?: string;       // Error message if status=failed
}

export type HistoryStatus = "done" | "cancelled" | "failed";

export interface HistoryEntry {
	id: string;
	cron: string;
	prompt: string;
	recurring?: boolean;
	createdAt: number;    // "create event" timestamp
	endTime: number;      // When task was archived (deleted / one-shot completed)
	status: HistoryStatus;
	fires: FireRecord[];  // All fire records for this task
	logFile?: string;     // Latest fire's sub-agent output file path
}

// ════════════════════════════════════════════════════════════════════════
// CRON EXPRESSION PARSER
// ════════════════════════════════════════════════════════════════════════

const FIELD_RANGES: [number, number][] = [
	[0, 59], // minute
	[0, 23], // hour
	[1, 31], // day of month
	[1, 12], // month
	[0, 6],  // day of week (0 = Sunday)
];

const MONTH_NAMES: Record<string, number> = {
	jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
	jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const DOW_NAMES: Record<string, number> = {
	sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

export interface ParsedCron {
	minutes: Set<number>;
	hours: Set<number>;
	daysOfMonth: Set<number>;
	months: Set<number>;
	daysOfWeek: Set<number>;
}

function resolveName(token: string, fieldIndex: number): number {
	const lower = token.toLowerCase();
	if (fieldIndex === 3 && lower in MONTH_NAMES) return MONTH_NAMES[lower];
	if (fieldIndex === 4 && lower in DOW_NAMES) return DOW_NAMES[lower];
	return parseInt(token, 10);
}

/** @internal */
export function parseField(field: string, fieldIndex: number): Set<number> {
	const [lo, hi] = FIELD_RANGES[fieldIndex];
	const result = new Set<number>();

	for (const part of field.split(",")) {
		const trimmed = part.trim();
		if (!trimmed) continue;

		const slashIdx = trimmed.indexOf("/");
		let base = trimmed;
		let step = 1;
		if (slashIdx !== -1) {
			base = trimmed.slice(0, slashIdx);
			step = parseInt(trimmed.slice(slashIdx + 1), 10);
			if (isNaN(step) || step < 1)
				throw new Error(`Invalid step in cron field: ${trimmed}`);
		}

		let rangeLo: number;
		let rangeHi: number;

		if (base === "*") {
			rangeLo = lo;
			rangeHi = hi;
		} else if (base.includes("-")) {
			const [a, b] = base.split("-");
			rangeLo = resolveName(a, fieldIndex);
			rangeHi = resolveName(b, fieldIndex);
		} else {
			rangeLo = resolveName(base, fieldIndex);
			rangeHi = rangeLo;
		}

		if (isNaN(rangeLo) || isNaN(rangeHi)) {
			throw new Error(`Invalid cron field value: ${trimmed}`);
		}
		if (rangeLo < lo || rangeHi > hi || rangeLo > rangeHi) {
			throw new Error(`Cron field value out of range [${lo}-${hi}]: ${trimmed}`);
		}

		for (let v = rangeLo; v <= rangeHi; v += step) {
			result.add(v);
		}
	}

	if (result.size === 0) {
		throw new Error(`Cron field produced no values: ${field}`);
	}
	return result;
}

/** @internal */
export function parseCronExpression(expr: string): ParsedCron {
	const fields = expr.trim().split(/\s+/);
	if (fields.length !== 5) {
		throw new Error(
			`Cron expression must have exactly 5 fields, got ${fields.length}: "${expr}"`,
		);
	}
	return {
		minutes: parseField(fields[0], 0),
		hours: parseField(fields[1], 1),
		daysOfMonth: parseField(fields[2], 2),
		months: parseField(fields[3], 3),
		daysOfWeek: parseField(fields[4], 4),
	};
}

/** @internal */
export function computeNextCronRun(
	parsed: ParsedCron,
	afterMs: number,
	maxYears = 4,
): number | null {
	const maxMs = afterMs + maxYears * 366 * 24 * 60 * 60 * 1000;
	const d = new Date(afterMs);
	d.setSeconds(0, 0);
	d.setMinutes(d.getMinutes() + 1);

	while (d.getTime() <= maxMs) {
		if (!parsed.months.has(d.getMonth() + 1)) {
			d.setMonth(d.getMonth() + 1, 1);
			d.setHours(0, 0, 0, 0);
			continue;
		}
		const domMatch = parsed.daysOfMonth.has(d.getDate());
		const dowMatch = parsed.daysOfWeek.has(d.getDay());
		if (!domMatch || !dowMatch) {
			d.setDate(d.getDate() + 1);
			d.setHours(0, 0, 0, 0);
			continue;
		}
		if (!parsed.hours.has(d.getHours())) {
			d.setHours(d.getHours() + 1, 0, 0, 0);
			continue;
		}
		if (!parsed.minutes.has(d.getMinutes())) {
			d.setMinutes(d.getMinutes() + 1, 0, 0);
			continue;
		}
		return d.getTime();
	}
	return null;
}

/** @internal */
export function cronToHuman(cron: string): string {
	const presets: Record<string, string> = {
		"* * * * *": "every minute",
		"0 * * * *": "every hour",
		"0 0 * * *": "daily at midnight",
		"0 9 * * *": "daily at 9:00 AM",
		"0 9 * * 1-5": "weekdays at 9:00 AM",
		"0 0 * * 0": "weekly on Sunday at midnight",
		"0 0 1 * *": "monthly on the 1st at midnight",
	};

	const normalized = cron.trim().replace(/\s+/g, " ");
	if (presets[normalized]) return presets[normalized];

	const fields = normalized.split(" ");
	if (fields.length !== 5) return cron;

	const [minute, hour, dom, month, dow] = fields;
	const parts: string[] = [];

	if (minute !== "*") parts.push(`at minute ${minute}`);
	if (hour !== "*") parts.push(`hour ${hour}`);
	if (dom !== "*") parts.push(`on day ${dom}`);
	if (month !== "*") parts.push(`in month ${month}`);
	if (dow !== "*") {
		const dowNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
		const names = dow.split(",").map((d) => {
			const n = parseInt(d, 10);
			return isNaN(n) ? d : (dowNames[n] ?? d);
		});
		parts.push(`on ${names.join(", ")}`);
	}

	return parts.length > 0 ? parts.join(", ") : cron;
}

// ════════════════════════════════════════════════════════════════════════
// JITTER (thundering-herd prevention)
// ════════════════════════════════════════════════════════════════════════

const MAX_JITTER_MS = 5_000;

function computeJitter(taskId: string): number {
	if (process.env.PI_CRON_NO_JITTER === "1") return 0;

	let hash = 0;
	for (let i = 0; i < taskId.length; i++) {
		hash = ((hash << 5) - hash + taskId.charCodeAt(i)) | 0;
	}
	return Math.abs(hash) % (MAX_JITTER_MS + 1);
}

// ════════════════════════════════════════════════════════════════════════
// CRON FIRE XML RENDERER
// ════════════════════════════════════════════════════════════════════════

export interface CronJobOrigin {
	kind: "cron_job";
	jobId: string;
	fireId: string;
	cron: string;
	recurring: boolean;
	coalescedCount: number;
	stale: boolean;
	executionMode: ExecutionMode;
}

/** @internal */
export function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/** @internal */
export function renderCronFireXml(origin: CronJobOrigin, prompt: string): string {
	const lines: string[] = [
		"<cron_fire>",
		`  <job_id>${escapeXml(origin.jobId)}</job_id>`,
		`  <fire_id>${escapeXml(origin.fireId)}</fire_id>`,
		`  <cron>${escapeXml(origin.cron)}</cron>`,
		`  <recurring>${origin.recurring}</recurring>`,
		`  <execution_mode>${escapeXml(origin.executionMode)}</execution_mode>`,
	];

	if (origin.coalescedCount > 1) {
		lines.push(`  <coalesced_count>${origin.coalescedCount}</coalesced_count>`);
	}
	if (origin.stale) {
		lines.push("  <stale>true</stale>");
	}

	lines.push(`  <prompt>${escapeXml(prompt)}</prompt>`);

	if (origin.executionMode === "main") {
		lines.push(
			"  <instructions>",
			"    Main mode: execute this prompt directly in the current conversation.",
			`    When done, call CronReport with taskId="${origin.jobId}", fireId="${origin.fireId}",`,
			"    status=completed (or failed), summary=<brief summary including taskId for traceability>.",
			"    Use main mode for tasks that need access to current session state or other agent tools.",
			"  </instructions>",
		);
	} else {
		lines.push(
			"  <instructions>",
			"    Sub-agent mode: spawn a sub-agent via the Agent tool (run_in_background: true) with the prompt above.",
			"    The sub-agent runs silently in the background; no streaming output in this conversation.",
			"    When the sub-agent completes (you receive a task-notification), call CronReport with:",
			`       taskId="${origin.jobId}", fireId="${origin.fireId}", summary=<brief summary including taskId for traceability>,`,
			"       status=completed (or failed), agentId=<agent.id>, logFile=<output_file_path>",
			"  </instructions>",
		);
	}
	lines.push("</cron_fire>");

	return lines.join("\n");
}

// ════════════════════════════════════════════════════════════════════════
// CLOCK SOURCES
// ════════════════════════════════════════════════════════════════════════

export interface ClockSource {
	now(): number;
}

export const systemClock: ClockSource = {
	now: () => Date.now(),
};

export function fixedClock(ms: number): ClockSource {
	return { now: () => ms };
}

export function offsetClock(offsetMs: number): ClockSource {
	return { now: () => Date.now() + offsetMs };
}

export const SYSTEM_CLOCKS = { wall: systemClock, mono: systemClock };

// ════════════════════════════════════════════════════════════════════════
// PER-ID JSON FILE STORE (atomic writes)
// ════════════════════════════════════════════════════════════════════════

async function atomicWrite(target: string, content: string): Promise<void> {
	const tmpPath = `${target}.${process.pid}.tmp`;
	const fd = await open(tmpPath, "w");
	try {
		await fd.writeFile(content, "utf-8");
		await fd.sync();
	} finally {
		await fd.close();
	}
	await rename(tmpPath, target);
}

export interface PerIdJsonStoreOptions<T> {
	rootDir: string;
	subdir: string;
	idRegex: RegExp;
	isValid: (entity: unknown) => entity is T;
	entityName: string;
}

export interface PerIdJsonStore<T> {
	write(id: string, entity: T): Promise<void>;
	remove(id: string): Promise<void>;
	list(): Promise<T[]>;
	dir(): string;
}

/** @internal */
export function createPerIdJsonStore<T>(
	options: PerIdJsonStoreOptions<T>,
): PerIdJsonStore<T> {
	const { rootDir, subdir, idRegex, isValid, entityName } = options;
	const dir = subdir ? join(rootDir, subdir) : rootDir;

	async function ensureDir(): Promise<void> {
		await mkdir(dir, { recursive: true });
	}

	function filePath(id: string): string {
		return join(dir, `${id}.json`);
	}

	return {
		async write(id: string, entity: T): Promise<void> {
			if (!idRegex.test(id)) {
				throw new Error(`Invalid ${entityName}: ${id}`);
			}
			await ensureDir();
			const content = JSON.stringify(entity, null, 2) + "\n";
			await atomicWrite(filePath(id), content);
		},

		async remove(id: string): Promise<void> {
			if (!idRegex.test(id)) return;
			try {
				await unlink(filePath(id));
			} catch (err: unknown) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			}
		},

		async list(): Promise<T[]> {
			let entries: string[];
			try {
				entries = await readdir(dir);
			} catch (err: unknown) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
				throw err;
			}

			const results: T[] = [];
			for (const entry of entries) {
				if (!entry.endsWith(".json")) continue;
				const id = entry.slice(0, -5);
				if (!idRegex.test(id)) continue;

				try {
					const raw = await readFile(join(dir, entry), "utf-8");
					const parsed = JSON.parse(raw);
					if (isValid(parsed)) {
						results.push(parsed);
					}
				} catch {
					// skip corrupt files
				}
			}
			return results;
		},

		dir: () => dir,
	};
}

// ════════════════════════════════════════════════════════════════════════
// HISTORY STORE (single fixed file with 50-entry FIFO cap)
// ════════════════════════════════════════════════════════════════════════

const HISTORY_FILE = "_history.json";
export const MAX_HISTORY_ENTRIES = 50;

export interface HistoryStore {
	archive(entry: HistoryEntry): Promise<HistoryEntry | null>;
	list(limit?: number): Promise<HistoryEntry[]>;
	get(id: string): Promise<HistoryEntry | undefined>;
	filePath(): string;
}

/** @internal */
export function createHistoryStore(cronDir: string): HistoryStore {
	const file = join(cronDir, HISTORY_FILE);

	async function readAll(): Promise<HistoryEntry[]> {
		try {
			const raw = await readFile(file, "utf-8");
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) return parsed as HistoryEntry[];
			return [];
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw err;
		}
	}

	async function writeAll(entries: HistoryEntry[]): Promise<void> {
		await mkdir(cronDir, { recursive: true });
		await atomicWrite(file, JSON.stringify(entries, null, 2) + "\n");
	}

	return {
		async archive(entry: HistoryEntry): Promise<HistoryEntry | null> {
			const entries = await readAll();
			entries.push(entry);
			let evicted: HistoryEntry | null = null;
			while (entries.length > MAX_HISTORY_ENTRIES) {
				evicted = entries.shift() ?? null;
			}
			await writeAll(entries);
			return evicted;
		},

		async list(limit = 10): Promise<HistoryEntry[]> {
			const entries = await readAll();
			return entries.filter(isValidHistoryEntry).slice(-limit).reverse();
		},

		async get(id: string): Promise<HistoryEntry | undefined> {
			const entries = await readAll();
			return entries.filter(isValidHistoryEntry).find((e) => e.id === id);
		},

		filePath: () => file,
	};
}

/** @internal */
export function isValidHistoryEntry(entity: unknown): entity is HistoryEntry {
	if (typeof entity !== "object" || entity === null) return false;
	const obj = entity as Record<string, unknown>;
	return (
		typeof obj.id === "string" &&
		CRON_ID_REGEX.test(obj.id) &&
		typeof obj.cron === "string" &&
		typeof obj.prompt === "string" &&
		typeof obj.createdAt === "number" &&
		typeof obj.endTime === "number" &&
		typeof obj.status === "string" &&
		Array.isArray(obj.fires)
	);
}

// ════════════════════════════════════════════════════════════════════════
// CRON TASK PERSISTENCE
// ════════════════════════════════════════════════════════════════════════

const CRON_ID_REGEX = /^[0-9a-f]{8}$/;

/** @internal */
export function isValidCronTask(entity: unknown): entity is CronTask {
	if (typeof entity !== "object" || entity === null) return false;
	const obj = entity as Record<string, unknown>;
	return (
		typeof obj.id === "string" &&
		CRON_ID_REGEX.test(obj.id) &&
		typeof obj.cron === "string" &&
		typeof obj.prompt === "string" &&
		typeof obj.createdAt === "number" &&
		typeof obj.lastFiredAt === "number"
	);
}

function createCronPersistStore(cronDir: string): PerIdJsonStore<CronTask> {
	return createPerIdJsonStore<CronTask>({
		rootDir: cronDir,
		subdir: "",
		idRegex: CRON_ID_REGEX,
		isValid: isValidCronTask,
		entityName: "cron job id",
	});
}

// ════════════════════════════════════════════════════════════════════════
// IN-MEMORY SESSION STORE
// ════════════════════════════════════════════════════════════════════════

/** @internal */
export function generateId(): string {
	return randomBytes(4).toString("hex");
}

/** @internal */
export class SessionCronStore {
	private tasks = new Map<string, CronTask>();

	add(input: {
		cron: string;
		prompt: string;
		recurring?: boolean;
		executionMode?: ExecutionMode;
	}): CronTask {
		let id = generateId();
		while (this.tasks.has(id)) id = generateId();

		const task: CronTask = {
			id,
			cron: input.cron,
			prompt: input.prompt,
			recurring: input.recurring !== false,
			executionMode: input.executionMode ?? "sub-agent",
			createdAt: Date.now(),
			lastFiredAt: 0,
		};
		this.tasks.set(id, task);
		return task;
	}

	adopt(task: CronTask): void {
		this.tasks.set(task.id, { ...task });
	}

	remove(ids: string[]): CronTask[] {
		const removed: CronTask[] = [];
		for (const id of ids) {
			const task = this.tasks.get(id);
			if (task) {
				this.tasks.delete(id);
				removed.push(task);
			}
		}
		return removed;
	}

	get(id: string): CronTask | undefined {
		return this.tasks.get(id);
	}

	list(): CronTask[] {
		return [...this.tasks.values()];
	}

	markFired(id: string, firedAt: number): CronTask | undefined {
		const task = this.tasks.get(id);
		if (!task) return undefined;
		const updated = { ...task, lastFiredAt: firedAt };
		this.tasks.set(id, updated);
		return updated;
	}

	update(task: CronTask): CronTask | undefined {
		const existing = this.tasks.get(task.id);
		if (!existing) return undefined;
		this.tasks.set(task.id, { ...task });
		return task;
	}

	clear(): void {
		this.tasks.clear();
	}

	get size(): number {
		return this.tasks.size;
	}

	static isValidId(id: string): boolean {
		return CRON_ID_REGEX.test(id);
	}
}

// ════════════════════════════════════════════════════════════════════════
// TICK-LOOP SCHEDULER
// ════════════════════════════════════════════════════════════════════════

const TICK_INTERVAL_MS = 15_000;
const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function debug(...args: unknown[]): void {
	if (process.env.PI_CRON_DEBUG === "1") {
		console.error("[cron-scheduler]", ...args);
	}
}

interface TrackedTask {
	lastSeenAt: number;
	coalescedCount: number;
}

interface SchedulerOptions {
	clocks: { wall: ClockSource; mono: ClockSource };
	source: () => CronTask[];
	isIdle: () => boolean;
	onFire: (task: CronTask, meta: { coalescedCount: number }) => void;
	removeOneShot: (id: string) => void;
	onAdvanceCursor: (taskId: string, lastFiredAt: number) => void;
}

interface CronScheduler {
	start(): void;
	stop(): Promise<void>;
	isRunning(): boolean;
}

function createCronScheduler(options: SchedulerOptions): CronScheduler {
	const { clocks, source, isIdle, onFire, removeOneShot, onAdvanceCursor } = options;
	const tracked = new Map<string, TrackedTask>();
	let timer: ReturnType<typeof setInterval> | null = null;
	let inFlight = false;

	function tick(): void {
		if (inFlight) {
			debug("tick skipped (in-flight)");
			return;
		}
		inFlight = true;
		try {
			tickInner();
		} catch (err) {
			debug("tick error:", err);
		} finally {
			inFlight = false;
		}
	}

	function tickInner(): void {
		const now = clocks.wall.now();
		const idle = isIdle();

		let tasks: CronTask[];
		try {
			tasks = source();
		} catch (err) {
			debug("source() error:", err);
			return;
		}

		const currentIds = new Set(tasks.map((t) => t.id));
		for (const id of tracked.keys()) {
			if (!currentIds.has(id)) tracked.delete(id);
		}

		for (const task of tasks) {
			try {
				processTask(task, now, idle);
			} catch (err) {
				debug(`task ${task.id} error:`, err);
			}
		}
	}

	function processTask(task: CronTask, now: number, idle: boolean): void {
		let entry = tracked.get(task.id);
		if (!entry) {
			entry = {
				lastSeenAt: task.lastFiredAt > 0 ? task.lastFiredAt : now,
				coalescedCount: 0,
			};
			tracked.set(task.id, entry);
			debug(`task ${task.id} first seen, lastSeenAt=${entry.lastSeenAt}`);
		}

		let parsed;
		try {
			parsed = parseCronExpression(task.cron);
		} catch {
			debug(`task ${task.id} has invalid cron: ${task.cron}`);
			return;
		}

		const jitter = computeJitter(task.id);
		const nextFire = computeNextCronRun(parsed, entry.lastSeenAt);
		if (nextFire === null) {
			debug(`task ${task.id} has no next fire`);
			return;
		}

		const fireAt = nextFire + jitter;

		if (now < fireAt) return;

		if (!idle) {
			entry.coalescedCount++;
			entry.lastSeenAt = now;
			debug(`task ${task.id} coalesced (busy), count=${entry.coalescedCount}`);
			return;
		}

		const coalescedCount = entry.coalescedCount + 1;
		debug(`task ${task.id} firing, coalescedCount=${coalescedCount}`);

		onFire(task, { coalescedCount });

		entry.lastSeenAt = now;
		entry.coalescedCount = 0;
		onAdvanceCursor(task.id, now);

		if (task.recurring === false) {
			removeOneShot(task.id);
			tracked.delete(task.id);
		}
	}

	return {
		start(): void {
			if (timer) return;
			debug("starting scheduler");
			timer = setInterval(tick, TICK_INTERVAL_MS);
			timer.unref();
			tick();
		},

		async stop(): Promise<void> {
			if (timer) {
				clearInterval(timer);
				timer = null;
			}
			tracked.clear();
			debug("scheduler stopped");
		},

		isRunning(): boolean {
			return timer !== null;
		},
	};
}

// ════════════════════════════════════════════════════════════════════════
// ARGS TOKENIZER (slash-command input parsing)
// ════════════════════════════════════════════════════════════════════════

/** @internal */
export function tokenizeArgs(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let inQuotes = false;
	for (let i = 0; i < input.length; i++) {
		const c = input[i];
		if (c === '"') {
			inQuotes = !inQuotes;
		} else if (c === " " && !inQuotes) {
			if (current.length > 0) {
				tokens.push(current);
				current = "";
			}
		} else {
			current += c;
		}
	}
	if (current.length > 0) tokens.push(current);
	return tokens;
}

// ════════════════════════════════════════════════════════════════════════
// MAIN EXTENSION ENTRY POINT
// ════════════════════════════════════════════════════════════════════════

export default function cronSchedulerExtension(pi: ExtensionAPI) {
	const store = new SessionCronStore();
	let scheduler: CronScheduler | null = null;
	let busy = false;
	let persistStore: PerIdJsonStore<CronTask> | null = null;
	let historyStore: HistoryStore | null = null;

	// ── Idle gating ──────────────────────────────────────────────
	pi.on("turn_start", async () => {
		busy = true;
	});

	pi.on("turn_end", async () => {
		busy = false;
	});

	// ── Session lifecycle ────────────────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		let sessionId: string;
		try {
			sessionId = ctx.sessionManager.getSessionId();
		} catch {
			const sessionFile = ctx.sessionManager.getSessionFile() ?? "";
			sessionId = sessionFile.replace(/[^a-zA-Z0-9_-]/g, "_").slice(-32);
		}

		const cronDir = join(homedir(), ".pi", "agent", "cron", sessionId);
		persistStore = createCronPersistStore(cronDir);
		historyStore = createHistoryStore(cronDir);

		try {
			const tasks = await persistStore.list();
			for (const task of tasks) {
				store.adopt(task);
			}
			if (tasks.length > 0) {
				console.error(
					`[cron-scheduler] rehydrated ${tasks.length} task(s) from ${cronDir}`,
				);
			}
		} catch (err) {
			console.error("[cron-scheduler] rehydration failed:", err);
		}

		scheduler = createCronScheduler({
			clocks: SYSTEM_CLOCKS,
			source: () => store.list(),
			isIdle: () => !busy,
			onFire: (task, { coalescedCount }) => {
				const fireId = generateId();
				const now = Date.now();
				const fireRecord: FireRecord = {
					fireId,
					firedAt: now,
					startedAt: now,
					status: "spawned",
				};
				const updatedTask: CronTask = {
					...task,
					fires: [...(task.fires ?? []), fireRecord],
				};
				store.update(updatedTask);
				if (persistStore) {
					persistStore.write(updatedTask.id, updatedTask).catch(() => {});
				}

				const origin: CronJobOrigin = {
					kind: "cron_job",
					jobId: task.id,
					fireId,
					cron: task.cron,
					recurring: task.recurring !== false,
					coalescedCount,
					stale: Date.now() - task.createdAt > STALE_THRESHOLD_MS,
					executionMode: task.executionMode ?? "sub-agent",
				};
				const xml = renderCronFireXml(origin, task.prompt);
				pi.sendUserMessage(xml, { deliverAs: "steer" });
			},
			removeOneShot: (id) => {
				// One-shot task stays in store until CronReport fires (or /cron delete).
				// The scheduler's `tracked.delete(task.id)` already prevents re-firing.
				debug(`one-shot fired, awaiting CronReport: ${id}`);
			},
			onAdvanceCursor: (taskId, lastFiredAt) => {
				const updated = store.markFired(taskId, lastFiredAt);
				if (updated && persistStore) {
					persistStore.write(taskId, updated).catch(() => {});
				}
			},
		});
		scheduler.start();
	});

	pi.on("session_shutdown", async () => {
		if (scheduler) {
			await scheduler.stop();
			scheduler = null;
		}
		store.clear();
		persistStore = null;
		historyStore = null;
	});

	// ── Slash command ────────────────────────────────────────────

	async function archiveAndRemove(
		taskId: string,
		status: HistoryStatus,
	): Promise<void> {
		const task = store.get(taskId);
		if (!task) return;

		const entry: HistoryEntry = {
			id: task.id,
			cron: task.cron,
			prompt: task.prompt,
			recurring: task.recurring,
			createdAt: task.createdAt,
			endTime: Date.now(),
			status,
			fires: task.fires ?? [],
			logFile: task.fires?.[task.fires.length - 1]?.logFile,
		};

		if (historyStore) {
			try {
				await historyStore.archive(entry);
			} catch (err) {
				console.error("[cron-scheduler] archive failed:", err);
			}
		}

		store.remove([taskId]);
		if (persistStore) {
			persistStore.remove(taskId).catch(() => {});
		}
	}

	function describeTask(task: CronTask): string {
		const recur = task.recurring !== false ? "↻ recurring" : "→ one-shot";
		const mode = task.executionMode ?? "sub-agent";
		const fired = task.lastFiredAt > 0 ? new Date(task.lastFiredAt).toISOString() : "never";
		const next = (() => {
			try {
				const parsed = parseCronExpression(task.cron);
				const baseline = task.lastFiredAt > 0 ? task.lastFiredAt : Date.now();
				const nextMs = computeNextCronRun(parsed, baseline);
				return nextMs !== null ? new Date(nextMs).toISOString() : "—";
			} catch {
				return "invalid";
			}
		})();
		const firesCount = task.fires?.length ?? 0;
		return `${task.id}  ${recur}  ${task.cron}  mode=${mode}\n  prompt: ${task.prompt}\n  last: ${fired}  |  next: ${next}  |  fires: ${firesCount}`;
	}

	pi.registerCommand("cron", {
		description:
			'Manage cron tasks: /cron list | create "<cron>" "<prompt>" [-r|--once] | delete <id> | history [N] | fires <id> | help',
		handler: async (args, ctx) => {
			const tokens = tokenizeArgs(args);
			const sub = (tokens[0] || "list").toLowerCase();

			if (sub === "list" || sub === "ls") {
				const tasks = store.list();
				if (tasks.length === 0) {
					ctx.ui.notify("No cron tasks.", "info");
					return;
				}
				const body = tasks.map(describeTask).join("\n\n");
				ctx.ui.notify(`${tasks.length} task(s):\n\n${body}`, "info");
				return;
			}

			if (sub === "create" || sub === "add") {
				if (tokens.length < 3) {
					ctx.ui.notify(
						'Usage: /cron create "<cron>" "<prompt>" [-r|--once] [--main|--sub-agent]',
						"error",
					);
					return;
				}
				const cron = tokens[1];
				const prompt = tokens[2];
				const flagTokens = tokens.slice(3);
				let recurring = true;
				let executionMode: ExecutionMode = "sub-agent";
				for (const flag of flagTokens) {
					if (flag === "-r") recurring = true;
					else if (flag === "--once") recurring = false;
					else if (flag === "--main") executionMode = "main";
					else if (flag === "--sub-agent") executionMode = "sub-agent";
					else {
						ctx.ui.notify(`Unknown flag: ${flag}`, "error");
						return;
					}
				}
				try {
					parseCronExpression(cron);
				} catch (err) {
					ctx.ui.notify(`Invalid cron: ${cron} — ${(err as Error).message}`, "error");
					return;
				}
				if (!persistStore) {
					ctx.ui.notify("Session not initialized yet — try again in a moment", "error");
					return;
				}
				const task = store.add({ cron, prompt, recurring, executionMode });
				persistStore.write(task.id, task).catch(() => {});
				ctx.ui.notify(
					`Created ${task.id}: ${cron}${recurring ? " (recurring)" : " (one-shot)"} mode=${executionMode}`,
					"info",
				);
				return;
			}

			if (sub === "delete" || sub === "rm") {
				const id = tokens[1];
				if (!id) {
					ctx.ui.notify("Usage: /cron delete <id>", "error");
					return;
				}
				if (!SessionCronStore.isValidId(id)) {
					ctx.ui.notify(`Invalid id format: ${id}`, "error");
					return;
				}
				const existing = store.get(id);
				if (!existing) {
					ctx.ui.notify(`No task with id ${id}`, "error");
					return;
				}
				await archiveAndRemove(id, "cancelled");
				ctx.ui.notify(`Deleted ${id} (archived to history)`, "info");
				return;
			}

			if (sub === "history") {
				const limitArg = parseInt(tokens[1] ?? "10", 10);
				const limit = Number.isFinite(limitArg) && limitArg > 0 ? Math.min(limitArg, MAX_HISTORY_ENTRIES) : 10;
				if (!historyStore) {
					ctx.ui.notify("Session not initialized yet — try again in a moment", "error");
					return;
				}
				const entries = await historyStore.list(limit);
				if (entries.length === 0) {
					ctx.ui.notify("No cron history yet.", "info");
					return;
				}
				const body = entries
					.map((e) => {
						const recur = e.recurring !== false ? "↻" : "→";
						const lastFire = e.fires[e.fires.length - 1];
						const lastStatus = lastFire?.status ?? "—";
						const summary = lastFire?.summary ? `\n    Summary: ${lastFire.summary.split("\n")[0].slice(0, 120)}` : "";
						return (
							`${e.id}  ${recur} ${e.cron}  status=${e.status}\n` +
							`    Created: ${new Date(e.createdAt).toISOString()}  |  Ended: ${new Date(e.endTime).toISOString()}\n` +
							`    Fires: ${e.fires.length}  |  Last: ${lastStatus}${summary}\n` +
							`    Log: ${e.logFile ?? "—"}`
						);
					})
					.join("\n\n");
				ctx.ui.notify(`History (most recent ${entries.length}, cap ${MAX_HISTORY_ENTRIES}):\n\n${body}`, "info");
				return;
			}

			if (sub === "fires") {
				const id = tokens[1];
				if (!id) {
					ctx.ui.notify("Usage: /cron fires <taskId>   (active task) or   /cron fires history:<taskId>   (archived)", "error");
					return;
				}
				const task = store.get(id);
				if (task) {
					const fires = task.fires ?? [];
					if (fires.length === 0) {
						ctx.ui.notify(`Active task ${id} has no fires yet.`, "info");
						return;
					}
					const body = fires
						.map((f) =>
							`fire ${f.fireId}\n` +
							`    firedAt:   ${new Date(f.firedAt).toISOString()}\n` +
							`    startedAt: ${new Date(f.startedAt).toISOString()}\n` +
							`    endedAt:   ${f.endedAt ? new Date(f.endedAt).toISOString() : "—"}\n` +
							`    status:    ${f.status}\n` +
							`    agentId:   ${f.agentId ?? "—"}\n` +
							`    logFile:   ${f.logFile ?? "—"}\n` +
							`    summary:   ${f.summary ?? "—"}${f.error ? `\n    error:     ${f.error}` : ""}`,
						)
						.join("\n\n");
					ctx.ui.notify(`Fires for active task ${id}:\n\n${body}`, "info");
					return;
				}
				if (!historyStore) {
					ctx.ui.notify(`No task with id ${id} (active) and history not ready.`, "error");
					return;
				}
				const entry = await historyStore.get(id);
				if (!entry) {
					ctx.ui.notify(`No task with id ${id} (not in active store or history).`, "error");
					return;
				}
				const body = entry.fires
					.map((f) =>
						`fire ${f.fireId}  status=${f.status}\n` +
						`    firedAt: ${new Date(f.firedAt).toISOString()}  |  endedAt: ${f.endedAt ? new Date(f.endedAt).toISOString() : "—"}\n` +
						`    summary: ${f.summary ?? "—"}${f.error ? `\n    error:   ${f.error}` : ""}`,
					)
					.join("\n\n");
				ctx.ui.notify(`Fires for archived task ${id} (${entry.status}):\n\n${body}`, "info");
				return;
			}

			if (sub === "help" || sub === "?") {
				ctx.ui.notify(
					"Manage cron tasks:\n" +
						"  /cron list                       — show all active tasks\n" +
						'  /cron create "<cron>" "<prompt>" [-r|--once] [--main|--sub-agent]\n' +
						"    default mode is sub-agent (background); --main runs in current session\n" +
						"  /cron delete <id>                — remove + archive to history\n" +
						"  /cron history [N=10]             — show recent N archived entries (cap 50)\n" +
						"  /cron fires <taskId>             — show all fire records for a task\n" +
						"  /cron help                       — this message",
					"info",
				);
				return;
			}

			ctx.ui.notify(`Unknown subcommand: ${sub}. Try /cron help.`, "error");
		},
	});

	// ── Tools ────────────────────────────────────────────────────

	pi.registerTool({
		name: "CronCreate",
		label: "Cron Create",
		description:
			"Create a scheduled task. **Agent-first:** LLM calls this tool directly. " +
			'**Human users:** describe in natural language (e.g., "每周一9点生成周报" / "every day at 6pm check build status") ' +
			"and the LLM will translate to a cron expression. " +
			"Injects a prompt into the conversation on a recurring schedule using standard 5-field cron syntax: " +
			"minute hour day-of-month month day-of-week. " +
			"Tasks only fire while Pi is running. On restart, tasks resume from their last fire time. " +
			"For continuous watchdog / monitoring patterns (context-overflow guard, stuck-loop detection, token-burn rate, build heartbeat, disk pressure), read WATCHDOG.md in this extension's directory BEFORE creating long-running watchdogs — it has proven templates, anti-patterns, and a starter kit.",
		parameters: Type.Object({
			cron: Type.String({
				description:
					'5-field cron expression, e.g. "*/5 * * * *" (every 5 min), "0 9 * * 1-5" (weekdays 9am)',
			}),
			prompt: Type.String({
				description: "The prompt text to inject when the task fires",
			}),
			recurring: Type.Optional(
				Type.Boolean({
					description:
						"Whether the task repeats after firing (default: true). Set false for one-shot.",
				}),
			),
			executionMode: Type.Optional(
				Type.Union([Type.Literal("main"), Type.Literal("sub-agent")], {
					description:
						'How the task runs when fired. "sub-agent" (default): main agent spawns a background sub-agent via Agent tool; sub-agent cannot access other sub-agents or Agent/steer_subagent tools — isolated. "main": main agent handles the prompt directly in current session; has full access to all tools and session state. Use "main" when the prompt needs to query other running sub-agents or session state. If omitted, the LLM caller should decide based on prompt semantics and pass the value explicitly.',
				}),
			),
		}),
		async execute(
			_toolCallId,
			params,
		): Promise<AgentToolResult<{ taskId?: string; nextFire?: string }>> {
			try {
				parseCronExpression(params.cron);
			} catch (err) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Invalid cron expression: ${(err as Error).message}`,
						},
					],
					details: {},
				};
			}

			const task = store.add({
				cron: params.cron,
				prompt: params.prompt,
				recurring: params.recurring,
				executionMode: params.executionMode,
			});

			if (persistStore) {
				try {
					await persistStore.write(task.id, task);
				} catch (err) {
					console.error("[cron-scheduler] persist failed:", err);
				}
			}

			const parsed = parseCronExpression(task.cron);
			const nextFire = computeNextCronRun(parsed, Date.now());
			const nextFireStr = nextFire ? new Date(nextFire).toISOString() : "never";

			return {
				content: [
					{
						type: "text" as const,
						text: [
							`Created cron task ${task.id}`,
							`  Schedule: ${task.cron} (${cronToHuman(task.cron)})`,
							`  Prompt: ${task.prompt}`,
							`  Recurring: ${task.recurring !== false}`,
							`  Execution mode: ${task.executionMode ?? "sub-agent"}`,
							`  Next fire: ${nextFireStr}`,
						].join("\n"),
					},
				],
				details: { taskId: task.id, nextFire: nextFireStr },
			};
		},
	});

	pi.registerTool({
		name: "CronDelete",
		label: "Cron Delete",
		description:
			"Delete a scheduled task by its id. **Agent-first:** LLM calls this tool directly with the task id. " +
			'**Human users:** say which task to remove in natural language (e.g., "删掉那个周报任务" / "cancel the build check task") ' +
			"and the LLM will resolve the id (via CronList if needed) and call this tool.",
		parameters: Type.Object({
			id: Type.String({
				description: "The 8-character hex id of the task to delete",
			}),
		}),
		async execute(
			_toolCallId,
			params,
		): Promise<AgentToolResult<{ deletedId?: string }>> {
			if (!SessionCronStore.isValidId(params.id)) {
				return {
					content: [
						{
							type: "text" as const,
							text: `Invalid task id format: ${params.id} (expected 8 hex chars)`,
						},
					],
					details: {},
				};
			}

			const removed = store.remove([params.id]);
			if (removed.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `No task found with id: ${params.id}`,
						},
					],
					details: {},
				};
			}

			if (persistStore) {
				persistStore.remove(params.id).catch(() => {});
			}

			return {
				content: [
					{ type: "text" as const, text: `Deleted cron task ${params.id}` },
				],
				details: { deletedId: params.id },
			};
		},
	});

	pi.registerTool({
		name: "CronList",
		label: "Cron List",
		description:
			"List all scheduled tasks with their next fire times. **Agent-first:** LLM calls this tool directly. " +
			'**Human users:** ask in natural language (e.g., "列出我的定时任务" / "list my scheduled tasks") ' +
			"and the LLM will call this tool and summarize the result.",
		parameters: Type.Object({}),
		async execute(): Promise<
			AgentToolResult<{
				tasks: Array<{ id: string; cron: string; nextFire: string | null }>;
			}>
		> {
			const tasks = store.list();

			if (tasks.length === 0) {
				return {
					content: [
						{ type: "text" as const, text: "No cron tasks scheduled." },
					],
					details: { tasks: [] },
				};
			}

			const lines: string[] = [`${tasks.length} cron task(s):`, ""];
			const taskDetails: Array<{
				id: string;
				cron: string;
				nextFire: string | null;
			}> = [];

			for (const task of tasks) {
				let nextFireStr = "invalid cron";
				let nextFire: number | null = null;
				try {
					const parsed = parseCronExpression(task.cron);
					nextFire = computeNextCronRun(parsed, Date.now());
					nextFireStr = nextFire
						? new Date(nextFire).toISOString()
						: "no upcoming fire";
				} catch {
					// keep 'invalid cron'
				}

				lines.push(
					`  ${task.id}  ${task.cron} (${cronToHuman(task.cron)})`,
					`    Prompt: ${task.prompt}`,
					`    Recurring: ${task.recurring !== false}  |  Next: ${nextFireStr}`,
					`    Created: ${new Date(task.createdAt).toISOString()}  |  Last fired: ${task.lastFiredAt > 0 ? new Date(task.lastFiredAt).toISOString() : "never"}`,
					"",
				);

				taskDetails.push({
					id: task.id,
					cron: task.cron,
					nextFire: nextFire ? new Date(nextFire).toISOString() : null,
				});
			}

			return {
				content: [{ type: "text" as const, text: lines.join("\n") }],
				details: { tasks: taskDetails },
			};
		},
	});

	pi.registerTool({
		name: "CronReport",
		label: "Cron Report",
		description:
			"Report the outcome of a cron-fired sub-agent. Updates the fire record, archives one-shot tasks, and clears the active entry. " +
			"Call this after a cron-fired sub-agent completes (you receive a task-notification). " +
			"The summary MUST include the taskId so users can trace the fire back to its cron job history.",
		parameters: Type.Object({
			taskId: Type.String({
				description: "Cron job id (8 hex chars) from <cron_fire><job_id>",
			}),
			fireId: Type.String({
				description: "Fire id (8 hex chars) from <cron_fire><fire_id>",
			}),
			status: Type.Union([Type.Literal("completed"), Type.Literal("failed")]),
			summary: Type.String({
				description:
					"Brief summary of what the sub-agent did. Include taskId for traceability.",
			}),
			agentId: Type.Optional(
				Type.String({ description: "Sub-agent ID that ran the task" }),
			),
			logFile: Type.Optional(
				Type.String({
					description: "Path to sub-agent output file",
				}),
			),
			error: Type.Optional(
				Type.String({ description: "Error message if status=failed" }),
			),
		}),
		async execute(
			_toolCallId,
			params,
		): Promise<
			AgentToolResult<{
				taskId: string;
				fireId: string;
				archived: boolean;
			}>
		> {
			const task = store.get(params.taskId);
			if (!task) {
				return {
					content: [
						{
							type: "text" as const,
							text: `CronReport: task ${params.taskId} not found in store (may have been deleted).`,
						},
					],
					details: { taskId: params.taskId, fireId: params.fireId, archived: false },
				};
			}

			const fires = task.fires ?? [];
			const fireIdx = fires.findIndex((f) => f.fireId === params.fireId);
			if (fireIdx < 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `CronReport: fire ${params.fireId} not found in task ${params.taskId}.`,
						},
					],
					details: { taskId: params.taskId, fireId: params.fireId, archived: false },
				};
			}

			const now = Date.now();
			const updatedFire: FireRecord = {
				...fires[fireIdx],
				status: params.status,
				endedAt: now,
				agentId: params.agentId ?? fires[fireIdx].agentId,
				logFile: params.logFile ?? fires[fireIdx].logFile,
				summary: params.summary,
				error: params.error,
			};
			const newFires = [...fires];
			newFires[fireIdx] = updatedFire;

			const updatedTask: CronTask = { ...task, fires: newFires };
			store.update(updatedTask);
			if (persistStore) {
				persistStore.write(updatedTask.id, updatedTask).catch(() => {});
			}

			let archived = false;
			if (updatedTask.recurring === false) {
				await archiveAndRemove(
					updatedTask.id,
					params.status === "completed" ? "done" : "failed",
				);
				archived = true;
			}

			return {
				content: [
					{
						type: "text" as const,
						text: [
							`CronReport: task=${params.taskId} fire=${params.fireId} ${params.status}${archived ? " (archived)" : ""}`,
							`Summary: ${params.summary}`,
						].join("\n"),
					},
				],
				details: {
					taskId: params.taskId,
					fireId: params.fireId,
					archived,
				},
			};
		},
	});
}