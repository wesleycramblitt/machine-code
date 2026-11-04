/**
 * Some providers return tool-call syntax as plain text instead of native
 * toolCall blocks. That is a malformed response, not a final answer. Detect the
 * common XML-ish forms so the loop can rotate models instead of completing.
 */
const TOOL_TAG = /<\/?\|?(?:tool_call|tool_use|function_call|invoke)\|?>/gi;
/** Provider-specific markers that leaked into arguments or assistant text. */
const PROVIDER_MARKUP = /<\/?rfl:parameter\b|<\|(?:start|end|channel|constrain|message)\|>/i;

export function hasToolCallMarkup(text: string): boolean {
  if (!text) return false;
  // Some free providers emit their own XML-ish envelope inside an argument
  // string. Treat that as a malformed tool call, not as a schema error.
  if (PROVIDER_MARKUP.test(text)) return true;
  const tags = text.match(TOOL_TAG) ?? [];
  if (tags.length >= 2) return true;
  // A single opener plus an argument marker is still an attempted call.
  return tags.length === 1 && /<param_key\b/i.test(text);
}
