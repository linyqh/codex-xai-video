import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveCredentials } from "../src/credentials";
import { generateVideoTool } from "../src/tool";
import type { FetchFn } from "../src/xai";

let home: string;
beforeEach(async () => {
	home = await fs.mkdtemp(path.join(os.tmpdir(), "xai-video-"));
});
afterEach(() => fs.rm(home, { recursive: true, force: true }));

const writeConfig = (config: unknown) => fs.writeFile(path.join(home, "xai-video.json"), JSON.stringify(config));

describe("resolveCredentials", () => {
	test("the config file wins over XAI_API_KEY and carries its relay baseUrl", async () => {
		await writeConfig({ baseUrl: "https://relay.example.com/v1", apiKey: "relay-key" });
		const creds = await resolveCredentials({ CODEX_HOME: home, XAI_API_KEY: "env-key" });
		expect(creds).toMatchObject({ provider: "xai-video", baseUrl: "https://relay.example.com/v1" });
		expect(await creds?.getKey()).toBe("relay-key");
	});

	test("a config without apiKey falls back to XAI_API_KEY on the official endpoint", async () => {
		await writeConfig({ baseUrl: "https://relay.example.com/v1" });
		const creds = await resolveCredentials({ CODEX_HOME: home, XAI_API_KEY: "env-key" });
		expect(creds).toMatchObject({ provider: "xai", baseUrl: "https://api.x.ai/v1" });
		expect(await creds?.getKey()).toBe("env-key");
	});

	test("a !command key is re-run after a 401 so a rotated key is picked up", async () => {
		const counter = path.join(home, "n");
		await writeConfig({ apiKey: `!echo x >> ${counter}; echo key-$(wc -l < ${counter} | tr -d ' ')` });
		const creds = await resolveCredentials({ CODEX_HOME: home });
		expect(await creds?.getKey()).toBe("key-1");
		expect(await creds?.getKey()).toBe("key-1");
		expect(await creds?.getKey("key-1")).toBe("key-2");
	});

	test("nothing configured yields no credentials", async () => {
		expect(await resolveCredentials({ CODEX_HOME: home })).toBeUndefined();
	});
});

describe("generateVideoTool", () => {
	const noNetwork: FetchFn = async url => {
		throw new Error(`unexpected request to ${url}`);
	};
	const ctx = () => ({
		env: { CODEX_HOME: home, XAI_API_KEY: "k" },
		run: { fetch: noNetwork, sleep: async () => {} },
	});
	const out = "/nonexistent-xai-video/out.mp4";

	test.each([
		[{ prompt: "cat", output_path: out, resolution: "1080p" }, "image-to-video only"],
		[{ prompt: "cat", output_path: out, duration: 30 }, "duration must be"],
		[{ prompt: "cat" }, "output_path is required"],
		[{ prompt: "cat", output_path: "/tmp/" }, "must name a file"],
		[{ prompt: "cat", output_path: "clips/cat.mp4" }, "must be absolute"],
		[{ prompt: "cat", output_path: out, image: "cat.png" }, "must be absolute"],
		[{ prompt: "cat", output_path: out, image: "/nonexistent-xai-video/cat.png" }, "cannot read image"],
		[{ prompt: "cat", output_path: out, extra: 1 }, "unknown argument"],
	])("refuses %j before submitting", async (args, reason) => {
		const result = await generateVideoTool(args, ctx());
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain(reason);
		expect(result.content[0].text).toContain("Nothing was submitted");
	});

	test("missing credentials name the config file and env var", async () => {
		const result = await generateVideoTool({ prompt: "cat", output_path: out }, { ...ctx(), env: { CODEX_HOME: home } });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("XAI_API_KEY");
	});

	test("saves the video at the absolute output path, creating parent folders", async () => {
		const fetchFn: FetchFn = async (url, init) => {
			if (init?.method === "POST") return Response.json({ request_id: "job/1" });
			if (url.endsWith("/videos/job%2F1")) return Response.json({ status: "done", video: { url: "https://cdn.test/v.mp4" } });
			return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "video/mp4" } });
		};
		const result = await generateVideoTool(
			{ prompt: "cat", output_path: path.join(home, "clips/cat.mp4") },
			{ ...ctx(), run: { fetch: fetchFn, sleep: async () => {} } },
		);
		expect(result.isError).toBeUndefined();
		expect(result.content[0].text).toContain(`Saved to ${path.join(home, "clips/cat.mp4")}`);
		expect([...(await fs.readFile(path.join(home, "clips/cat.mp4")))]).toEqual([1, 2, 3]);
	});
});
