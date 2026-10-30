import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { DEFAULT_XAI_BASE_URL, sanitizeMessage, type XaiCredentials } from "./xai";

const run = promisify(execFile);
const KEY_COMMAND_TIMEOUT_MS = 30_000;

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
	return path.join(env.CODEX_HOME || path.join(os.homedir(), ".codex"), "xai-video.json");
}

interface VideoConfig {
	baseUrl?: string;
	apiKey?: string;
}

async function readConfig(file: string): Promise<VideoConfig | undefined> {
	let text: string;
	try {
		text = await fs.readFile(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(`cannot read ${file}: ${sanitizeMessage(String(error))}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`${file} is not valid JSON: ${sanitizeMessage(String(error))}`);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${file} must contain a JSON object`);
	}
	const { baseUrl, apiKey } = parsed as Record<string, unknown>;
	if (baseUrl !== undefined && (typeof baseUrl !== "string" || !/^https?:\/\/[^/]/i.test(baseUrl))) {
		throw new Error(`${file}: baseUrl must be an http(s) URL`);
	}
	if (apiKey !== undefined && typeof apiKey !== "string") throw new Error(`${file}: apiKey must be a string`);
	return { baseUrl, apiKey };
}

/** `!cmd` runs a shell command (e.g. a password manager) and uses its trimmed stdout; anything else is the key itself. */
async function resolveKey(spec: string, signal?: AbortSignal): Promise<string> {
	if (!spec.startsWith("!")) return spec;
	let stdout: string;
	try {
		({ stdout } = await run("/bin/sh", ["-c", spec.slice(1)], { timeout: KEY_COMMAND_TIMEOUT_MS, signal }));
	} catch (error) {
		throw new Error(`apiKey command failed: ${sanitizeMessage(String((error as Error).message ?? error))}`);
	}
	const key = stdout.trim();
	if (!key) throw new Error("apiKey command printed nothing");
	return key;
}

/**
 * The config file wins so a relay or a dedicated key can serve video without touching XAI_API_KEY;
 * a config without apiKey is skipped, matching an unconfigured provider.
 */
export async function resolveCredentials(
	env: NodeJS.ProcessEnv = process.env,
	signal?: AbortSignal,
): Promise<XaiCredentials | undefined> {
	const file = configPath(env);
	const config = await readConfig(file);
	if (config?.apiKey?.trim()) {
		const spec = config.apiKey.trim();
		const first = await resolveKey(spec, signal);
		return {
			provider: "xai-video",
			baseUrl: config.baseUrl ?? DEFAULT_XAI_BASE_URL,
			// Re-running the command after a 401 picks up a rotated key; a literal key cannot change.
			getKey: async rejected => (rejected === undefined ? first : resolveKey(spec, signal)),
		};
	}
	const envKey = env.XAI_API_KEY?.trim();
	if (envKey) return { provider: "xai", baseUrl: DEFAULT_XAI_BASE_URL, getKey: async () => envKey };
	return undefined;
}
