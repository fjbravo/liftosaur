import {
  DynamoDBClient,
  CreateTableCommand,
  DescribeTableCommand,
  UpdateTimeToLiveCommand,
  ResourceInUseException,
  ResourceNotFoundException,
  ScalarAttributeType,
  ProjectionType,
  BillingMode,
  GlobalSecondaryIndex,
  AttributeDefinition,
} from "@aws-sdk/client-dynamodb";

interface IKeySchema {
  partitionKey: { name: string; type: ScalarAttributeType };
  sortKey?: { name: string; type: ScalarAttributeType };
}

interface IGsiSpec extends IKeySchema {
  indexName: string;
}

interface ITableSpec extends IKeySchema {
  tableName: string;
  gsis?: IGsiSpec[];
  ttlAttribute?: string;
}

const tables: ITableSpec[] = [
  {
    tableName: "lftUsers",
    partitionKey: { name: "id", type: "S" },
    gsis: [
      { indexName: "lftUsersGoogleId", partitionKey: { name: "googleId", type: "S" } },
      { indexName: "lftUsersAppleId", partitionKey: { name: "appleId", type: "S" } },
      { indexName: "lftUsersEmail", partitionKey: { name: "email", type: "S" } },
      { indexName: "lftUsersNickname", partitionKey: { name: "nickname", type: "S" } },
    ],
  },
  {
    tableName: "lftAffiliates",
    partitionKey: { name: "affiliateId", type: "S" },
    sortKey: { name: "userId", type: "S" },
    gsis: [{ indexName: "lftAffiliatesUserId", partitionKey: { name: "userId", type: "S" } }],
  },
  {
    tableName: "lftSubscriptionDetails",
    partitionKey: { name: "userId", type: "S" },
    gsis: [
      {
        indexName: "lftSubscriptionDetailsOriginalTransactionId",
        partitionKey: { name: "originalTransactionId", type: "S" },
      },
    ],
  },
  {
    tableName: "lftPayments",
    partitionKey: { name: "userId", type: "S" },
    sortKey: { name: "timestamp", type: "N" },
    gsis: [{ indexName: "lftPaymentsTransactionId", partitionKey: { name: "transactionId", type: "S" } }],
  },
  { tableName: "lftGoogleAuthKeys", partitionKey: { name: "token", type: "S" } },
  { tableName: "lftAppleAuthKeys", partitionKey: { name: "token", type: "S" } },
  {
    tableName: "lftHistoryRecords",
    partitionKey: { name: "userId", type: "S" },
    sortKey: { name: "id", type: "N" },
    gsis: [
      {
        indexName: "lftHistoryRecordsDate",
        partitionKey: { name: "userId", type: "S" },
        sortKey: { name: "date", type: "S" },
      },
    ],
  },
  {
    tableName: "lftStats",
    partitionKey: { name: "userId", type: "S" },
    sortKey: { name: "name", type: "S" },
    gsis: [
      {
        indexName: "lftStatsTimestamp",
        partitionKey: { name: "userId", type: "S" },
        sortKey: { name: "timestamp", type: "N" },
      },
    ],
  },
  {
    tableName: "lftLogs",
    partitionKey: { name: "userId", type: "S" },
    sortKey: { name: "action", type: "S" },
    gsis: [
      {
        indexName: "lftLogsDate",
        partitionKey: { name: "year", type: "N" },
        sortKey: { name: "month", type: "N" },
      },
    ],
  },
  { tableName: "lftUserPrograms", partitionKey: { name: "userId", type: "S" }, sortKey: { name: "id", type: "S" } },
  { tableName: "lftPrograms", partitionKey: { name: "id", type: "S" } },
  {
    tableName: "lftUrls",
    partitionKey: { name: "id", type: "S" },
    gsis: [{ indexName: "lftUrlsUserId", partitionKey: { name: "userId", type: "S" } }],
  },
  { tableName: "lftFreeUsers", partitionKey: { name: "id", type: "S" } },
  { tableName: "lftCoupons", partitionKey: { name: "code", type: "S" } },
  {
    tableName: "lftApiKeys",
    partitionKey: { name: "key", type: "S" },
    gsis: [{ indexName: "lftApiKeysUserId", partitionKey: { name: "userId", type: "S" } }],
  },
  { tableName: "lftOauthClients", partitionKey: { name: "clientId", type: "S" } },
  { tableName: "lftOauthAuthCodes", partitionKey: { name: "code", type: "S" }, ttlAttribute: "ttl" },
  {
    tableName: "lftOauthTokens",
    partitionKey: { name: "token", type: "S" },
    ttlAttribute: "ttl",
    gsis: [{ indexName: "lftOauthTokensRefreshToken", partitionKey: { name: "refreshToken", type: "S" } }],
  },
  { tableName: "lftEmailAuthTokens", partitionKey: { name: "token", type: "S" }, ttlAttribute: "ttl" },
  { tableName: "lftDebug", partitionKey: { name: "id", type: "S" } },
  {
    tableName: "lftEvents",
    partitionKey: { name: "userId", type: "S" },
    sortKey: { name: "timestamp", type: "N" },
    ttlAttribute: "ttl",
    gsis: [
      {
        indexName: "lftEventsName",
        partitionKey: { name: "name", type: "S" },
        sortKey: { name: "timestamp", type: "N" },
      },
    ],
  },
  {
    tableName: "lftAiLogs",
    partitionKey: { name: "id", type: "S" },
    ttlAttribute: "ttl",
    gsis: [
      {
        indexName: "userId-timestamp-index",
        partitionKey: { name: "userId", type: "S" },
        sortKey: { name: "timestamp", type: "N" },
      },
    ],
  },
  { tableName: "lftAiMuscleCaches", partitionKey: { name: "key", type: "S" } },
];

