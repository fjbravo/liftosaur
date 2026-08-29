import { createTables } from "./createTables";
import { createBuckets } from "./createBuckets";

const connectionErrorCodes = ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "ETIMEDOUT"];
const maxAttempts = 30;
const retryDelayMs = 2000;

// DynamoDB Local and MinIO can still be booting when compose starts this one-shot service
// (dynamodb-local ships no health-checkable client, so compose cannot gate on it).
function isConnectionError(e: unknown): boolean {
  const message = e instanceof Error ? `${e.message} ${(e as { code?: string }).code ?? ""}` : String(e);
  return connectionErrorCodes.some((code) => message.indexOf(code) !== -1);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function bootstrap(): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await createTables();
      await createBuckets();
      return;
    } catch (e) {
      if (!isConnectionError(e) || attempt >= maxAttempts) {
        throw e;
      }
      console.log(`DynamoDB/MinIO not reachable yet, retrying in ${retryDelayMs}ms (${attempt}/${maxAttempts})`);
      await delay(retryDelayMs);
    }
  }
}

bootstrap()
  .then(() => {
    console.log("Self-hosted bootstrap complete.");
  })
  .catch((e) => {
    console.error("Self-hosted bootstrap failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
