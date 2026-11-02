/**
 * Model task classification: a chat/coding model versus an image/video/audio
 * generator, embedding, reranker, or moderation model. The catalogue keeps
 * these rows for visibility, but the selector only admits `coding` models.
 */
export type ModelKind =
  | "chat"
  | "router"
  | "image"
  | "video"
  | "audio"
  | "embedding"
  | "rerank"
  | "guard"
  | "other";

export interface ModelClassification {
  kind: ModelKind;
  coding: boolean;
}

const ID_PATTERNS: Array<[RegExp, ModelKind]> = [
  [/(?:^|[/_.\-\s])(router|routing|auto-router|aggregator)(?:$|[/_.\-\s])/i, "router"],
  [/(?:^|[/_.\-\s])(video|sora|veo|kling|runway|pika|luma|hailuo|minimax-video)(?:$|[/_.\-\s])/i, "video"],
  [/(?:^|[/_.\-\s])(image|imagen|flux|stable-diffusion|midjourney|dall-e|nano-banana|gpt-image|image-gen)(?:$|[/_.\-\s])/i, "image"],
  [/(?:^|[/_.\-\s])(audio|tts|speech|voice|whisper|transcribe|realtime-audio)(?:$|[/_.\-\s])/i, "audio"],
  [/(?:^|[/_.\-\s])(embed|embedding)(?:$|[/_.\-\s])/i, "embedding"],
  [/(?:^|[/_.\-\s])(rerank|reranker)(?:$|[/_.\-\s])/i, "rerank"],
  [/(?:^|[/_.\-\s])(guard|safeguard|moderation)(?:$|[/_.\-\s])/i, "guard"],
];

function fromId(id: string, name: string): ModelKind | null {
  const haystack = `${id} ${name}`;
  for (const [pattern, kind] of ID_PATTERNS) {
    if (pattern.test(haystack)) return kind;
  }
  return null;
}

export function classifyModel(
  id: string,
  name: string,
  input: readonly string[],
  output: readonly string[],
): ModelClassification {
  const hasTextOut = output.includes("text");
  let kind: ModelKind;
  if (output.includes("video")) kind = "video";
  else if (output.includes("image")) kind = "image";
  else if (output.includes("audio") && !hasTextOut) kind = "audio";
  else if (!hasTextOut) kind = "other";
  else kind = fromId(id, name) ?? "chat";

  // An image/audio/video endpoint is not a coding model even when it also
  // emits text (e.g. GPT Audio or Gemini image models).
  const coding = kind === "chat" && input.includes("text") && hasTextOut;
  return { kind, coding };
}
