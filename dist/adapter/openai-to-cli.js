/**
 * Converts OpenAI chat request format to Claude CLI input
 */
const MODEL_MAP = {
    // Direct model names
    "claude-opus-4": "opus",
    "claude-sonnet-4": "sonnet",
    "claude-haiku-4": "haiku",
    // With provider prefix
    "claude-code-cli/claude-opus-4": "opus",
    "claude-code-cli/claude-sonnet-4": "sonnet",
    "claude-code-cli/claude-haiku-4": "haiku",
    // Aliases
    "opus": "opus",
    "sonnet": "sonnet",
    "haiku": "haiku",
};
/**
 * Extract Claude model alias from request model string
 */
export function extractModel(model) {
    // Try direct lookup
    if (MODEL_MAP[model]) {
        return MODEL_MAP[model];
    }
    // Try stripping provider prefix
    const stripped = model.replace(/^claude-code-cli\//, "");
    if (MODEL_MAP[stripped]) {
        return MODEL_MAP[stripped];
    }
    // Default to opus (Claude Max subscription)
    return "opus";
}
/**
 * Convert OpenAI messages array to a single prompt string for Claude CLI
 *
 * Claude Code CLI in --print mode expects a single prompt, not a conversation.
 * We format the messages into a readable format that preserves context.
 */
function extractText(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .filter(p => p.type === "text")
            .map(p => p.text)
            .join("");
    }
    return String(content);
}
export function messagesToPrompt(messages) {
    const parts = [];
    for (const msg of messages) {
        const text = extractText(msg.content);
        switch (msg.role) {
            case "system":
                parts.push(`<system>\n${text}\n</system>\n`);
                break;
            case "user":
                parts.push(text);
                break;
            case "assistant":
                parts.push(`<previous_response>\n${text}\n</previous_response>\n`);
                break;
        }
    }
    return parts.join("\n").trim();
}
/**
 * Convert OpenAI chat request to CLI input format
 */
export function openaiToCli(request) {
    return {
        prompt: messagesToPrompt(request.messages),
        model: extractModel(request.model),
        sessionId: request.user, // Use OpenAI's user field for session mapping
    };
}
//# sourceMappingURL=openai-to-cli.js.map