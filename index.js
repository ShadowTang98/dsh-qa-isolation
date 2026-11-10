import { randomUUID } from "node:crypto";

/**
 * Single-question isolation, for a session that answers unrelated questions.
 *
 * Two halves in one bundle: this file is the Host half (it rewrites the
 * model-visible surface, owns the `/qa` command, and serves the mode route),
 * `client.js` is the browser half (it renders the mode switch in the composer
 * tool row).
 *
 * The plugin is one Host row and takes effect only in sessions whose Agent
 * preset is `config.preset` (default `qa`), so it stays out of the way
 * everywhere else — including the command list check below, which answers
 * honestly rather than pretending to apply.
 *
 * The session log stays append-only and complete; this plugin rewrites only
 * the model-visible surface. At the first step of every new turn it replaces
 * the whole previous span — everything after the system-prompt head — with one
 * short marker message, so the model receives the system prompt plus the newest
 * question and nothing else. Chat assembles from that same surface, so the
 * shadowed exchanges also leave the visible transcript.
 *
 * The mode is a fold of the log, never plugin memory: `/qa follow` and `/qa
 * fresh` arrive as ordinary `command/run` records, and both the pre-step
 * decision and the browser switch read the newest one that names a mode. A
 * restart, a page reload, or another client therefore sees one answer.
 */

/**
 * Marker replacing the shadowed span on the model-visible surface.
 *
 * It states a past fact, never a standing rule: the marker stays on the
 * surface after a later switch to follow-up mode, and wording that promised
 * "every question is answered alone" made the model assert that rule even in
 * turns that did keep their context.
 */
const MARKER_TEXT = "（此前若干轮问答已从上下文移除——那些轮按单问模式独立作答。本提示只说明过去，不代表当前模式。）";

/** Accepted `/qa` arguments mapped to a mode. */
const MODE_WORDS = {
	fresh: "fresh",
	single: "fresh",
	new: "fresh",
	off: "fresh",
	follow: "follow",
	context: "follow",
	keep: "follow",
	on: "follow",
};

/** Map one `/qa` argument line to a mode, or `undefined` when it names none. */
function parseMode(rawInput) {
	if (typeof rawInput !== "string") return undefined;
	return MODE_WORDS[rawInput.trim().toLowerCase()];
}

/**
 * Read the current mode out of one session's log.
 *
 * Walks back from the newest event to the first `/qa` run that names a mode,
 * so the answer needs no plugin-owned cache and survives every lifecycle. A
 * bare `/qa` only reports the mode and is skipped, like a failed run.
 *
 * @returns `"fresh"` when the session recorded no switch.
 */
function readMode(session) {
	for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
		const event = session.eventAt(seq);
		if (event === undefined || event.type !== "command/run" || event.data.name !== "qa") continue;
		const wanted = parseMode(event.data.args);
		if (wanted !== undefined) return wanted;
	}
	return "fresh";
}

/**
 * Shadow the previous span of one session surface.
 *
 * The newest question is not on the surface yet at pre-step time, so replacing
 * the whole previous span leaves exactly the system-prompt head plus the
 * marker. Surface node 0 is the rendered system prompt and the session refuses
 * to shadow it, so the span starts after it; on a surface without that head,
 * node 0 is ordinary history and may be replaced. A tail still carrying an
 * unanswered tool call cannot end a balanced replacement, so the span shrinks
 * by one node until the append validates.
 *
 * @returns the number of shadowed nodes, plus the last rejection reason when
 *   a nonempty span never validated — a silent no-op would hide a real defect.
 */
function resetSurface(session) {
	const nodes = session.surface.nodes;
	if (nodes.length === 0) return { shadowed: 0 };
	const headIsSystem = session.eventAt(nodes[0])?.type === "system/message";
	const startIdx = headIsSystem ? 1 : 0;
	let lastError;
	for (let endIdx = nodes.length - 1; endIdx >= startIdx; endIdx -= 1) {
		const shadowed = nodes.slice(startIdx, endIdx + 1);
		try {
			session.append(
				"user/message",
				{
					id: randomUUID(),
					role: "user",
					content: [{ type: "text", text: MARKER_TEXT }],
					source: { kind: "user" },
				},
				{
					surfaceOp: { op: "replace", startSeq: shadowed[0], endSeq: shadowed[shadowed.length - 1] },
					sourceEventSeqs: [...shadowed],
				},
			);
			return { shadowed: shadowed.length };
		} catch (error) {
			/* Unbalanced or rejected span: retry one node shorter. */
			lastError = error;
		}
	}
	return { shadowed: 0, error: lastError instanceof Error ? lastError.message : String(lastError ?? "no shadowable span") };
}

/** Same-authority check, so another origin cannot write the mode. */
function sameOrigin(request) {
	const origin = request.headers.origin;
	if (origin === undefined || origin === "null") return true;
	const host = request.headers.host;
	if (typeof host !== "string") return false;
	try {
		return new URL(origin).host === host;
	} catch {
		return false;
	}
}

/** Read a small JSON body off one Node incoming message. */
async function readJsonBody(request) {
	const chunks = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > 65536) throw new Error("body too large");
		chunks.push(chunk);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const json = (response, status, value) => {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	response.end(JSON.stringify(value));
};

/**
 * Which Agent preset one session actually runs.
 *
 * Prefers the preset registry; falls back to the session's own log, where the
 * creation header names the preset it started with and a change while blank is
 * recorded as `agent-preset/selected`.
 */
