/**
 * Append-only JSONL run log, written to `manifest.log` in the run directory.
 *
 * The TUI's event log is an in-memory ring buffer that dies with the process —
 * fine while you are watching, useless afterwards, and useless precisely when
 * a run fails and you want to know why. This is the durable copy.
 *
 * The Python helper allocates the path and makes `logs/` (ADR-0003: it owns
 * every path and mkdir for a run). The coordinator owns the byte stream,
 * because a subprocess per log line would cost more than the review.
 *
 * Everything here is best-effort: a review must never fail because logging
 * failed. Write errors are latched and reported once via `error`, not thrown.
 */

import * as fs from "node:fs";

// biome-ignore lint/suspicious/noExplicitAny: log payloads are arbitrary JSON
type Any = any;

export type LogLevel = "info" | "warn" | "error";

export interface LogRecord {
	ts: string;
	level: LogLevel;
	event: string;
	agent?: string;
	role?: string;
	phase?: string;
	[k: string]: Any;
}

export interface RunLogOptions {
	/** Injected for tests; defaults to a real append stream. */
	sink?: (line: string) => void;
	/** Injected for tests so records are deterministic. */
	now?: () => Date;
}

export class RunLog {
	private stream: fs.WriteStream | null = null;
	private readonly sink: (line: string) => void;
	private readonly now: () => Date;
	private failure: string | null = null;

	constructor(path: string | null, opts: RunLogOptions = {}) {
		this.now = opts.now ?? (() => new Date());
		if (opts.sink) {
			this.sink = opts.sink;
			return;
		}
		if (!path) {
			this.sink = () => {};
			return;
		}
		try {
			this.stream = fs.createWriteStream(path, { flags: "a" });
			// An EPIPE/ENOSPC on the stream must not become an unhandled 'error'
			// event and take the process down mid-review.
			this.stream.on("error", (err) => {
				this.failure ??= err.message;
			});
			this.sink = (line) => this.stream?.write(line);
		} catch (err) {
			this.failure = err instanceof Error ? err.message : String(err);
			this.sink = () => {};
		}
	}

	/** Why logging is degraded, or null if it is working. */
	get error(): string | null {
		return this.failure;
	}

	append(level: LogLevel, event: string, fields: Record<string, Any> = {}): void {
		if (this.failure) return;
		const record: LogRecord = { ts: this.now().toISOString(), level, event, ...fields };
		let line: string;
		try {
			line = `${JSON.stringify(record)}\n`;
		} catch {
			// A circular or otherwise unserializable field must not kill the run.
			line = `${JSON.stringify({ ts: record.ts, level, event, note: "fields dropped (unserializable)" })}\n`;
		}
		try {
			this.sink(line);
		} catch (err) {
			this.failure = err instanceof Error ? err.message : String(err);
		}
	}

	info(event: string, fields?: Record<string, Any>): void {
		this.append("info", event, fields);
	}

	warn(event: string, fields?: Record<string, Any>): void {
		this.append("warn", event, fields);
	}

	/** Records an Error's message and stack under stable keys. */
	fail(event: string, err: unknown, fields: Record<string, Any> = {}): void {
		const e = err instanceof Error ? err : undefined;
		this.append("error", event, { ...fields, message: e?.message ?? String(err), stack: e?.stack });
	}

	/** Flush and close. Safe to call more than once. */
	async close(): Promise<void> {
		const s = this.stream;
		this.stream = null;
		if (!s) return;
		await new Promise<void>((resolve) => s.end(resolve));
	}
}

/** A no-op log, for call sites that may run without a run directory. */
export const NULL_LOG = new RunLog(null);
