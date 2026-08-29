import "mocha";
import { expect } from "chai";
import { MockLogUtil } from "./utils/mockLogUtil";
import { buildMockDi } from "./utils/mockDi";
import { EnvSecretsUtil } from "../selfhosted/envSecrets";
import {
  buildSelfHostedDi,
  SelfHostedCloudwatchUtil,
  SelfHostedDi_dynamoClientConfig,
  SelfHostedDi_s3ClientConfig,
  SelfHostedLambdaUtil,
} from "../selfhosted/di";
import { SmtpSesUtil, SmtpSesUtil_transportOptions } from "../selfhosted/smtpSes";
import { SesUtil } from "../lambda/utils/ses";
import { ResponseUtils_sessionCookieDomain } from "../lambda/utils/response";
import { getUserImagesPrefix } from "../lambda/dao/buckets";
import { Subscriptions } from "../lambda/utils/subscriptions";
import { ISubscription } from "../src/types";
import { Llm_buildProvider } from "../lambda/utils/llms/llmProviderFactory";
import { ClaudeProvider } from "../lambda/utils/llms/claude";
import { OpenAIProvider } from "../lambda/utils/llms/openai";
import * as http from "http";
import { AddressInfo } from "net";

const managedEnvVars = [
  "LIFTOSAUR_SELF_HOSTED",
  "HOST",
  "LIFTOSAUR_COOKIE_SECRET",
  "LIFTOSAUR_CRYPTO_KEY",
  "LIFTOSAUR_API_KEY",
  "LIFTOSAUR_UPDATES_PRIVATE_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_SERVICE_ACCOUNT_PUBSUB",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_FROM",
  "DYNAMODB_ENDPOINT",
  "S3_ENDPOINT",
  "S3_PUBLIC_ENDPOINT",
  "AWS_REGION",
  "LLM_BASE_URL",
  "LLM_MODEL",
  "LLM_API_KEY",
];

// The whole suite shares one process, so every var this file touches is snapshotted and restored.
function snapshotEnv(): Partial<Record<string, string>> {
  const snapshot: Partial<Record<string, string>> = {};
  for (const name of managedEnvVars) {
    snapshot[name] = process.env[name];
  }
  return snapshot;
}

