import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { configPath, resolveCredentials } from "./credentials";
import { generateXaiVideo, sanitizeMessage, type RunOptions, type XaiCredentials } from "./xai";

const DEFAULT_MODEL = "grok-imagine-video";
/** xAI serves 1080p only as image-to-video on this model. */
const HD_MODEL = "grok-imagine-video-1.5";
const ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"];
const RESOLUTIONS = ["480p", "720p", "1080p"];

export const TOOL_NAME = "xai_generate_video";

export const TOOL_DEFINITION = {
	name: TOOL_NAME,
	title: "xAI Video",
	description: [
		"Generate a short video with xAI Grok Imagine and save it as an MP4 file.",
		"Each call submits a paid generation job (billed per output second); call it once per requested video and never retry a call that reported a job id.",
		"Text-to-video by default; pass `image` to animate a still as the first frame.",
		"On xAI, 1080p is image-to-video only (served by grok-imagine-video-1.5); omitted options use xAI's own defaults.",
		"Codex runs this tool outside the session's working directory, so `output_path` and local `image` paths must be absolute (or start with ~/).",
		"Generation usually takes 20 seconds to a few minutes.",
	].join("\n"),
	inputSchema: {
		type: "object",
		properties: {
			prompt: { type: "string", description: "What the video should show, including motion and camera direction." },
			image: {
				type: "string",
				description:
					"First frame for image-to-video: an https URL, a data URL, or an absolute path to a local PNG/JPEG/WebP file.",
			},
			duration: { type: "integer", minimum: 1, maximum: 15, description: "Length in whole seconds (1-15)." },
			aspect_ratio: { type: "string", enum: ASPECT_RATIOS },
			resolution: { type: "string", enum: RESOLUTIONS },
			model: { type: "string", description: `xAI video model id. Defaults to ${DEFAULT_MODEL}.` },
			output_path: {
				type: "string",
				description: "Absolute path (or ~/...) of the MP4 to write; missing parent folders are created.",
			},
		},
		required: ["prompt", "output_path"],
		additionalProperties: false,
	},
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
} as const;

export interface ToolResult {
	content: { type: "text"; text: string }[];
	isError?: boolean;
}

export interface ToolContext {
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	progress?: (message: string) => void;
	/** Test seam for the xAI client. */
	run?: Pick<RunOptions, "fetch" | "sleep">;
	credentials?: XaiCredentials;
}

interface VideoArgs {
	prompt: string;
	image?: string;
	duration?: number;
	aspect_ratio?: string;
	resolution?: string;
	model?: string;
	output_path: string;
}

function textResult(text: string, isError = false): ToolResult {
	return { content: [{ type: "text", text }], ...(isError && { isError: true }) };
}

function rejected(message: string): ToolResult {
	return textResult(`${message} Nothing was submitted.`, true);
}

/** MCP clients are not required to enforce inputSchema, so arguments are checked here before anything bills. */
function parseArgs(raw: unknown): VideoArgs | string {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return "arguments must be an object.";
	const args = raw as Record<string, unknown>;
	const known = new Set(Object.keys(TOOL_DEFINITION.inputSchema.properties));
	const unknown = Object.keys(args).filter(key => !known.has(key));
	if (unknown.length > 0) return `unknown argument(s): ${unknown.join(", ")}.`;
	if (typeof args.prompt !== "string" || args.prompt.trim() === "") return "prompt must be a non-empty string.";
	if (typeof args.output_path !== "string") return "output_path is required: an absolute path for the MP4.";
	for (const key of ["image", "model", "aspect_ratio", "resolution"] as const) {
		if (args[key] !== undefined && typeof args[key] !== "string") return `${key} must be a string.`;
	}
	const { duration, aspect_ratio, resolution } = args;
	if (duration !== undefined && (!Number.isInteger(duration) || (duration as number) < 1 || (duration as number) > 15)) {
		return "duration must be a whole number of seconds from 1 to 15.";
	}
	if (aspect_ratio !== undefined && !ASPECT_RATIOS.includes(aspect_ratio as string)) {
		return `aspect_ratio must be one of ${ASPECT_RATIOS.join(", ")}.`;
	}
	if (resolution !== undefined && !RESOLUTIONS.includes(resolution as string)) {
		return `resolution must be one of ${RESOLUTIONS.join(", ")}.`;
	}
	return args as unknown as VideoArgs;
}

