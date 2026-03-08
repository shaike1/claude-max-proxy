/**
 * API Route Handlers
 *
 * Implements OpenAI-compatible endpoints for Clawdbot integration
 */
import { v4 as uuidv4 } from "uuid";
import { ClaudeSubprocess } from "../subprocess/manager.js";
import { openaiToCli } from "../adapter/openai-to-cli.js";
import { cliResultToOpenai, createDoneChunk, } from "../adapter/cli-to-openai.js";

const FALLBACK_URL = process.env.CLAUDE_PROXY_FALLBACK_URL || null;

async function forwardToFallback(body, res, stream, requestId) {
    if (!FALLBACK_URL) return false;
    try {
        console.log(`[Fallback] Forwarding to ${FALLBACK_URL}`);
        const fetch = (await import("node:http")).request;
        const url = new URL("/v1/chat/completions", FALLBACK_URL);
        const payload = JSON.stringify(body);
        const options = {
            hostname: url.hostname,
            port: url.port || 80,
            path: url.pathname,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
            },
        };
        return new Promise((resolve) => {
            const req = fetch(options, (fbRes) => {
                if (stream) {
                    res.setHeader("Content-Type", "text/event-stream");
                    res.setHeader("Cache-Control", "no-cache");
                    res.setHeader("Connection", "keep-alive");
                    res.setHeader("X-Request-Id", requestId);
                    res.setHeader("X-Served-By", "fallback");
                    fbRes.pipe(res);
                } else {
                    res.setHeader("Content-Type", "application/json");
                    res.setHeader("X-Served-By", "fallback");
                    fbRes.pipe(res);
                }
                fbRes.on("end", () => resolve(true));
                fbRes.on("error", () => resolve(false));
            });
            req.on("error", () => resolve(false));
            req.write(payload);
            req.end();
        });
    } catch (err) {
        console.error("[Fallback] Error:", err.message);
        return false;
    }
}

/**
 * Handle POST /v1/chat/completions
 */
export async function handleChatCompletions(req, res) {
    const requestId = uuidv4().replace(/-/g, "").slice(0, 24);
    const body = req.body;
    const stream = body.stream === true;
    try {
        if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
            res.status(400).json({
                error: {
                    message: "messages is required and must be a non-empty array",
                    type: "invalid_request_error",
                    code: "invalid_messages",
                },
            });
            return;
        }
        const cliInput = openaiToCli(body);
        const subprocess = new ClaudeSubprocess();
        if (stream) {
            await handleStreamingResponse(req, res, subprocess, cliInput, requestId, body);
        } else {
            await handleNonStreamingResponse(res, subprocess, cliInput, requestId, body);
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error("[handleChatCompletions] Error:", message);
        if (!res.headersSent) {
            const forwarded = await forwardToFallback(body, res, stream, requestId);
            if (!forwarded) {
                res.status(500).json({
                    error: { message, type: "server_error", code: null },
                });
            }
        }
    }
}

/**
 * Handle streaming response (SSE) with lazy header flush for fallback support
 */