function restoreEnv(snapshot: Partial<Record<string, string>>): void {
  for (const name of managedEnvVars) {
    const value = snapshot[name];
    if (value == null) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}

describe("self-hosted gates", () => {
  let envSnapshot: Partial<Record<string, string>>;

  beforeEach(() => {
    envSnapshot = snapshotEnv();
    for (const name of managedEnvVars) {
      delete process.env[name];
    }
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
  });

  describe("EnvSecretsUtil", () => {
    it("reads required secrets from the environment", async () => {
      process.env.LIFTOSAUR_COOKIE_SECRET = "cookie";
      process.env.LIFTOSAUR_CRYPTO_KEY = "crypto";
      process.env.LIFTOSAUR_API_KEY = "api";
      const secrets = new EnvSecretsUtil(new MockLogUtil());
      expect(await secrets.getCookieSecret()).to.equal("cookie");
      expect(await secrets.getCryptoKey()).to.equal("crypto");
      expect(await secrets.getApiKey()).to.equal("api");
    });

    it("throws naming the missing variable", async () => {
      const secrets = new EnvSecretsUtil(new MockLogUtil());
      let message = "";
      try {
        await secrets.getCookieSecret();
      } catch (e) {
        message = e instanceof Error ? e.message : "";
      }
      expect(message).to.contain("LIFTOSAUR_COOKIE_SECRET");
    });

    it("returns an empty string for unset optional secrets", async () => {
      const secrets = new EnvSecretsUtil(new MockLogUtil());
      expect(await secrets.getOpenAiKey()).to.equal("");
      expect(await secrets.getAnthropicKey()).to.equal("");
      expect(await secrets.getUpdatesPrivateKey()).to.equal("");
    });

    it("parses GOOGLE_SERVICE_ACCOUNT_PUBSUB", async () => {
      process.env.GOOGLE_SERVICE_ACCOUNT_PUBSUB = JSON.stringify({ client_email: "svc@example.com" });
      const secrets = new EnvSecretsUtil(new MockLogUtil());
      expect((await secrets.getGoogleServiceAccountPubsub()).client_email).to.equal("svc@example.com");
    });

    it("falls back to an empty object when GOOGLE_SERVICE_ACCOUNT_PUBSUB is not JSON", async () => {
      process.env.GOOGLE_SERVICE_ACCOUNT_PUBSUB = "not json";
      const secrets = new EnvSecretsUtil(new MockLogUtil());
      expect(await secrets.getGoogleServiceAccountPubsub()).to.deep.equal({});
    });
  });

  describe("buildSelfHostedDi", () => {
    it("always uses env secrets, never AWS Secrets Manager", () => {
      const di = buildSelfHostedDi(new MockLogUtil(), fetch);
      expect(di.secrets).to.be.instanceOf(EnvSecretsUtil);
    });

    it("no-ops lambda invocations and cloudwatch log fetching", () => {
      const di = buildSelfHostedDi(new MockLogUtil(), fetch);
      expect(di.lambda).to.be.instanceOf(SelfHostedLambdaUtil);
      expect(di.cloudwatch).to.be.instanceOf(SelfHostedCloudwatchUtil);
    });

    it("picks the SMTP mailer when SMTP_HOST is set", () => {
      process.env.SMTP_HOST = "mailpit";
      expect(buildSelfHostedDi(new MockLogUtil(), fetch).ses).to.be.instanceOf(SmtpSesUtil);
    });

    it("falls back to SES when SMTP_HOST is not set", () => {
      const ses = buildSelfHostedDi(new MockLogUtil(), fetch).ses;
      expect(ses).to.be.instanceOf(SesUtil);
      expect(ses).not.to.be.instanceOf(SmtpSesUtil);
    });

    it("points DynamoDB at DYNAMODB_ENDPOINT", () => {
      expect(SelfHostedDi_dynamoClientConfig()).to.deep.equal({});
      process.env.DYNAMODB_ENDPOINT = "http://dynamodb:8000";
      process.env.AWS_REGION = "eu-central-1";
      expect(SelfHostedDi_dynamoClientConfig()).to.deep.equal({
        endpoint: "http://dynamodb:8000",
        region: "eu-central-1",
      });
    });

    it("points S3 at S3_ENDPOINT with path-style addressing", () => {
      expect(SelfHostedDi_s3ClientConfig(undefined)).to.deep.equal({});
      expect(SelfHostedDi_s3ClientConfig("http://minio:9000")).to.deep.equal({
        endpoint: "http://minio:9000",
        forcePathStyle: true,
        region: "us-west-2",
      });
    });
  });

  describe("SmtpSesUtil", () => {
    it("builds transport options from the SMTP env contract", () => {
      process.env.SMTP_HOST = "smtp.example.com";
      process.env.SMTP_PORT = "465";
      process.env.SMTP_USER = "user";
      process.env.SMTP_PASS = "pass";
      expect(SmtpSesUtil_transportOptions()).to.deep.equal({
        host: "smtp.example.com",
        port: 465,
        secure: true,
        auth: { user: "user", pass: "pass" },
      });
    });

    it("omits auth unless both user and pass are set, so mailpit works", () => {
      process.env.SMTP_HOST = "mailpit";
      process.env.SMTP_USER = "user";
      expect(SmtpSesUtil_transportOptions()).to.deep.equal({
        host: "mailpit",
        port: 587,
        secure: false,
        auth: undefined,
      });
    });
  });

  describe("ResponseUtils_sessionCookieDomain", () => {
    it("is host-only in self-hosted mode", () => {
      process.env.LIFTOSAUR_SELF_HOSTED = "true";
      expect(ResponseUtils_sessionCookieDomain()).to.equal(undefined);
    });

    it("stays on .liftosaur.com otherwise", () => {
      expect(ResponseUtils_sessionCookieDomain()).to.equal(".liftosaur.com");
    });
  });

  describe("getUserImagesPrefix", () => {
    it("uses HOST in self-hosted mode", () => {
      process.env.LIFTOSAUR_SELF_HOSTED = "true";
      process.env.HOST = "https://lift.example.com/";
      expect(getUserImagesPrefix()).to.equal("https://lift.example.com/userimages/");
    });

    it("uses the liftosaur.com prefix otherwise", () => {
      process.env.HOST = "https://lift.example.com";
      expect(getUserImagesPrefix()).to.contain("liftosaur.com/userimages/");
    });
  });

  describe("Subscriptions.hasSubscription", () => {
    const emptySubscription: ISubscription = { apple: [], google: [] };

    it("unlocks premium for everyone in self-hosted mode", async () => {
      process.env.LIFTOSAUR_SELF_HOSTED = "true";
      const di = buildMockDi(new MockLogUtil(), fetch);
      const subscriptions = new Subscriptions(di.log, di.secrets);
      expect(await subscriptions.hasSubscription(di, "userid", emptySubscription)).to.equal(true);
    });

    it("does not unlock premium otherwise", async () => {
      const di = buildMockDi(new MockLogUtil(), fetch);
      const subscriptions = new Subscriptions(di.log, di.secrets);
      expect(await subscriptions.hasSubscription(di, "userid", emptySubscription)).to.equal(false);
    });
  });

  describe("Subscriptions_hasSubscription (client)", () => {
    // The client reads the bare `__SELF_HOSTED__` webpack define once at module load, so the
    // module has to be re-evaluated with the global in place instead of just toggling it.
    it("unlocks premium when built with __SELF_HOSTED__", () => {
      const modulePath = "../src/utils/subscriptions";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const globalWithDefine = globalThis as any;
      const hadDefine = "__SELF_HOSTED__" in globalWithDefine;
      globalWithDefine.__SELF_HOSTED__ = true;
      delete require.cache[require.resolve(modulePath)];
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const selfHosted = require(modulePath);
        expect(selfHosted.Subscriptions_hasSubscription({ apple: [], google: [] })).to.equal(true);
      } finally {
        if (!hadDefine) {
          delete globalWithDefine.__SELF_HOSTED__;
        }
        delete require.cache[require.resolve(modulePath)];
      }
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const regular = require(modulePath);
      expect(regular.Subscriptions_hasSubscription({ apple: [], google: [] })).to.equal(false);
    });
  });

  describe("Llm_buildProvider", () => {
    it("uses the Anthropic provider by default", () => {
      const provider = Llm_buildProvider("anthropic-key");
      expect(provider).to.be.instanceOf(ClaudeProvider);
    });

    it("uses the OpenAI-compatible provider when LLM_BASE_URL is set", () => {
      process.env.LLM_BASE_URL = "http://gateway.local:20128/v1";
      process.env.LLM_MODEL = "cc/claude-sonnet-5";
      const provider = Llm_buildProvider("anthropic-key");
      expect(provider).to.be.instanceOf(OpenAIProvider);
    });

    it("streams through a plain-HTTP gateway with the configured model and key", async () => {
      const requests: { path: string; auth: string; model: string }[] = [];
      const gateway = http.createServer((req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          requests.push({
            path: req.url || "",
            auth: req.headers.authorization || "",
            model: JSON.parse(body).model,
          });
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write('data: {"choices":[{"delta":{"content":"Bench"}}]}\n');
          res.write('data: {"choices":[{"delta":{"content":" Press"}}]}\n');
          res.write("data: [DONE]\n");
          res.end();
        });
      });
      await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
      const port = (gateway.address() as AddressInfo).port;

      try {
        process.env.LLM_BASE_URL = `http://127.0.0.1:${port}/v1`;
        process.env.LLM_MODEL = "cc/claude-sonnet-5";
        process.env.LLM_API_KEY = "gateway-key";
        const provider = Llm_buildProvider("anthropic-key");

        let finish = "";
        for await (const event of provider.generate("system", "user input")) {
          if (event.type === "finish") {
            finish = event.data;
          }
          if (event.type === "error") {
            throw new Error(event.data);
          }
        }

        expect(finish).to.equal("Bench Press");
        expect(requests).to.have.length(1);
        expect(requests[0].path).to.equal("/v1/chat/completions");
        expect(requests[0].auth).to.equal("Bearer gateway-key");
        expect(requests[0].model).to.equal("cc/claude-sonnet-5");
      } finally {
        await new Promise<void>((resolve) => gateway.close(() => resolve()));
      }
    });
  });
});