function presetOf(presets, session) {
	try {
		const current = presets?.presetForSession(session);
		if (current !== undefined && current !== null) return current;
		for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
			const event = session.eventAt(seq);
			if (event !== undefined && event.type === "agent-preset/selected") return event.data.agentPreset;
		}
		return session.header?.agentPreset ?? null;
	} catch {
		/* Registry or log unreadable for this session: treat it as unclaimed. */
		return null;
	}
}

/**
 * Accepted configuration: `{ preset?: string }`, the Agent preset id this
 * plugin applies to, default `qa`. Read defensively rather than declared
 * through `Config`: this package resolves no schema library, because a local
 * directory bundle installs without its own node_modules.
 */
export const inject = ["commands", "agents", "agentPresets"];

/**
 * One Host row carries both halves of the capability.
 *
 * The row sits in the profile (not inside the preset) because a preset row
 * activates lazily when a session selects it — too late to contribute this
 * package's browser half to the client graph. It still takes effect only in
 * sessions running `config.preset`, so every other session is untouched: the
 * pre-step reset is gated, and `/qa` reports that isolation is off there.
 *
 * @param ctx - the plugin context.
 * @param config - `{ preset?: string }`.
 */
export async function apply(ctx, config = {}) {
	const presetId = typeof config.preset === "string" && config.preset.length > 0 ? config.preset : "qa";
	const { commands, agents, agentPresets: presets } = ctx;
	const enabled = (session) => presetOf(presets, session) === presetId;

	ctx.on("agent/pre-step", ({ agent, step, messages }, next) => {
		if (step !== 1 || messages.length === 0 || !enabled(agent.session)) return next();
		if (readMode(agent.session) !== "fresh") return next();
		const { shadowed, error } = resetSurface(agent.session);
		if (shadowed > 0) ctx.logger.info(`dsh-qa-isolation: cleared ${shadowed} surface node(s) before the newest question`);
		else if (error !== undefined) ctx.logger.warn(`dsh-qa-isolation: could not clear the surface: ${error}`);
		return next();
	});

	commands.register({
		definitionId: "dsh-qa-isolation",
		name: "qa",
		description: `切换本会话的提问模式：单问隔离 / 连续追问（仅「${presetId}」预设生效）`,
		input: { hint: "[fresh|follow]" },
		handler: ({ agent, rawInput }) => {
			if (!enabled(agent.session)) {
				return { kind: "error", text: `本会话未使用「${presetId}」预设，单问隔离未启用。新建会话时选择该预设即可使用。` };
			}
			const wanted = parseMode(rawInput);
			if (wanted === undefined) {
				if (rawInput.trim() !== "") return { kind: "error", text: "用法：/qa fresh（每个问题独立作答）或 /qa follow（连续追问）。" };
				return {
					kind: "success",
					text: readMode(agent.session) === "fresh"
						? "当前：单问模式。下一个问题起会移除此前的问答。"
						: "当前：追问模式。仍在上下文里的问答会继续带入。",
				};
			}
			return {
				kind: "success",
				text: wanted === "fresh"
					? "已切到单问模式：下一个问题起，此前的问答会从上下文移除（移除后不再恢复）。"
					: "已切到追问模式：下一个问题起，保留当前仍在上下文里的问答（已被移除的不会恢复）。",
			};
		},
	});

	// Optional carrier: a profile with no HTTP server keeps the command and
	// simply has no browser switch to serve.
	ctx.inject(["webServer"], (httpCtx) => {
		/**
		 * Browser-switch transport. One operation, two callers: the button and
		 * the typed command settle through the same `commands.execute` dispatch,
		 * so the durable record is identical whichever path a person used.
		 *
		 * The Session id comes from the page and is never guessed here: resolving
		 * it to "the busiest live session" would offer the control in a session
		 * under another preset, which is exactly what the switch must not do.
		 */
		httpCtx.effect(() => {
			const release = httpCtx.webServer.register({
				kind: "exact",
				path: "/dsh-qa/mode",
				handler: async (request, response) => {
					if (!sameOrigin(request)) return json(response, 403, { error: "cross-origin" });
					if (commands === undefined || agents === undefined) return json(response, 503, { error: "session services unavailable" });
					const url = new URL(request.url, "http://localhost");
					const sessionId = url.searchParams.get("sessionId");
					if (typeof sessionId !== "string" || sessionId.length === 0) return json(response, 200, { available: false, preset: presetId, reason: "no session id" });
					const agent = agents.get(sessionId);
					if (agent === undefined) return json(response, 200, { available: false, preset: presetId, reason: "session not live" });
					if (!enabled(agent.session)) return json(response, 200, { available: false, preset: presetId, reason: "other preset" });
					if (request.method === "GET") return json(response, 200, { available: true, mode: readMode(agent.session) });
					if (request.method !== "POST") {
						response.writeHead(405, { allow: "GET, POST" });
						return response.end();
					}
					let wanted;
					try {
						wanted = parseMode((await readJsonBody(request))?.mode);
					} catch {
						return json(response, 400, { error: "invalid body" });
					}
					if (wanted === undefined) return json(response, 400, { error: "invalid mode" });
					const execution = await commands.execute(agent, `/qa ${wanted}`, [], new AbortController().signal);
					if (execution === undefined) return json(response, 500, { error: "command refused" });
					return json(response, 200, { available: true, mode: readMode(agent.session) });
				},
			});
			return release;
		}, "dsh-qa-isolation: mode route");
	});
}
