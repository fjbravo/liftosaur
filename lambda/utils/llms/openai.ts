import { ILLMProvider } from "./llmTypes";
import { HttpStreaming_streamRequest } from "./httpStreaming";

export class OpenAIProvider implements ILLMProvider {
  // baseUrl points the OpenAI-compatible protocol at another gateway (e.g. a
  // self-hosted LLM router); "/chat/completions" is appended to its path.
  constructor(
    private readonly apiKey: string,
    private readonly model: string = "gpt-5-mini-2025-08-07",
    private readonly baseUrl?: string
  ) {}

  private endpoint(): { hostname: string; path: string; port?: number; protocol?: "http:" | "https:" } {
    if (this.baseUrl == null) {
      return { hostname: "api.openai.com", path: "/v1/chat/completions" };
    }
    const url = new URL(this.baseUrl);
    return {
      hostname: url.hostname,
      port: url.port ? Number(url.port) : undefined,
      protocol: url.protocol === "http:" ? "http:" : "https:",
      path: `${url.pathname.replace(/\/+$/, "")}/chat/completions`,
    };
  }

  public async *generate(
    systemPrompt: string,
    userInput: string,
    temperature: number = 0.3
  ): AsyncGenerator<{ type: "progress" | "result" | "error" | "retry" | "finish"; data: string }, void, unknown> {
    const messages = [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: userInput,
      },
    ];

    const requestBody = JSON.stringify({
      model: this.model,
      messages,
      temperature,
      stream: true,
    });

    yield { type: "progress", data: "Connecting to OpenAI..." };

    try {
      let fullContent = "";

      const stream = HttpStreaming_streamRequest({
        ...this.endpoint(),
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: requestBody,
      });

      yield { type: "progress", data: "Processing response..." };

      for await (const line of stream) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") {
            break;
          }
          try {
            const json = JSON.parse(data);
            const content = json.choices?.[0]?.delta?.content;
            if (content) {
              fullContent += content;
              yield { type: "result", data: content };
            }
          } catch (e) {
            console.error("Failed to parse streaming response:", e);
          }
        }
      }

      if (fullContent) {
        fullContent = fullContent.trim().replace(/^`+/, "").replace(/`+$/, "");
        yield { type: "finish", data: fullContent };
      } else {
        yield { type: "error", data: "No content received from OpenAI" };
      }
    } catch (error: unknown) {
      yield { type: "error", data: (error as Error).message || "Failed to connect to OpenAI" };
    }
  }
}