async function handleStreamingResponse(req, res, subprocess, cliInput, requestId, originalBody) {
    return new Promise((resolve, reject) => {
        let headersFlushed = false;
        let isFirst = true;
        let lastModel = "claude-sonnet-4";
        let isComplete = false;
        let hasContent = false;

        function flushHeaders() {
            if (!headersFlushed) {
                headersFlushed = true;
                res.setHeader("Content-Type", "text/event-stream");
                res.setHeader("Cache-Control", "no-cache");
                res.setHeader("Connection", "keep-alive");
                res.setHeader("X-Request-Id", requestId);
                res.flushHeaders();
                res.write(":ok\n\n");
            }
        }

        res.on("close", () => {
            if (!isComplete) subprocess.kill();
            resolve();
        });

        subprocess.on("content_delta", (event) => {
            const text = event.event.delta?.text || "";
            if (text && !res.writableEnded) {
                flushHeaders();
                hasContent = true;
                const chunk = {
                    id: `chatcmpl-${requestId}`,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: lastModel,
                    choices: [{ index: 0, delta: { role: isFirst ? "assistant" : undefined, content: text }, finish_reason: null }],
                };
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                isFirst = false;
            }
        });

        subprocess.on("assistant", (message) => { lastModel = message.message.model; });

        subprocess.on("result", (_result) => {
            isComplete = true;
            flushHeaders();
            if (!res.writableEnded) {
                const doneChunk = createDoneChunk(requestId, lastModel);
                res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
                res.write("data: [DONE]\n\n");
                res.end();
            }
            resolve();
        });

        subprocess.on("error", async (error) => {
            console.error("[Streaming] Error:", error.message);
            if (!headersFlushed && !hasContent) {
                // No content yet — try fallback before sending anything
                const forwarded = await forwardToFallback(originalBody, res, true, requestId);
                if (!forwarded && !res.headersSent) {
                    res.status(500).json({ error: { message: error.message, type: "server_error", code: null } });
                }
            } else if (!res.writableEnded) {
                res.write(`data: ${JSON.stringify({ error: { message: error.message, type: "server_error", code: null } })}\n\n`);
                res.end();
            }
            resolve();
        });

        subprocess.on("close", async (code) => {
            if (!res.writableEnded) {
                if (code !== 0 && !isComplete && !hasContent && !headersFlushed) {
                    const forwarded = await forwardToFallback(originalBody, res, true, requestId);
                    if (!forwarded) {
                        flushHeaders();
                        res.write(`data: ${JSON.stringify({ error: { message: `Process exited with code ${code}`, type: "server_error", code: null } })}\n\n`);
                        res.write("data: [DONE]\n\n");
                        res.end();
                    }
                } else {
                    flushHeaders();
                    if (code !== 0 && !isComplete) {
                        res.write(`data: ${JSON.stringify({ error: { message: `Process exited with code ${code}`, type: "server_error", code: null } })}\n\n`);
                    }
                    res.write("data: [DONE]\n\n");
                    res.end();
                }
            }
            resolve();
        });

        subprocess.start(cliInput.prompt, { model: cliInput.model, sessionId: cliInput.sessionId })
            .catch((err) => {
                console.error("[Streaming] Subprocess start error:", err);
                reject(err);
            });
    });
}

/**
 * Handle non-streaming response with fallback
 */
async function handleNonStreamingResponse(res, subprocess, cliInput, requestId, originalBody) {
    return new Promise((resolve) => {
        let finalResult = null;

        subprocess.on("result", (result) => { finalResult = result; });

        subprocess.on("error", async (error) => {
            console.error("[NonStreaming] Error:", error.message);
            const forwarded = await forwardToFallback(originalBody, res, false, requestId);
            if (!forwarded && !res.headersSent) {
                res.status(500).json({ error: { message: error.message, type: "server_error", code: null } });
            }
            resolve();
        });

        subprocess.on("close", async (code) => {
            if (finalResult) {
                res.json(cliResultToOpenai(finalResult, requestId));
            } else if (!res.headersSent) {
                const forwarded = await forwardToFallback(originalBody, res, false, requestId);
                if (!forwarded) {
                    res.status(500).json({
                        error: {
                            message: `Claude CLI exited with code ${code} without response`,
                            type: "server_error",
                            code: null,
                        },
                    });
                }
            }
            resolve();
        });

        subprocess.start(cliInput.prompt, { model: cliInput.model, sessionId: cliInput.sessionId })
            .catch(async (error) => {
                const forwarded = await forwardToFallback(originalBody, res, false, requestId);
                if (!forwarded && !res.headersSent) {
                    res.status(500).json({ error: { message: error.message, type: "server_error", code: null } });
                }
                resolve();
            });
    });
}

/**
 * Handle GET /v1/models
 */
export function handleModels(_req, res) {
    res.json({
        object: "list",
        data: [
            { id: "claude-opus-4", object: "model", owned_by: "anthropic", created: Math.floor(Date.now() / 1000) },
            { id: "claude-sonnet-4", object: "model", owned_by: "anthropic", created: Math.floor(Date.now() / 1000) },
            { id: "claude-haiku-4", object: "model", owned_by: "anthropic", created: Math.floor(Date.now() / 1000) },
        ],
    });
}

/**
 * Handle GET /health
 */
export function handleHealth(_req, res) {
    res.json({ status: "ok", provider: "claude-code-cli", timestamp: new Date().toISOString() });
}
//# sourceMappingURL=routes.js.map
