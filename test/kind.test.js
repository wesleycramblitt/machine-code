/**
 * Model task classification: coding/chat models stay eligible; image, video,
 * audio, embedding, rerank, and guard models are visible but not selectable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyModel } from "../dist/catalogue/kind.js";

test("text chat models are coding models", () => {
  assert.deepEqual(classifyModel("claude-sonnet-4-5", "Claude Sonnet 4.5", ["text", "image"], ["text"]), {
    kind: "chat",
    coding: true,
  });
});

test("image and video output modalities are non-coding", () => {
  assert.deepEqual(classifyModel("gemini-3-pro-image", "Nano Banana Pro", ["text", "image"], ["text", "image"]), {
    kind: "image",
    coding: false,
  });
  assert.deepEqual(classifyModel("veo-4", "Veo 4", ["text"], ["video"]), {
    kind: "video",
    coding: false,
  });
});

test("image/audio/guard ids are classified even when they emit text", () => {
  assert.equal(classifyModel("gemini-3.1-flash-lite-image", "Nano Banana 2 Lite", ["text", "image"], ["text"]).kind, "image");
  assert.equal(classifyModel("gpt-audio", "GPT Audio", ["text", "audio"], ["text", "audio"]).kind, "audio");
  assert.equal(classifyModel("llama-guard-4-12b", "Llama Guard 4", ["text"], ["text"]).kind, "guard");
  assert.equal(classifyModel("gpt-oss-safeguard-20b", "Safety GPT OSS", ["text"], ["text"]).kind, "guard");
  assert.equal(classifyModel("text-embedding-4", "Embedding 4", ["text"], ["text"]).kind, "embedding");
  assert.equal(classifyModel("bge-reranker-v3", "Reranker", ["text"], ["text"]).kind, "rerank");
});

test("diffusion in the name alone does not make a text model an image model", () => {
  assert.deepEqual(classifyModel("diffusiongemma-26b", "DiffusionGemma 26B", ["text", "image"], ["text"]), {
    kind: "chat",
    coding: true,
  });
});
