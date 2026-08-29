import fetch from "node-fetch";
import { IDI } from "../lambda/utils/di";
import { LogUtil } from "../lambda/utils/log";
import { statsLambdaHandler, reconcilePaymentsLambdaHandler } from "../lambda/index";
import { buildSelfHostedDi } from "./di";

const diBuilder = (): IDI => buildSelfHostedDi(new LogUtil(), fetch);

interface IJob {
  name: string;
  utcHour: number;
  utcMinute: number;
  utcWeekDay?: number;
  run: () => Promise<void>;
}

function nextOccurrence(job: IJob, from: Date): Date {
  const next = new Date(from);
  next.setUTCHours(job.utcHour, job.utcMinute, 0, 0);
  if (job.utcWeekDay != null) {
    let daysUntil = (job.utcWeekDay - next.getUTCDay() + 7) % 7;
    if (daysUntil === 0 && next.getTime() <= from.getTime()) {
      daysUntil = 7;
    }
    next.setUTCDate(next.getUTCDate() + daysUntil);
  } else if (next.getTime() <= from.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next;
}

function scheduleJob(job: IJob): void {
  const runAndReschedule = async (): Promise<void> => {
    console.log(`[cron] running job "${job.name}" at ${new Date().toISOString()}`);
    try {
      await job.run();
      console.log(`[cron] job "${job.name}" completed at ${new Date().toISOString()}`);
    } catch (e) {
      console.error(`[cron] job "${job.name}" failed:`, e instanceof Error ? (e.stack ?? e.message) : e);
    }
    scheduleJob(job);
  };

  const next = nextOccurrence(job, new Date());
  const delayMs = next.getTime() - Date.now();
  console.log(
    `[cron] next run of "${job.name}" scheduled for ${next.toISOString()} (in ${Math.round(delayMs / 1000 / 60)} min)`
  );
  setTimeout(() => {
    runAndReschedule().catch((e) => {
      console.error(`[cron] unexpected error scheduling job "${job.name}":`, e);
    });
  }, delayMs);
}

async function runStatsJob(): Promise<void> {
  const result = await statsLambdaHandler(diBuilder)({});
  if (result.statusCode >= 400) {
    throw new Error(`stats job returned status ${result.statusCode}: ${result.body}`);
  }
}

async function runReconcilePaymentsJob(): Promise<void> {
  const result = await reconcilePaymentsLambdaHandler(diBuilder)({});
  if (result.statusCode >= 400) {
    throw new Error(`payment reconciliation job returned status ${result.statusCode}: ${result.body}`);
  }
}

function isPaymentReconciliationEnabled(): boolean {
  return !!process.env.APPLE_PRIVATE_KEY || !!process.env.GOOGLE_SERVICE_ACCOUNT_PUBSUB;
}

function main(): void {
  scheduleJob({ name: "stats", utcHour: 23, utcMinute: 40, run: runStatsJob });

  if (isPaymentReconciliationEnabled()) {
    scheduleJob({
      name: "reconcile-payments",
      utcHour: 6,
      utcMinute: 0,
      utcWeekDay: 0,
      run: runReconcilePaymentsJob,
    });
  } else {
    console.log(
      "[cron] payment reconciliation is disabled (set APPLE_PRIVATE_KEY or GOOGLE_SERVICE_ACCOUNT_PUBSUB to enable it)"
    );
  }

  const shutdown = (signal: string): void => {
    console.log(`[cron] received ${signal}, shutting down`);
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main();