/** Returns undefined for relative paths: the server's own cwd is the plugin folder, not the session's. */
function absolutePath(input: string): string | undefined {
	if (input === "~" || input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
	return path.isAbsolute(input) ? path.normalize(input) : undefined;
}

function sniffImageMime(bytes: Uint8Array): string | undefined {
	if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
	if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
	const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
	if (bytes.length >= 12 && tag(0) === "RIFF" && tag(8) === "WEBP") return "image/webp";
	return undefined;
}

/** Turns the `image` argument into a URL xAI accepts: https as-is, local files inlined as data URLs. */
async function resolveImage(input: string): Promise<string> {
	if (/^https?:\/\//i.test(input)) return input;
	if (input.startsWith("data:")) {
		if (/^data:image\/(png|jpeg|webp);base64,/i.test(input)) return input;
		throw new Error("image data URLs must be base64 PNG, JPEG, or WebP");
	}
	const file = absolutePath(input);
	if (!file) throw new Error(`image path must be absolute (or start with ~/), got ${input}`);
	let bytes: Buffer;
	try {
		bytes = await fs.readFile(file);
	} catch (error) {
		throw new Error(`cannot read image ${file}: ${sanitizeMessage(String(error))}`);
	}
	const mime = sniffImageMime(bytes);
	if (!mime) throw new Error(`image ${file} is not a PNG, JPEG, or WebP file`);
	return `data:${mime};base64,${bytes.toString("base64")}`;
}

export async function generateVideoTool(rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
	const args = parseArgs(rawArgs);
	if (typeof args === "string") return rejected(args);

	let model = args.model;
	if (!model && args.resolution === "1080p") {
		if (!args.image) return rejected("1080p on xAI is image-to-video only; pass `image` or choose 720p.");
		model = HD_MODEL;
	}
	model ??= DEFAULT_MODEL;

	if (args.output_path.trim() === "" || /[/\\]$/.test(args.output_path)) {
		return rejected("output_path must name a file, not a directory.");
	}
	const target = absolutePath(args.output_path);
	if (!target) return rejected(`output_path must be absolute (or start with ~/), got ${args.output_path}.`);
	const existing = await fs.stat(target).catch(() => undefined);
	if (existing?.isDirectory()) return rejected(`output_path ${target} is a directory.`);

	let imageUrl: string | undefined;
	try {
		imageUrl = args.image === undefined ? undefined : await resolveImage(args.image);
	} catch (error) {
		return rejected(`${(error as Error).message}.`);
	}

	let credentials = ctx.credentials;
	try {
		credentials ??= await resolveCredentials(ctx.env, ctx.signal);
	} catch (error) {
		return rejected(`xAI credentials could not be loaded: ${(error as Error).message}.`);
	}
	if (!credentials) {
		return rejected(
			`No xAI credentials are configured: set apiKey in ${configPath(ctx.env)} or export XAI_API_KEY.`,
		);
	}

	const startedAt = Date.now();
	const outcome = await generateXaiVideo(
		credentials,
		{
			model,
			prompt: args.prompt,
			duration: args.duration,
			aspectRatio: args.aspect_ratio,
			resolution: args.resolution,
			imageUrl,
		},
		{
			...ctx.run,
			signal: ctx.signal,
			onSubmitted: jobId => ctx.progress?.(`xAI job ${jobId} submitted; generating…`),
			onProgress: (jobId, status, elapsedMs) =>
				ctx.progress?.(`xAI job ${jobId}: ${sanitizeMessage(status)} (${Math.round(elapsedMs / 1000)}s)`),
		},
	);

	if (outcome.kind === "not-submitted") return textResult(`${outcome.message} No job was created.`, true);
	const cost = outcome.costUsd === undefined ? "" : ` Cost: $${outcome.costUsd.toFixed(4)}.`;
	if (outcome.kind === "job-failed") {
		const recovery = outcome.videoUrl ? ` The video is still downloadable at ${outcome.videoUrl}` : "";
		return textResult(
			`xAI job ${outcome.jobId} did not produce a saved video: ${outcome.message}${recovery}${cost} It was not resubmitted, to avoid a second charge.`,
			true,
		);
	}

	try {
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.writeFile(target, outcome.video);
	} catch (error) {
		const reason = sanitizeMessage(String(error)).replaceAll(os.homedir(), "~");
		return textResult(
			`xAI job ${outcome.jobId} finished but writing ${target} failed (${reason}). The video is still downloadable at ${outcome.videoUrl}${cost}`,
			true,
		);
	}
	const seconds = Math.round((Date.now() - startedAt) / 1000);
	const megabytes = (outcome.video.byteLength / 1_048_576).toFixed(1);
	return textResult(
		`Generated video with ${credentials.provider}/${model} (job ${outcome.jobId}) in ${seconds}s. Saved to ${target} (${megabytes} MB, ${outcome.contentType}).${cost}`,
	);
}
