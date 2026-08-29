import { createTables } from "./createTables";
import { createBuckets } from "./createBuckets";

async function bootstrap(): Promise<void> {
  await createTables();
  await createBuckets();
}

bootstrap()
  .then(() => {
    console.log("Self-hosted bootstrap complete.");
  })
  .catch((e) => {
    console.error("Self-hosted bootstrap failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
