// src/server.ts
import * as readline from "node:readline";

// src/tool.ts
import * as fs2 from "node:fs/promises";
import * as os2 from "node:os";
import * as path2 from "node:path";

// src/credentials.ts
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

// src/xai.ts
import { setTimeout as sleepFor } from "node:timers/promises";
var DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1";
var USD_PER_TICK = 0.0000000001;
var MAX_MESSAGE_CHARS = 300;
var DOWNLOAD_ATTEMPTS = 3;
async function abortableSleep(ms, signal) {
  await sleepFor(ms, undefined, signal && { signal });
}
function sanitizeMessage(text) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_MESSAGE_CHARS ? `${flat.slice(0, MAX_MESSAGE_CHARS - 1)}…` : flat;
}
async function readErrorMessage(response) {
  let text;
  try {
    text = await response.text();
  } catch {
    return `HTTP ${response.status} (unreadable body)`;
  }
  let detail = text;
  try {
    const error = field(JSON.parse(text), "error");
    const message = field(error, "message");
    if (typeof error === "string")
      detail = error;
    else if (typeof message === "string")
      detail = message;
  } catch {}
  return `HTTP ${response.status}: ${sanitizeMessage(detail || response.statusText)}`;
}
function isTransientStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}
function describeError(error) {
  return sanitizeMessage(error instanceof Error ? error.message : String(error));
}
function field(value, key) {
  return value !== null && typeof value === "object" ? Reflect.get(value, key) : undefined;
}
function decodeCost(usage) {
  const ticks = field(usage, "cost_in_usd_ticks");
  return typeof ticks === "number" && Number.isFinite(ticks) ? ticks * USD_PER_TICK : undefined;
}
function decodeJobError(raw) {
  if (raw === undefined || raw === null)
    return;
  if (typeof raw === "string")
    return sanitizeMessage(raw);
  const message = field(raw, "message");
  return sanitizeMessage(typeof message === "string" ? message : JSON.stringify(raw));
}
async function authorizedFetch(credentials, fetchFn, url, init, signal) {
  const send = (key) => fetchFn(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${key}` }, signal });
  const key = await credentials.getKey();
  const response = await send(key);
  if (response.status !== 401)
    return response;
  const refreshed = await credentials.getKey(key);
  if (refreshed === key)
    return response;
  await response.body?.cancel();
  return send(refreshed);
}
function encodeRequest(request) {
  return {
    model: request.model,
    prompt: request.prompt,
    ...request.duration !== undefined && { duration: request.duration },
    ...request.aspectRatio !== undefined && { aspect_ratio: request.aspectRatio },
    ...request.resolution !== undefined && { resolution: request.resolution },
    ...request.imageUrl !== undefined && { image: { url: request.imageUrl } }
  };
}
async function generateXaiVideo(credentials, request, options = {}) {
  const fetchFn = options.fetch ?? fetch;
  const { signal } = options;
  const baseUrl = credentials.baseUrl.replace(/\/+$/, "");
  let submitResponse;
  try {
    submitResponse = await authorizedFetch(credentials, fetchFn, `${baseUrl}/videos/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(encodeRequest(request))
    }, signal);
  } catch (error) {
    if (signal?.aborted)
      return { kind: "not-submitted", message: "Cancelled before xAI confirmed the submission." };
    return { kind: "not-submitted", message: `Submission did not reach xAI: ${describeError(error)}` };
  }
  if (!submitResponse.ok) {
    return { kind: "not-submitted", message: `xAI rejected the submission (${await readErrorMessage(submitResponse)})` };
  }
  let jobId;
  try {
    const requestId = field(await submitResponse.json(), "request_id");
    if (typeof requestId !== "string" || requestId.length === 0)
      throw new Error("response has no request_id");
    jobId = requestId;
  } catch (error) {
    return {
      kind: "job-failed",
      jobId: "unknown",
      message: `xAI accepted the submission but its response was unreadable (${describeError(error)}); a job may be billing.`
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
async function pollUntilFinished(credentials, fetchFn, baseUrl, jobId, options) {
  const sleep = options.sleep ?? abortableSleep;
  const now = options.now ?? Date.now;
  const interval = options.pollIntervalMs ?? 5000;
  const maxFailures = options.maxConsecutivePollFailures ?? 6;
  const deadline = options.deadlineMs ?? 20 * 60000;
  const startedAt = now();
  let failures = 0;
  let lastProblem = "";
  const transient = (problem) => {
    failures++;
    lastProblem = problem;
    return failures >= maxFailures ? { kind: "failed", message: `Stopped polling after ${failures} consecutive failures (${problem}).` } : undefined;
  };
  while (true) {
    const elapsed = now() - startedAt;
    if (elapsed >= deadline) {
      return {
        kind: "failed",
        message: `Still not finished after ${Math.round(elapsed / 60000)} min${lastProblem ? ` (last problem: ${lastProblem})` : ""}.`
      };
    }
    await sleep(interval, options.signal);
    let response;
    try {
      response = await authorizedFetch(credentials, fetchFn, `${baseUrl}/videos/${encodeURIComponent(jobId)}`, { headers: { Accept: "application/json" } }, options.signal);
    } catch (error) {
      options.signal?.throwIfAborted();
      const stop = transient(describeError(error));
      if (stop)
        return stop;
      continue;
    }
    if (!response.ok) {
      const message = await readErrorMessage(response);
      if (!isTransientStatus(response.status))
        return { kind: "failed", message: `Polling failed (${message}).` };
      const stop = transient(message);
      if (stop)
        return stop;
      continue;
    }
    let body;
    try {
      body = await response.json();
    } catch (error) {
      options.signal?.throwIfAborted();
      const stop = transient(`unreadable poll body: ${describeError(error)}`);
      if (stop)
        return stop;
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
    options.onProgress?.(jobId, status, now() - startedAt);
  }
}
async function downloadVideo(credentials, fetchFn, baseUrl, jobId, done, options) {
  const { videoUrl, costUsd } = done;
  const sleep = options.sleep ?? abortableSleep;
  const sameOrigin = new URL(videoUrl).origin === new URL(baseUrl).origin;
  let problem = "";
  for (let attempt = 1;attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
    if (attempt > 1)
      await sleep(2000 * (attempt - 1), options.signal);
    try {
      const init = { headers: { Accept: "video/*" } };
      const response = sameOrigin ? await authorizedFetch(credentials, fetchFn, videoUrl, init, options.signal) : await fetchFn(videoUrl, { ...init, signal: options.signal });
      if (!response.ok) {
        problem = await readErrorMessage(response);
        if (!isTransientStatus(response.status))
          break;
        continue;
      }
      const video = new Uint8Array(await response.arrayBuffer());
      const contentType = response.headers.get("content-type") ?? "video/mp4";
      return { kind: "completed", jobId, video, contentType, videoUrl, ...costUsd !== undefined && { costUsd } };
    } catch (error) {
      options.signal?.throwIfAborted();
      problem = describeError(error);
    }
  }
  return { kind: "job-failed", jobId, message: `Job finished but the download failed (${problem}).`, videoUrl, costUsd };
}

// src/credentials.ts
var run = promisify(execFile);
var KEY_COMMAND_TIMEOUT_MS = 30000;
function configPath(env = process.env) {
  return path.join(env.CODEX_HOME || path.join(os.homedir(), ".codex"), "xai-video.json");
}
async function readConfig(file) {
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT")
      return;
    throw new Error(`cannot read ${file}: ${sanitizeMessage(String(error))}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${sanitizeMessage(String(error))}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file} must contain a JSON object`);
  }
  const { baseUrl, apiKey } = parsed;
  if (baseUrl !== undefined && (typeof baseUrl !== "string" || !/^https?:\/\/[^/]/i.test(baseUrl))) {
    throw new Error(`${file}: baseUrl must be an http(s) URL`);
  }
  if (apiKey !== undefined && typeof apiKey !== "string")
    throw new Error(`${file}: apiKey must be a string`);
  return { baseUrl, apiKey };
}
async function resolveKey(spec, signal) {
  if (!spec.startsWith("!"))
    return spec;
  let stdout;
  try {
    ({ stdout } = await run("/bin/sh", ["-c", spec.slice(1)], { timeout: KEY_COMMAND_TIMEOUT_MS, signal }));
  } catch (error) {
    throw new Error(`apiKey command failed: ${sanitizeMessage(String(error.message ?? error))}`);
  }
  const key = stdout.trim();
  if (!key)
    throw new Error("apiKey command printed nothing");
  return key;
}
async function resolveCredentials(env = process.env, signal) {
  const file = configPath(env);
  const config = await readConfig(file);
  if (config?.apiKey?.trim()) {
    const spec = config.apiKey.trim();
    const first = await resolveKey(spec, signal);
    return {
      provider: "xai-video",
      baseUrl: config.baseUrl ?? DEFAULT_XAI_BASE_URL,
      getKey: async (rejected) => rejected === undefined ? first : resolveKey(spec, signal)
    };
  }
  const envKey = env.XAI_API_KEY?.trim();
  if (envKey)
    return { provider: "xai", baseUrl: DEFAULT_XAI_BASE_URL, getKey: async () => envKey };
  return;
}

// src/tool.ts
var DEFAULT_MODEL = "grok-imagine-video";
var HD_MODEL = "grok-imagine-video-1.5";
var ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"];
var RESOLUTIONS = ["480p", "720p", "1080p"];
var TOOL_NAME = "xai_generate_video";
var TOOL_DEFINITION = {
  name: TOOL_NAME,
  title: "xAI Video",
  description: [
    "Generate a short video with xAI Grok Imagine and save it as an MP4 file.",
    "Each call submits a paid generation job (billed per output second); call it once per requested video and never retry a call that reported a job id.",
    "Text-to-video by default; pass `image` to animate a still as the first frame.",
    "On xAI, 1080p is image-to-video only (served by grok-imagine-video-1.5); omitted options use xAI's own defaults.",
    "Codex runs this tool outside the session's working directory, so `output_path` and local `image` paths must be absolute (or start with ~/).",
    "Generation usually takes 20 seconds to a few minutes."
  ].join(`
`),
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "What the video should show, including motion and camera direction." },
      image: {
        type: "string",
        description: "First frame for image-to-video: an https URL, a data URL, or an absolute path to a local PNG/JPEG/WebP file."
      },
      duration: { type: "integer", minimum: 1, maximum: 15, description: "Length in whole seconds (1-15)." },
      aspect_ratio: { type: "string", enum: ASPECT_RATIOS },
      resolution: { type: "string", enum: RESOLUTIONS },
      model: { type: "string", description: `xAI video model id. Defaults to ${DEFAULT_MODEL}.` },
      output_path: {
        type: "string",
        description: "Absolute path (or ~/...) of the MP4 to write; missing parent folders are created."
      }
    },
    required: ["prompt", "output_path"],
    additionalProperties: false
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
};
function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], ...isError && { isError: true } };
}
function rejected(message) {
  return textResult(`${message} Nothing was submitted.`, true);
}
function parseArgs(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return "arguments must be an object.";
  const args = raw;
  const known = new Set(Object.keys(TOOL_DEFINITION.inputSchema.properties));
  const unknown = Object.keys(args).filter((key) => !known.has(key));
  if (unknown.length > 0)
    return `unknown argument(s): ${unknown.join(", ")}.`;
  if (typeof args.prompt !== "string" || args.prompt.trim() === "")
    return "prompt must be a non-empty string.";
  if (typeof args.output_path !== "string")
    return "output_path is required: an absolute path for the MP4.";
  for (const key of ["image", "model", "aspect_ratio", "resolution"]) {
    if (args[key] !== undefined && typeof args[key] !== "string")
      return `${key} must be a string.`;
  }
  const { duration, aspect_ratio, resolution } = args;
  if (duration !== undefined && (!Number.isInteger(duration) || duration < 1 || duration > 15)) {
    return "duration must be a whole number of seconds from 1 to 15.";
  }
  if (aspect_ratio !== undefined && !ASPECT_RATIOS.includes(aspect_ratio)) {
    return `aspect_ratio must be one of ${ASPECT_RATIOS.join(", ")}.`;
  }
  if (resolution !== undefined && !RESOLUTIONS.includes(resolution)) {
    return `resolution must be one of ${RESOLUTIONS.join(", ")}.`;
  }
  return args;
}
function absolutePath(input) {
  if (input === "~" || input.startsWith("~/"))
    return path2.join(os2.homedir(), input.slice(2));
  return path2.isAbsolute(input) ? path2.normalize(input) : undefined;
}
function sniffImageMime(bytes) {
  if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71)
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  const tag = (offset) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (bytes.length >= 12 && tag(0) === "RIFF" && tag(8) === "WEBP")
    return "image/webp";
  return;
}
async function resolveImage(input) {
  if (/^https?:\/\//i.test(input))
    return input;
  if (input.startsWith("data:")) {
    if (/^data:image\/(png|jpeg|webp);base64,/i.test(input))
      return input;
    throw new Error("image data URLs must be base64 PNG, JPEG, or WebP");
  }
  const file = absolutePath(input);
  if (!file)
    throw new Error(`image path must be absolute (or start with ~/), got ${input}`);
  let bytes;
  try {
    bytes = await fs2.readFile(file);
  } catch (error) {
    throw new Error(`cannot read image ${file}: ${sanitizeMessage(String(error))}`);
  }
  const mime = sniffImageMime(bytes);
  if (!mime)
    throw new Error(`image ${file} is not a PNG, JPEG, or WebP file`);
  return `data:${mime};base64,${bytes.toString("base64")}`;
}
async function generateVideoTool(rawArgs, ctx) {
  const args = parseArgs(rawArgs);
  if (typeof args === "string")
    return rejected(args);
  let model = args.model;
  if (!model && args.resolution === "1080p") {
    if (!args.image)
      return rejected("1080p on xAI is image-to-video only; pass `image` or choose 720p.");
    model = HD_MODEL;
  }
  model ??= DEFAULT_MODEL;
  if (args.output_path.trim() === "" || /[/\\]$/.test(args.output_path)) {
    return rejected("output_path must name a file, not a directory.");
  }
  const target = absolutePath(args.output_path);
  if (!target)
    return rejected(`output_path must be absolute (or start with ~/), got ${args.output_path}.`);
  const existing = await fs2.stat(target).catch(() => {
    return;
  });
  if (existing?.isDirectory())
    return rejected(`output_path ${target} is a directory.`);
  let imageUrl;
  try {
    imageUrl = args.image === undefined ? undefined : await resolveImage(args.image);
  } catch (error) {
    return rejected(`${error.message}.`);
  }
  let credentials = ctx.credentials;
  try {
    credentials ??= await resolveCredentials(ctx.env, ctx.signal);
  } catch (error) {
    return rejected(`xAI credentials could not be loaded: ${error.message}.`);
  }
  if (!credentials) {
    return rejected(`No xAI credentials are configured: set apiKey in ${configPath(ctx.env)} or export XAI_API_KEY.`);
  }
  const startedAt = Date.now();
  const outcome = await generateXaiVideo(credentials, {
    model,
    prompt: args.prompt,
    duration: args.duration,
    aspectRatio: args.aspect_ratio,
    resolution: args.resolution,
    imageUrl
  }, {
    ...ctx.run,
    signal: ctx.signal,
    onSubmitted: (jobId) => ctx.progress?.(`xAI job ${jobId} submitted; generating…`),
    onProgress: (jobId, status, elapsedMs) => ctx.progress?.(`xAI job ${jobId}: ${sanitizeMessage(status)} (${Math.round(elapsedMs / 1000)}s)`)
  });
  if (outcome.kind === "not-submitted")
    return textResult(`${outcome.message} No job was created.`, true);
  const cost = outcome.costUsd === undefined ? "" : ` Cost: $${outcome.costUsd.toFixed(4)}.`;
  if (outcome.kind === "job-failed") {
    const recovery = outcome.videoUrl ? ` The video is still downloadable at ${outcome.videoUrl}` : "";
    return textResult(`xAI job ${outcome.jobId} did not produce a saved video: ${outcome.message}${recovery}${cost} It was not resubmitted, to avoid a second charge.`, true);
  }
  try {
    await fs2.mkdir(path2.dirname(target), { recursive: true });
    await fs2.writeFile(target, outcome.video);
  } catch (error) {
    const reason = sanitizeMessage(String(error)).replaceAll(os2.homedir(), "~");
    return textResult(`xAI job ${outcome.jobId} finished but writing ${target} failed (${reason}). The video is still downloadable at ${outcome.videoUrl}${cost}`, true);
  }
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  const megabytes = (outcome.video.byteLength / 1048576).toFixed(1);
  return textResult(`Generated video with ${credentials.provider}/${model} (job ${outcome.jobId}) in ${seconds}s. Saved to ${target} (${megabytes} MB, ${outcome.contentType}).${cost}`);
}

// src/server.ts
var SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
var SERVER_INFO = { name: "xai-video", title: "xAI Video", version: "0.1.0" };
var inFlight = new Map;
function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}
`);
}
async function callTool(id, params) {
  if (params.name !== TOOL_NAME) {
    send({ id, error: { code: -32602, message: `Unknown tool: ${String(params.name)}` } });
    return;
  }
  const progressToken = params._meta?.progressToken;
  let step = 0;
  const controller = new AbortController;
  inFlight.set(id, controller);
  try {
    const result = await generateVideoTool(params.arguments ?? {}, {
      signal: controller.signal,
      progress: typeof progressToken === "string" || typeof progressToken === "number" ? (message) => send({ method: "notifications/progress", params: { progressToken, progress: ++step, message } }) : undefined
    });
    if (!controller.signal.aborted)
      send({ id, result });
    else
      process.stderr.write(`xai-video: request ${id} cancelled: ${result.content[0]?.text}
`);
  } catch (error) {
    send({ id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
  } finally {
    inFlight.delete(id);
  }
}
function handle(message) {
  const { id, method, params = {} } = message;
  if (method === undefined)
    return;
  if (id === undefined || id === null) {
    if (method === "notifications/cancelled")
      inFlight.get(params.requestId)?.abort();
    return;
  }
  switch (method) {
    case "initialize": {
      const requested = params.protocolVersion;
      const protocolVersion = typeof requested === "string" && SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0];
      send({ id, result: { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO } });
      return;
    }
    case "ping":
      send({ id, result: {} });
      return;
    case "tools/list":
      send({ id, result: { tools: [TOOL_DEFINITION] } });
      return;
    case "tools/call":
      callTool(id, params);
      return;
    default:
      send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  if (line.trim() === "")
    return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    send({ id: null, error: { code: -32600, message: "Invalid Request" } });
    return;
  }
  handle(message);
});
process.stdin.on("end", () => {
  for (const controller of inFlight.values())
    controller.abort();
});
