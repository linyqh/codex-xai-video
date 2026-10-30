import { setTimeout as sleepFor } from "node:timers/promises";

export const DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1";

const USD_PER_TICK = 1e-10;
const MAX_MESSAGE_CHARS = 300;
const DOWNLOAD_ATTEMPTS = 3;

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface XaiCredentials {
	provider: string;
	baseUrl: string;
	/** Bearer for the next request; `rejected` is a key the server just answered 401 to. */
	getKey(rejected?: string): Promise<string>;
}

export interface VideoRequest {
	model: string;
	prompt: string;
	duration?: number;
	aspectRatio?: string;
	resolution?: string;
	/** First frame as an https or data URL. */
	imageUrl?: string;
}

export interface RunOptions {
	fetch?: FetchFn;
	signal?: AbortSignal;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	now?: () => number;
	pollIntervalMs?: number;
	maxConsecutivePollFailures?: number;
	deadlineMs?: number;
	onSubmitted?: (jobId: string) => void;
	onProgress?: (jobId: string, status: string, elapsedMs: number) => void;
}

export type VideoOutcome =
	/** The submission was refused or never reached xAI, so no job exists. */
	| { kind: "not-submitted"; message: string }
	| {
			kind: "completed";
			jobId: string;
			video: Uint8Array;
			contentType: string;
			videoUrl: string;
			costUsd?: number;
	  }
	/** A job exists and may bill; the caller must surface it and never resubmit. */
	| { kind: "job-failed"; jobId: string; message: string; videoUrl?: string; costUsd?: number };

export async function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	await sleepFor(ms, undefined, signal && { signal });
}

/** Flatten provider-controlled text into one bounded line. */
export function sanitizeMessage(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > MAX_MESSAGE_CHARS ? `${flat.slice(0, MAX_MESSAGE_CHARS - 1)}…` : flat;
}

async function readErrorMessage(response: Response): Promise<string> {
	let text: string;
	try {
		text = await response.text();
	} catch {
		return `HTTP ${response.status} (unreadable body)`;
	}
	let detail = text;
	try {
		const error = field(JSON.parse(text), "error");
		const message = field(error, "message");
		if (typeof error === "string") detail = error;
		else if (typeof message === "string") detail = message;
	} catch {}
	return `HTTP ${response.status}: ${sanitizeMessage(detail || response.statusText)}`;
}

function isTransientStatus(status: number): boolean {
	return status === 408 || status === 429 || status >= 500;
}

function describeError(error: unknown): string {
	return sanitizeMessage(error instanceof Error ? error.message : String(error));
}

/** Reads one property of untrusted JSON; non-objects and missing keys read as `undefined`. */
function field(value: unknown, key: string): unknown {
	return value !== null && typeof value === "object" ? Reflect.get(value, key) : undefined;
}

function decodeCost(usage: unknown): number | undefined {
	const ticks = field(usage, "cost_in_usd_ticks");
	return typeof ticks === "number" && Number.isFinite(ticks) ? ticks * USD_PER_TICK : undefined;
}

function decodeJobError(raw: unknown): string | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw === "string") return sanitizeMessage(raw);
	const message = field(raw, "message");
	return sanitizeMessage(typeof message === "string" ? message : JSON.stringify(raw));
}

