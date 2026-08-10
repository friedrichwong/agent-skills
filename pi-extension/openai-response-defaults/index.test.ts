import assert from "node:assert/strict";
import { patchOpenAIResponseDefaults } from "./index.ts";

const openAIPayload = {
  reasoning: { effort: "high", summary: "auto" },
  text: { format: { type: "text" }, verbosity: "medium" },
};
const patchedOpenAI = patchOpenAIResponseDefaults(
  openAIPayload,
  "openai",
  "openai-responses",
) as typeof openAIPayload;
assert.deepEqual(patchedOpenAI, {
  reasoning: { effort: "high", summary: null },
  text: { format: { type: "text" }, verbosity: "low" },
});
assert.equal(openAIPayload.reasoning.summary, "auto");

const patchedCodex = patchOpenAIResponseDefaults(
  { reasoning: { effort: "medium", summary: "auto" } },
  "openai-codex",
  "openai-codex-responses",
);
assert.deepEqual(patchedCodex, {
  reasoning: { effort: "medium", summary: null },
  text: { verbosity: "low" },
});

const withoutReasoning = patchOpenAIResponseDefaults(
  { input: [] },
  "openai-codex",
  "openai-codex-responses",
);
assert.deepEqual(withoutReasoning, { input: [], text: { verbosity: "low" } });

const unrelated = { text: { verbosity: "medium" } };
assert.equal(patchOpenAIResponseDefaults(unrelated, "anthropic", "anthropic-messages"), unrelated);
