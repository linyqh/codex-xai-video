import { describe, expect, test } from "bun:test";
import { type FetchFn, generateXaiVideo, type VideoOutcome, type XaiCredentials } from "../src/xai";

const BASE = "https://api.x.ai/v1";
const CDN_URL = "https://vidgen.x.ai/out.mp4";
const VIDEO_BYTES = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);

interface Call {
	method: string;
	url: string;
	auth: string | null;
}

type Reply = Response | Error | (() => Response);

/** Fake xAI: one scripted reply per request, keyed by "METHOD url". */
function fakeXai(script: Record<string, Reply[]>) {
	const calls: Call[] = [];
	const fetchFn: FetchFn = async (url, init) => {
		const method = init?.method ?? "GET";
		calls.push({ method, url, auth: new Headers(init?.headers).get("authorization") });
		init?.signal?.throwIfAborted();
		const reply = script[`${method} ${url}`]?.shift();
		if (!reply) throw new Error(`unscripted request ${method} ${url}`);
		if (reply instanceof Error) throw reply;
		return typeof reply === "function" ? reply() : reply;
	};
	return { calls, fetchFn, submits: () => calls.filter(call => call.method === "POST").length };
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const accepted = () => json({ request_id: "req-1" });
const done = (url = CDN_URL) => json({ status: "done", video: { url }, usage: { cost_in_usd_ticks: 500_000_000 } });
const video = () => new Response(VIDEO_BYTES, { headers: { "content-type": "video/mp4" } });

function credentials(keys: string[] = ["key-1"]): XaiCredentials {
	let current = 0;
	return {
		provider: "xai",
		baseUrl: BASE,
		async getKey(rejected) {
			if (rejected !== undefined && current < keys.length - 1) current++;
			return keys[current];
		},
	};
}

function run(fetchFn: FetchFn, options: { signal?: AbortSignal; creds?: XaiCredentials } = {}): Promise<VideoOutcome> {
	return generateXaiVideo(
		options.creds ?? credentials(),
		{ model: "grok-imagine-video", prompt: "a cat" },
		{ fetch: fetchFn, signal: options.signal, sleep: async () => {}, maxConsecutivePollFailures: 3 },
	);
}

const POLL = `GET ${BASE}/videos/req-1`;
const SUBMIT = `POST ${BASE}/videos/generations`;

describe("generateXaiVideo", () => {
	test("completes with the video bytes and decoded cost, never sending the bearer to the CDN", async () => {
		const xai = fakeXai({ [SUBMIT]: [accepted()], [POLL]: [json({ status: "pending" }), done()], [`GET ${CDN_URL}`]: [video()] });
		const outcome = await run(xai.fetchFn);
		expect(outcome).toMatchObject({ kind: "completed", jobId: "req-1", contentType: "video/mp4", videoUrl: CDN_URL });
		if (outcome.kind !== "completed") throw new Error("unreachable");
		expect([...outcome.video]).toEqual([...VIDEO_BYTES]);
		expect(outcome.costUsd).toBeCloseTo(0.05);
		expect(xai.calls.find(call => call.url === CDN_URL)?.auth).toBeNull();
	});

	test("rides out transient poll failures without resubmitting", async () => {
		const truncated = () => new Response("{\"status\":", { headers: { "content-type": "application/json" } });
		const xai = fakeXai({
			[SUBMIT]: [accepted()],
			[POLL]: [
				new TypeError("socket hang up"),
				json({ error: "busy" }, 503),
				json({ status: "pending" }),
				truncated(),
				json({ error: "slow down" }, 429),
				done(),
			],
			[`GET ${CDN_URL}`]: [video()],
		});
		expect((await run(xai.fetchFn)).kind).toBe("completed");
		expect(xai.submits()).toBe(1);
	});

	test("gives up on a job after the consecutive poll failure budget, reporting its id", async () => {
		const xai = fakeXai({ [SUBMIT]: [accepted()], [POLL]: [json({}, 503), json({}, 502), json({}, 500)] });
		const outcome = await run(xai.fetchFn);
		expect(outcome).toMatchObject({ kind: "job-failed", jobId: "req-1" });
		expect(xai.submits()).toBe(1);
	});

	test("a failed download after completion keeps the recovery URL instead of regenerating", async () => {
		const xai = fakeXai({
			[SUBMIT]: [accepted()],
			[POLL]: [done()],
			[`GET ${CDN_URL}`]: [json({}, 502), json({}, 502), json({}, 502)],
		});
		const outcome = await run(xai.fetchFn);
		expect(outcome).toMatchObject({ kind: "job-failed", jobId: "req-1", videoUrl: CDN_URL });
		expect(xai.submits()).toBe(1);
	});

	test("a 401 while polling rotates the key and keeps polling the same job", async () => {
		const xai = fakeXai({
			[SUBMIT]: [accepted()],
			[POLL]: [json({ error: "expired token" }, 401), done()],
			[`GET ${CDN_URL}`]: [video()],
		});
		const outcome = await run(xai.fetchFn, { creds: credentials(["key-1", "key-2"]) });
		expect(outcome.kind).toBe("completed");
		expect(xai.submits()).toBe(1);
		expect(xai.calls.filter(call => call.url.endsWith("/req-1")).map(call => call.auth)).toEqual([
			"Bearer key-1",
			"Bearer key-2",
		]);
	});

	test("cancelling mid-poll returns the running job's id rather than throwing", async () => {
		const controller = new AbortController();
		const xai = fakeXai({
			[SUBMIT]: [accepted()],
			[POLL]: [
				() => {
					controller.abort();
					return json({ status: "pending" });
				},
			],
		});
		const outcome = await generateXaiVideo(
			credentials(),
			{ model: "grok-imagine-video", prompt: "a cat" },
			{ fetch: xai.fetchFn, signal: controller.signal, pollIntervalMs: 0 },
		);
		expect(outcome).toMatchObject({ kind: "job-failed", jobId: "req-1" });
		if (outcome.kind === "job-failed") expect(outcome.message).toContain("still running");
	});

	test("a terminal job status stops without resubmitting and surfaces xAI's reason", async () => {
		const xai = fakeXai({ [SUBMIT]: [accepted()], [POLL]: [json({ status: "failed", error: { message: "content\tpolicy" } })] });
		const outcome = await run(xai.fetchFn);
		expect(outcome).toMatchObject({ kind: "job-failed", jobId: "req-1", message: "Job failed: content policy." });
	});

	test("a rejected submission creates no job and is never polled", async () => {
		const xai = fakeXai({
			[SUBMIT]: [json({ error: { message: "Text-to-video is not supported for this model." } }, 400)],
		});
		const outcome = await run(xai.fetchFn);
		expect(outcome).toEqual({
			kind: "not-submitted",
			message: "xAI rejected the submission (HTTP 400: Text-to-video is not supported for this model.)",
		});
		expect(xai.calls).toHaveLength(1);
	});
});
