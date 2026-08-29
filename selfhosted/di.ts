import { DynamoDBClientConfig } from "@aws-sdk/client-dynamodb";
import { S3ClientConfig } from "@aws-sdk/client-s3";
import { IDI } from "../lambda/utils/di";
import { DynamoUtil } from "../lambda/utils/dynamo";
import { ILogUtil } from "../lambda/utils/log";
import { S3Util } from "../lambda/utils/s3";
import { ISesUtil, SesUtil } from "../lambda/utils/ses";
import { ILambdaUtil } from "../lambda/utils/lambda";
import { ICloudwatchUtil } from "../lambda/utils/cloudwatch";
import { EnvSecretsUtil } from "./envSecrets";
import { SmtpSesUtil, SmtpSesUtil_isConfigured } from "./smtpSes";

export class SelfHostedLambdaUtil implements ILambdaUtil {
  constructor(public readonly log: ILogUtil) {}

  public async invoke<T>(args: {
    name: string;
    invocationType: "RequestResponse" | "Event";
    payload: T;
  }): Promise<void> {
    this.log.log(`Skipping lambda invocation '${args.name}' - there are no AWS Lambdas in self-hosted mode`);
  }
}

export class SelfHostedCloudwatchUtil implements ICloudwatchUtil {
  constructor(public readonly log: ILogUtil) {}

  public async getLogs(date: Date, userid?: string, endpoint?: string): Promise<void> {
    this.log.log("Fetching logs is not supported in self-hosted mode - read the container's stdout logs instead");
  }
}

// forcePathStyle is required for S3-compatible servers (e.g. MinIO) that don't do vhost-style buckets.
export function SelfHostedDi_s3ClientConfig(endpoint?: string): S3ClientConfig {
  if (!endpoint) {
    return {};
  }
  return { endpoint, forcePathStyle: true, region: process.env.AWS_REGION || "us-west-2" };
}

export function SelfHostedDi_dynamoClientConfig(): DynamoDBClientConfig {
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  if (!endpoint) {
    return {};
  }
  return { endpoint, region: process.env.AWS_REGION || "us-west-2" };
}

export function SelfHostedDi_ses(log: ILogUtil): ISesUtil {
  return SmtpSesUtil_isConfigured() ? new SmtpSesUtil(log) : new SesUtil(log);
}

export function buildSelfHostedDi(log: ILogUtil, fetch: Window["fetch"]): IDI {
  // Presigned URLs are handed to browsers, which can't resolve a container-internal S3 host, so
  // they're signed against the externally reachable endpoint while server-side calls keep using
  // the internal one. The signature covers the host, so this has to be a separate client.
  const publicEndpoint = process.env.S3_PUBLIC_ENDPOINT;
  return {
    dynamo: new DynamoUtil(log, SelfHostedDi_dynamoClientConfig()),
    secrets: new EnvSecretsUtil(log),
    s3: new S3Util(
      log,
      SelfHostedDi_s3ClientConfig(process.env.S3_ENDPOINT),
      publicEndpoint ? SelfHostedDi_s3ClientConfig(publicEndpoint) : undefined
    ),
    ses: SelfHostedDi_ses(log),
    lambda: new SelfHostedLambdaUtil(log),
    cloudwatch: new SelfHostedCloudwatchUtil(log),
    log: log,
    fetch,
  };
}
