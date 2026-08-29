import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

import { ILogUtil } from "./log";
import { Utils_getEnv } from "../utils";

export interface IGoogleServiceAccountPubsub {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  auth_uri: string;
  token_uri: string;
  auth_provider_x509_cert_url: string;
  client_x509_cert_url: string;
}

interface IAllSecrets {
  apiKey: string;
  cookieSecret: string;
  webpushrKey: string;
  webpushrAuthToken: string;
  cryptoKey: string;
  appleAppSharedSecret: string;
  applePrivateKey: string;
  appleKeyId: string;
  appleIssuerId: string;
  googleServiceAccountPubsub: IGoogleServiceAccountPubsub;
  openAiKey: string;
  anthropicApiKey: string;
  applePromotionalOfferKeyId: string;
  applePromotionalOfferPrivateKey: string;
  updatesPrivateKey: string;
}

export interface ISecretsUtil {
  getCookieSecret(): Promise<string>;
  getCryptoKey(): Promise<string>;
  getApiKey(): Promise<string>;
  getWebpushrKey(): Promise<string>;
  getWebpushrAuthToken(): Promise<string>;
  getAppleAppSharedSecret(): Promise<string>;
  getApplePrivateKey(): Promise<string>;
  getAppleKeyId(): Promise<string>;
  getAppleIssuerId(): Promise<string>;
  getGoogleServiceAccountPubsub(): Promise<IGoogleServiceAccountPubsub>;
  getOpenAiKey(): Promise<string>;
  getAnthropicKey(): Promise<string>;
  getApplePromotionalOfferKeyId(): Promise<string>;
  getApplePromotionalOfferPrivateKey(): Promise<string>;
  getUpdatesPrivateKey(): Promise<string>;
}

export class SecretsUtil implements ISecretsUtil {
  private _secrets?: SecretsManagerClient;
  private readonly _cache: Partial<IAllSecrets> = {};

  constructor(public readonly log: ILogUtil) {}

  private get secrets(): SecretsManagerClient {
    if (this._secrets == null) {
      this._secrets = new SecretsManagerClient({});
    }
    return this._secrets;
  }

  private async cache<T extends keyof IAllSecrets>(
    name: T,
    cb: () => Promise<IAllSecrets[T]>
  ): Promise<IAllSecrets[T]> {
    if (this._cache[name] == null) {
      this._cache[name] = await cb();
    }
    const value = this._cache[name] as IAllSecrets[T];
    return value;
  }

  private async getSecret<T extends keyof IAllSecrets>(key: T): Promise<IAllSecrets[T]> {
    const startTime = Date.now();
    const arns = {
      dev: "arn:aws:secretsmanager:us-west-2:366191129585:secret:lftAppSecretsDev-RVo7cG",
      prod: "arn:aws:secretsmanager:us-west-2:366191129585:secret:lftAppSecrets-cRCeI1",
    };
    const result = await this.secrets.send(new GetSecretValueCommand({ SecretId: arns[Utils_getEnv()] }));
    this.log.log("Secret:", key, ` - ${Date.now() - startTime}ms`);
    const json: IAllSecrets = JSON.parse(result.SecretString!);
    return json[key];
  }

  public async getCookieSecret(): Promise<string> {
    return this.cache("cookieSecret", () => this.getSecret("cookieSecret"));
  }

  public async getCryptoKey(): Promise<string> {
    return this.cache("cryptoKey", () => this.getSecret("cryptoKey"));
  }

  public async getApiKey(): Promise<string> {
    return this.cache("apiKey", () => this.getSecret("apiKey"));
  }

  public async getWebpushrKey(): Promise<string> {
    return this.cache("webpushrKey", () => this.getSecret("webpushrKey"));
  }

  public async getWebpushrAuthToken(): Promise<string> {
    return this.cache("webpushrAuthToken", () => this.getSecret("webpushrAuthToken"));
  }

  public async getAppleAppSharedSecret(): Promise<string> {
    return this.cache("appleAppSharedSecret", () => this.getSecret("appleAppSharedSecret"));
  }

  public async getApplePrivateKey(): Promise<string> {
    return this.cache("applePrivateKey", () => this.getSecret("applePrivateKey"));
  }

