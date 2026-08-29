import { ILogUtil } from "../lambda/utils/log";
import { IGoogleServiceAccountPubsub, ISecretsUtil } from "../lambda/utils/secrets";

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
