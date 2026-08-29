import { ILLMProvider } from "./llmTypes";
import { ClaudeProvider } from "./claude";
import { OpenAIProvider } from "./openai";

// LLM_BASE_URL redirects AI calls to an OpenAI-compatible gateway (e.g. a
// self-hosted LLM router) instead of the Anthropic API - useful for
// self-hosted deployments that already run one. LLM_MODEL names the model or
// alias on that gateway, and LLM_API_KEY its key (the Anthropic key doubles as
// the gateway key when unset).
export function Llm_buildProvider(anthropicKey: string): ILLMProvider {
  const baseUrl = process.env.LLM_BASE_URL;
  if (baseUrl) {
    return new OpenAIProvider(process.env.LLM_API_KEY || anthropicKey, process.env.LLM_MODEL || undefined, baseUrl);
  }
  return new ClaudeProvider(anthropicKey);
}
