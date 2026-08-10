import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function patchOpenAIResponseDefaults(
  payload: unknown,
  provider: unknown,
  api: unknown,
): unknown {
  const isOpenAI = provider === "openai" && api === "openai-responses";
  const isCodex = provider === "openai-codex" && api === "openai-codex-responses";
  if ((!isOpenAI && !isCodex) || !isJsonObject(payload)) return payload;

  const patched: JsonObject = {
    ...payload,
    text: {
      ...(isJsonObject(payload.text) ? payload.text : {}),
      verbosity: "low",
    },
  };

  if (isJsonObject(payload.reasoning)) {
    patched.reasoning = {
      ...payload.reasoning,
      summary: null,
    };
  }

  return patched;
}

export default function openAIResponseDefaults(pi: ExtensionAPI) {
  pi.on("before_provider_request", (event, ctx) =>
    patchOpenAIResponseDefaults(event.payload, ctx.model?.provider, ctx.model?.api),
  );
}