  public async getAppleKeyId(): Promise<string> {
    return this.cache("appleKeyId", () => this.getSecret("appleKeyId"));
  }

  public async getAppleIssuerId(): Promise<string> {
    return this.cache("appleIssuerId", () => this.getSecret("appleIssuerId"));
  }

  public async getApplePromotionalOfferKeyId(): Promise<string> {
    return this.cache("applePromotionalOfferKeyId", () => this.getSecret("applePromotionalOfferKeyId"));
  }

  public async getApplePromotionalOfferPrivateKey(): Promise<string> {
    return this.cache("applePromotionalOfferPrivateKey", () => this.getSecret("applePromotionalOfferPrivateKey"));
  }

  public async getGoogleServiceAccountPubsub(): Promise<IGoogleServiceAccountPubsub> {
    return this.cache("googleServiceAccountPubsub", () => this.getSecret("googleServiceAccountPubsub"));
  }

  public async getOpenAiKey(): Promise<string> {
    return this.cache("openAiKey", () => this.getSecret("openAiKey"));
  }

  public async getAnthropicKey(): Promise<string> {
    return this.cache("anthropicApiKey", () => this.getSecret("anthropicApiKey"));
  }

  public async getUpdatesPrivateKey(): Promise<string> {
    return this.cache("updatesPrivateKey", async () => {
      try {
        return await this.getSecret("updatesPrivateKey");
      } catch {
        return "";
      }
    });
  }
}

export class EnvSecretsUtil implements ISecretsUtil {
  constructor(public readonly log: ILogUtil) {}

  private required(name: string): string {
    const value = process.env[name];
    if (!value) {
      throw new Error(`Missing required environment variable ${name} - it must be set when self-hosting Liftosaur`);
    }
    return value;
  }

  private optional(name: string): string {
    return process.env[name] || "";
  }

  public async getCookieSecret(): Promise<string> {
    return this.required("LIFTOSAUR_COOKIE_SECRET");
  }

  public async getCryptoKey(): Promise<string> {
    return this.required("LIFTOSAUR_CRYPTO_KEY");
  }

  public async getApiKey(): Promise<string> {
    return this.required("LIFTOSAUR_API_KEY");
  }

  public async getWebpushrKey(): Promise<string> {
    return this.optional("WEBPUSHR_KEY");
  }

  public async getWebpushrAuthToken(): Promise<string> {
    return this.optional("WEBPUSHR_AUTH_TOKEN");
  }

  public async getAppleAppSharedSecret(): Promise<string> {
    return this.optional("APPLE_APP_SHARED_SECRET");
  }

  public async getApplePrivateKey(): Promise<string> {
    return this.optional("APPLE_PRIVATE_KEY");
  }

  public async getAppleKeyId(): Promise<string> {
    return this.optional("APPLE_KEY_ID");
  }

  public async getAppleIssuerId(): Promise<string> {
    return this.optional("APPLE_ISSUER_ID");
  }

  public async getApplePromotionalOfferKeyId(): Promise<string> {
    return this.optional("APPLE_PROMOTIONAL_OFFER_KEY_ID");
  }

  public async getApplePromotionalOfferPrivateKey(): Promise<string> {
    return this.optional("APPLE_PROMOTIONAL_OFFER_PRIVATE_KEY");
  }

  public async getGoogleServiceAccountPubsub(): Promise<IGoogleServiceAccountPubsub> {
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_PUBSUB;
    if (!raw) {
      return {} as IGoogleServiceAccountPubsub;
    }
    try {
      return JSON.parse(raw) as IGoogleServiceAccountPubsub;
    } catch (e) {
      this.log.log("Failed to parse GOOGLE_SERVICE_ACCOUNT_PUBSUB as JSON", e instanceof Error ? e.message : e);
      return {} as IGoogleServiceAccountPubsub;
    }
  }

  public async getOpenAiKey(): Promise<string> {
    return this.optional("OPENAI_API_KEY");
  }

  public async getAnthropicKey(): Promise<string> {
    return this.optional("ANTHROPIC_API_KEY");
  }

  public async getUpdatesPrivateKey(): Promise<string> {
    return this.optional("LIFTOSAUR_UPDATES_PRIVATE_KEY");
  }
}
