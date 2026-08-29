import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketPolicyCommand,
  PutBucketCorsCommand,
  PutBucketNotificationConfigurationCommand,
  NotFound,
  BucketAlreadyOwnedByYou,
  BucketAlreadyExists,
} from "@aws-sdk/client-s3";

const buckets: string[] = [
  "liftosaurcaches2",
  "liftosaurstats",
  "liftosaurdebugs2",
  "liftosaurexceptions2",
  "liftosaurstorages",
  "liftosaurprograms",
  "liftosaurassets",
  "liftosaurimages2",
  "liftosauruserimages",
  "lftstatic",
];

const publicReadBuckets: string[] = ["liftosaurassets", "liftosauruserimages", "lftstatic"];

const resizerWebhookBucket = "liftosauruserimages";
const resizerQueueArn = "arn:minio:sqs::RESIZER:webhook";

function requireEndpoint(): string {
  const endpoint = process.env.S3_ENDPOINT;
  if (!endpoint) {
    throw new Error("S3_ENDPOINT env var is required (e.g. http://minio:9000)");
  }
  return endpoint;
}

function publicReadPolicy(bucket: string): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: "*",
        Action: ["s3:GetObject"],
        Resource: [`arn:aws:s3:::${bucket}/*`],
      },
    ],
  });
}

async function bucketExists(client: S3Client, bucket: string): Promise<boolean> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return true;
  } catch (e) {
    if (e instanceof NotFound) {
      return false;
    }
    const statusCode = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (statusCode === 404) {
      return false;
    }
    throw e;
  }
}

async function createBucket(client: S3Client, bucket: string): Promise<"created" | "skipped"> {
  if (await bucketExists(client, bucket)) {
    return "skipped";
  }
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    return "created";
  } catch (e) {
    if (e instanceof BucketAlreadyOwnedByYou || e instanceof BucketAlreadyExists) {
      return "skipped";
    }
    throw e;
  }
}

async function applyPublicReadPolicy(client: S3Client, bucket: string): Promise<void> {
  await client.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: publicReadPolicy(bucket) }));
}

async function applyUserImagesCors(client: S3Client, bucket: string): Promise<void> {
  try {
    await client.send(
      new PutBucketCorsCommand({
        Bucket: bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedHeaders: ["*"],
              AllowedMethods: ["GET", "PUT", "POST", "HEAD"],
              AllowedOrigins: ["*"],
              ExposeHeaders: ["ETag"],
              MaxAgeSeconds: 3000,
            },
          ],
        },
      })
    );
  } catch (e) {
    console.warn(
      `Warning: could not set CORS on bucket ${bucket} (some MinIO versions reject PutBucketCors):`,
      e instanceof Error ? e.message : e
    );
  }
}

async function applyResizerWebhookNotification(client: S3Client, bucket: string): Promise<void> {
  if (process.env.MINIO_NOTIFY_WEBHOOK_ENABLE_RESIZER !== "true") {
    console.log(
      `Image resizing webhook is not enabled (MINIO_NOTIFY_WEBHOOK_ENABLE_RESIZER != "true").\n` +
        `To enable automatic resizing of uploaded user images:\n` +
        `  1. Set these env vars on the minio container and restart it:\n` +
        `       MINIO_NOTIFY_WEBHOOK_ENABLE_RESIZER=true\n` +
        `       MINIO_NOTIFY_WEBHOOK_ENDPOINT_RESIZER=http://server:3000/api/minio-resize-webhook\n` +
        `  2. Re-run this bootstrap script so it can bind the "${bucket}" bucket to the webhook target.\n` +
        `  Uploads still work without this - images just won't be auto-resized.`
    );
    return;
  }
  try {
    await client.send(
      new PutBucketNotificationConfigurationCommand({
        Bucket: bucket,
        NotificationConfiguration: {
          QueueConfigurations: [
            {
              QueueArn: resizerQueueArn,
              Events: ["s3:ObjectCreated:*"],
              Filter: { Key: { FilterRules: [{ Name: "prefix", Value: "user-uploads/" }] } },
            },
          ],
        },
      })
    );
    console.log(`Registered resizer webhook notification on bucket ${bucket}.`);
  } catch (e) {
    console.warn(
      `Warning: could not register resizer webhook notification on bucket ${bucket}:`,
      e instanceof Error ? e.message : e
    );
  }
}

export async function createBuckets(): Promise<void> {
  const endpoint = requireEndpoint();
  const client = new S3Client({
    endpoint,
    forcePathStyle: true,
    region: process.env.AWS_REGION || "us-west-2",
  });

  const results: { bucket: string; status: "created" | "skipped" | "failed"; error?: string }[] = [];
  for (const bucket of buckets) {
    try {
      const status = await createBucket(client, bucket);
      if (publicReadBuckets.includes(bucket)) {
        await applyPublicReadPolicy(client, bucket);
      }
      if (bucket === "liftosauruserimages") {
        await applyUserImagesCors(client, bucket);
      }
      results.push({ bucket, status });
    } catch (e) {
      results.push({ bucket, status: "failed", error: e instanceof Error ? e.message : String(e) });
    }
  }

  console.log("MinIO bucket bootstrap summary:");
  for (const r of results) {
    console.log(`  ${r.status === "failed" ? "FAILED " : r.status === "created" ? "created" : "skipped"} ${r.bucket}${r.error ? ` (${r.error})` : ""}`);
  }

  await applyResizerWebhookNotification(client, resizerWebhookBucket);

  const failures = results.filter((r) => r.status === "failed");
  if (failures.length > 0) {
    throw new Error(`${failures.length} bucket(s) failed to create: ${failures.map((f) => f.bucket).join(", ")}`);
  }
}

if (require.main === module) {
  createBuckets()
    .then(() => {
      console.log("MinIO bootstrap complete.");
    })
    .catch((e) => {
      console.error("MinIO bootstrap failed:", e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
