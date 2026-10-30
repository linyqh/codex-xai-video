import * as readline from "node:readline";
import { generateVideoTool, TOOL_DEFINITION, TOOL_NAME } from "./tool";

const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "xai-video", title: "xAI Video", version: "0.1.0" };

type Id = string | number;

interface Message {
	jsonrpc?: string;
	id?: Id | null;
	method?: string;
	params?: Record<string, unknown>;
}

const inFlight = new Map<Id, AbortController>();

function send(message: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

async function callTool(id: Id, params: Record<string, unknown>): Promise<void> {
	if (params.name !== TOOL_NAME) {
		send({ id, error: { code: -32602, message: `Unknown tool: ${String(params.name)}` } });
		return;
	}
	const progressToken = (params._meta as Record<string, unknown> | undefined)?.progressToken;
	let step = 0;
	const controller = new AbortController();
	inFlight.set(id, controller);
	try {
		const result = await generateVideoTool(params.arguments ?? {}, {
			signal: controller.signal,
			progress:
				typeof progressToken === "string" || typeof progressToken === "number"
					? message => send({ method: "notifications/progress", params: { progressToken, progress: ++step, message } })
					: undefined,
		});
		// A cancelled request must not be answered.
		if (!controller.signal.aborted) send({ id, result });
		else process.stderr.write(`xai-video: request ${id} cancelled: ${result.content[0]?.text}\n`);
	} catch (error) {
		send({ id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
	} finally {
		inFlight.delete(id);
	}
}

function handle(message: Message): void {
	const { id, method, params = {} } = message;
	if (method === undefined) return;
	if (id === undefined || id === null) {
		if (method === "notifications/cancelled") inFlight.get(params.requestId as Id)?.abort();
		return;
	}
	switch (method) {
		case "initialize": {
			const requested = params.protocolVersion;
			const protocolVersion =
				typeof requested === "string" && SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0];
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
			void callTool(id, params);
			return;
		default:
			send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
	}
}

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", line => {
	if (line.trim() === "") return;
	let message: unknown;
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
	handle(message as Message);
});

process.stdin.on("end", () => {
	for (const controller of inFlight.values()) controller.abort();
});
