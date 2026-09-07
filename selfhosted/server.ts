/* eslint-disable @typescript-eslint/no-explicit-any */
import http from "http";
import { getHandler } from "../lambda/index";
import { getImageResizerHandler } from "../lambda/imageResizer";
import { APIGatewayProxyEvent, APIGatewayProxyEventHeaders, APIGatewayProxyResult, S3EventRecord } from "aws-lambda";
import { URL } from "url";
import { buildSelfHostedDi } from "./di";
import { LogUtil } from "../lambda/utils/log";
import fetch from "node-fetch";

declare global {
  namespace NodeJS {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    interface Global {
      __COMMIT_HASH__: string;
      __FULL_COMMIT_HASH__: string;
      awslambda: any;
    }
  }
}

const port = parseInt(process.env.PORT || "3000", 10);
const minioEventPaths = ["/selfhosted/minio-events", "/api/minio-resize-webhook"];

if (!process.env.HOST) {
  console.error(
    "HOST environment variable is required - it's the public base URL of this deployment, e.g. https://lift.example.com"
  );
  process.exit(1);
}

const commitHash = process.env.COMMIT_HASH || "selfhosted";
const fullCommitHash = process.env.FULL_COMMIT_HASH || "selfhosted";
(global as any).__COMMIT_HASH__ = commitHash;
(global as any).__FULL_COMMIT_HASH__ = fullCommitHash;
process.env.COMMIT_HASH = commitHash;
process.env.FULL_COMMIT_HASH = fullCommitHash;

function getBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      resolve(data);
    });
  });
}

async function requestToProxyEvent(request: http.IncomingMessage): Promise<APIGatewayProxyEvent> {
  const body = await getBody(request);
  const url = new URL(request.url || "", "http://www.example.com");

  const qs: Partial<Record<string, string>> = {};
  url.searchParams.forEach((v, k) => {
    qs[k] = v;
  });
  const headers = { ...request.headers } as APIGatewayProxyEventHeaders;
  const cookieHeader = headers.cookie || "";
  headers["x-auth-state"] = cookieHeader.includes("session") ? "yes" : "no";
  const ua = headers["user-agent"] || "";
  headers["x-device-type"] = /iPhone|iPad|iPod/i.test(ua) ? "ios" : /Android/i.test(ua) ? "android" : "desktop";

  return {
    body: body,
    headers,
    multiValueHeaders: {},
    httpMethod: request.method || "GET",
    isBase64Encoded: false,
    path: url.pathname,
    pathParameters: {},
    queryStringParameters: qs,
    multiValueQueryStringParameters: {},
    stageVariables: {},

    requestContext: {} as any,
    resource: "",
  };
}

function parseMinioRecords(body: string): S3EventRecord[] {
  if (!body) {
    return [];
  }
  const payload = JSON.parse(body) as { Records?: unknown[] };
  const records = Array.isArray(payload.Records) ? payload.Records : [];
  return records.filter((record): record is S3EventRecord => {
    const s3 = (record as Partial<S3EventRecord>).s3;
    return typeof s3?.bucket?.name === "string" && typeof s3?.object?.key === "string";
  });
}

const imageResizerHandler = getImageResizerHandler(() => buildSelfHostedDi(new LogUtil(), fetch));

async function handleMinioEvent(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const token = process.env.LIFTOSAUR_WEBHOOK_TOKEN;
  if (token && req.headers.authorization !== `Bearer ${token}`) {
    res.statusCode = 401;
    res.end("unauthorized");
    return;
  }
  const body = await getBody(req);
  res.statusCode = 200;
  res.setHeader("content-type", "text/plain");
  res.end("ok");
  try {
    const records = parseMinioRecords(body);
    if (records.length > 0) {
      await imageResizerHandler({ Records: records });
    }
  } catch (e) {
    console.error("Failed to handle a MinIO bucket notification:", e);
  }
}

const handler = getHandler(() => buildSelfHostedDi(new LogUtil(), fetch));

const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url || "", "http://www.example.com").pathname;
    if (pathname === "/healthz") {
      res.statusCode = 200;
      res.setHeader("content-type", "text/plain");
      res.end("ok");
      return;
    }
    if (minioEventPaths.indexOf(pathname) !== -1) {
      if (req.method !== "POST") {
        res.statusCode = 405;
        res.end();
        return;
      }
      await handleMinioEvent(req, res);
      return;
    }
    const result = (await handler(
      await requestToProxyEvent(req),
      { getRemainingTimeInMillis: () => 10000 },
      () => undefined
    )) as APIGatewayProxyResult;
    const body = result.isBase64Encoded ? Buffer.from(result.body, "base64") : result.body;
    res.statusCode = result.statusCode;
    for (const k of Object.keys(result.headers || {})) {
      res.setHeader(k, result.headers![k] as string);
    }
    res.end(body);
  } catch (e) {
    if (e instanceof Error) {
      console.error(e);
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ name: e.name, error: e.message }));
    } else {
      throw e;
    }
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`--------- API Server is running on port ${port} ----------`);
});

function shutdown(signal: string): void {
  console.log(`Received ${signal}, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