function requireEndpoint(): string {
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  if (!endpoint) {
    throw new Error("DYNAMODB_ENDPOINT env var is required (e.g. http://dynamodb:8000)");
  }
  return endpoint;
}

function collectAttributeDefinitions(spec: ITableSpec): AttributeDefinition[] {
  const byName = new Map<string, ScalarAttributeType>();
  byName.set(spec.partitionKey.name, spec.partitionKey.type);
  if (spec.sortKey) {
    byName.set(spec.sortKey.name, spec.sortKey.type);
  }
  for (const gsi of spec.gsis || []) {
    byName.set(gsi.partitionKey.name, gsi.partitionKey.type);
    if (gsi.sortKey) {
      byName.set(gsi.sortKey.name, gsi.sortKey.type);
    }
  }
  return Array.from(byName.entries()).map(([name, type]) => ({ AttributeName: name, AttributeType: type }));
}

function buildGlobalSecondaryIndexes(spec: ITableSpec): GlobalSecondaryIndex[] | undefined {
  if (!spec.gsis || spec.gsis.length === 0) {
    return undefined;
  }
  return spec.gsis.map((gsi) => ({
    IndexName: gsi.indexName,
    KeySchema: [
      { AttributeName: gsi.partitionKey.name, KeyType: "HASH" as const },
      ...(gsi.sortKey ? [{ AttributeName: gsi.sortKey.name, KeyType: "RANGE" as const }] : []),
    ],
    Projection: { ProjectionType: ProjectionType.ALL },
  }));
}

async function tableExists(client: DynamoDBClient, tableName: string): Promise<boolean> {
  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
    return true;
  } catch (e) {
    if (e instanceof ResourceNotFoundException) {
      return false;
    }
    throw e;
  }
}

async function createTable(client: DynamoDBClient, spec: ITableSpec): Promise<"created" | "skipped"> {
  if (await tableExists(client, spec.tableName)) {
    return "skipped";
  }
  try {
    await client.send(
      new CreateTableCommand({
        TableName: spec.tableName,
        BillingMode: BillingMode.PAY_PER_REQUEST,
        AttributeDefinitions: collectAttributeDefinitions(spec),
        KeySchema: [
          { AttributeName: spec.partitionKey.name, KeyType: "HASH" },
          ...(spec.sortKey ? [{ AttributeName: spec.sortKey.name, KeyType: "RANGE" as const }] : []),
        ],
        GlobalSecondaryIndexes: buildGlobalSecondaryIndexes(spec),
      })
    );
    return "created";
  } catch (e) {
    if (e instanceof ResourceInUseException) {
      return "skipped";
    }
    throw e;
  }
}

async function enableTtl(client: DynamoDBClient, spec: ITableSpec): Promise<void> {
  if (!spec.ttlAttribute) {
    return;
  }
  try {
    await client.send(
      new UpdateTimeToLiveCommand({
        TableName: spec.tableName,
        TimeToLiveSpecification: { AttributeName: spec.ttlAttribute, Enabled: true },
      })
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/already enabled/i.test(message) || /ValidationException/.test(String((e as { name?: string }).name))) {
      return;
    }
    throw e;
  }
}

export async function createTables(): Promise<void> {
  const endpoint = requireEndpoint();
  const client = new DynamoDBClient({ endpoint, region: process.env.AWS_REGION || "us-west-2" });

  const results: { tableName: string; status: "created" | "skipped" | "failed"; error?: string }[] = [];
  for (const spec of tables) {
    try {
      const status = await createTable(client, spec);
      await enableTtl(client, spec);
      results.push({ tableName: spec.tableName, status });
    } catch (e) {
      results.push({ tableName: spec.tableName, status: "failed", error: e instanceof Error ? e.message : String(e) });
    }
  }

  console.log("DynamoDB bootstrap summary:");
  for (const r of results) {
    console.log(
      `  ${r.status === "failed" ? "FAILED " : r.status === "created" ? "created" : "skipped"} ${r.tableName}${r.error ? ` (${r.error})` : ""}`
    );
  }

  const failures = results.filter((r) => r.status === "failed");
  if (failures.length > 0) {
    throw new Error(
      `${failures.length} table(s) failed to create: ${failures.map((f) => `${f.tableName} (${f.error})`).join(", ")}`
    );
  }
}

if (require.main === module) {
  createTables()
    .then(() => {
      console.log("DynamoDB bootstrap complete.");
    })
    .catch((e) => {
      console.error("DynamoDB bootstrap failed:", e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