/** One request with the bearer; a 401 re-resolves the key once (every call here is idempotent or pre-commit). */
async function authorizedFetch(
	credentials: XaiCredentials,
	fetchFn: FetchFn,
	url: string,
	init: RequestInit,
	signal?: AbortSignal,
): Promise<Response> {
	const send = (key: string) =>
		fetchFn(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${key}` }, signal });
	const key = await credentials.getKey();
	const response = await send(key);
	if (response.status !== 401) return response;
	const refreshed = await credentials.getKey(key);
	if (refreshed === key) return response;
	await response.body?.cancel();
	return send(refreshed);
}

function encodeRequest(request: VideoRequest): Record<string, unknown> {
	return {
		model: request.model,
		prompt: request.prompt,
		...(request.duration !== undefined && { duration: request.duration }),
		...(request.aspectRatio !== undefined && { aspect_ratio: request.aspectRatio }),
		...(request.resolution !== undefined && { resolution: request.resolution }),
		...(request.imageUrl !== undefined && { image: { url: request.imageUrl } }),
	};
}

type PollResult =
	| { kind: "done"; videoUrl: string; costUsd?: number }
	| { kind: "failed"; message: string; costUsd?: number };

/**
 * Generate one video. Once xAI accepts the submission the job is billing, so
 * every later failure (poll budget, terminal status, download, cancellation)
 * returns `job-failed` with the job id instead of throwing or resubmitting.
 */
export async function generateXaiVideo(
	credentials: XaiCredentials,
	request: VideoRequest,
	options: RunOptions = {},
): Promise<VideoOutcome> {
	const fetchFn = options.fetch ?? fetch;
	const { signal } = options;
	const baseUrl = credentials.baseUrl.replace(/\/+$/, "");

	let submitResponse: Response;
	try {
		submitResponse = await authorizedFetch(
			credentials,
			fetchFn,
			`${baseUrl}/videos/generations`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json", Accept: "application/json" },
				body: JSON.stringify(encodeRequest(request)),
			},
			signal,
		);
	} catch (error) {
		// A rejected fetch overwhelmingly means the request was never accepted; falling through keeps an
		// unreachable endpoint a plain failure rather than a phantom job.
		if (signal?.aborted) return { kind: "not-submitted", message: "Cancelled before xAI confirmed the submission." };
		return { kind: "not-submitted", message: `Submission did not reach xAI: ${describeError(error)}` };
	}
	if (!submitResponse.ok) {
		return { kind: "not-submitted", message: `xAI rejected the submission (${await readErrorMessage(submitResponse)})` };
	}

	// From here on xAI answered 200: a job exists even if its body is unreadable.
	let jobId: string;
	try {
		const requestId = field(await submitResponse.json(), "request_id");
		if (typeof requestId !== "string" || requestId.length === 0) throw new Error("response has no request_id");
		jobId = requestId;
	} catch (error) {
		return {
			kind: "job-failed",
			jobId: "unknown",
			message: `xAI accepted the submission but its response was unreadable (${describeError(error)}); a job may be billing.`,
		};
	}
	options.onSubmitted?.(jobId);

	try {
		const polled = await pollUntilFinished(credentials, fetchFn, baseUrl, jobId, options);
		if (polled.kind === "failed") {
			return { kind: "job-failed", jobId, message: polled.message, costUsd: polled.costUsd };
		}
		return await downloadVideo(credentials, fetchFn, baseUrl, jobId, polled, options);
	} catch (error) {
		if (signal?.aborted) {
			return { kind: "job-failed", jobId, message: "Cancelled while the job was still running on xAI." };
		}
		return { kind: "job-failed", jobId, message: describeError(error) };
	}
}

async function pollUntilFinished(
	credentials: XaiCredentials,
	fetchFn: FetchFn,
	baseUrl: string,
	jobId: string,
	options: RunOptions,
): Promise<PollResult> {
	const sleep = options.sleep ?? abortableSleep;
	const now = options.now ?? Date.now;
	const interval = options.pollIntervalMs ?? 5_000;
	const maxFailures = options.maxConsecutivePollFailures ?? 6;
	const deadline = options.deadlineMs ?? 20 * 60_000;
	const startedAt = now();
	let failures = 0;
	let lastProblem = "";

	const transient = (problem: string): PollResult | undefined => {
		failures++;
		lastProblem = problem;
		return failures >= maxFailures
			? { kind: "failed", message: `Stopped polling after ${failures} consecutive failures (${problem}).` }
			: undefined;
	};

	while (true) {
		const elapsed = now() - startedAt;
		if (elapsed >= deadline) {
			return {
				kind: "failed",
				message: `Still not finished after ${Math.round(elapsed / 60_000)} min${lastProblem ? ` (last problem: ${lastProblem})` : ""}.`,
			};
		}
		await sleep(interval, options.signal);

		let response: Response;
		try {
			response = await authorizedFetch(
				credentials,
				fetchFn,
				`${baseUrl}/videos/${encodeURIComponent(jobId)}`,
				{ headers: { Accept: "application/json" } },
				options.signal,
			);
		} catch (error) {
			options.signal?.throwIfAborted();
			const stop = transient(describeError(error));
			if (stop) return stop;
			continue;
		}
		if (!response.ok) {
			const message = await readErrorMessage(response);
			if (!isTransientStatus(response.status)) return { kind: "failed", message: `Polling failed (${message}).` };
			const stop = transient(message);
			if (stop) return stop;
			continue;
		}
		let body: unknown;
		try {
			body = await response.json();
		} catch (error) {
			options.signal?.throwIfAborted();
			const stop = transient(`unreadable poll body: ${describeError(error)}`);
			if (stop) return stop;
			continue;
		}
		failures = 0;
		lastProblem = "";

		const costUsd = decodeCost(field(body, "usage"));
		const rawStatus = field(body, "status");
		const status = typeof rawStatus === "string" ? rawStatus : "unknown";
		if (status === "done") {
			const url = field(field(body, "video"), "url");
			if (typeof url !== "string" || url.length === 0) {
				return { kind: "failed", message: "Job finished but xAI returned no video URL.", costUsd };
			}
			return { kind: "done", videoUrl: new URL(url, `${baseUrl}/`).href, costUsd };
		}
		if (status === "failed" || status === "expired") {
			const reason = decodeJobError(field(body, "error"));
			return { kind: "failed", message: `Job ${status}${reason ? `: ${reason}` : ""}.`, costUsd };
		}
		// Undocumented states are treated as still running; abandoning a billing job is the worse error.
		options.onProgress?.(jobId, status, now() - startedAt);
	}
}

async function downloadVideo(
	credentials: XaiCredentials,
	fetchFn: FetchFn,
	baseUrl: string,
	jobId: string,
	done: { videoUrl: string; costUsd?: number },
	options: RunOptions,
): Promise<VideoOutcome> {
	const { videoUrl, costUsd } = done;
	const sleep = options.sleep ?? abortableSleep;
	const sameOrigin = new URL(videoUrl).origin === new URL(baseUrl).origin;
	let problem = "";
	for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
		if (attempt > 1) await sleep(2_000 * (attempt - 1), options.signal);
		try {
			const init: RequestInit = { headers: { Accept: "video/*" } };
			// The bearer only goes to xAI's own origin, never to a presigned CDN host.
			const response = sameOrigin
				? await authorizedFetch(credentials, fetchFn, videoUrl, init, options.signal)
				: await fetchFn(videoUrl, { ...init, signal: options.signal });
			if (!response.ok) {
				problem = await readErrorMessage(response);
				if (!isTransientStatus(response.status)) break;
				continue;
			}
			// Buffered so a truncated download never leaves a partial MP4 at the output path.
			const video = new Uint8Array(await response.arrayBuffer());
			const contentType = response.headers.get("content-type") ?? "video/mp4";
			return { kind: "completed", jobId, video, contentType, videoUrl, ...(costUsd !== undefined && { costUsd }) };
		} catch (error) {
			options.signal?.throwIfAborted();
			problem = describeError(error);
		}
	}
	return { kind: "job-failed", jobId, message: `Job finished but the download failed (${problem}).`, videoUrl, costUsd };
}
