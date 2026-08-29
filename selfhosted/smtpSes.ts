import { SendEmailCommandOutput } from "@aws-sdk/client-ses";
import nodemailer, { Transporter } from "nodemailer";
import { ILogUtil } from "../lambda/utils/log";
import { ISesUtil } from "../lambda/utils/ses";

export function SmtpSesUtil_isConfigured(): boolean {
  return !!process.env.SMTP_HOST;
}

export function SmtpSesUtil_transportOptions(): {
  host: string;
  port: number;
  secure: boolean;
  auth?: { user: string; pass: string };
} {
  const host = process.env.SMTP_HOST || "";
  const port = process.env.SMTP_PORT || "587";
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  return {
    host,
    port: parseInt(port, 10),
    secure: port === "465",
    auth: user && pass ? { user, pass } : undefined,
  };
}

export class SmtpSesUtil implements ISesUtil {
  private _smtp?: Transporter;

  constructor(public readonly log: ILogUtil) {}

  private get smtp(): Transporter {
    if (this._smtp == null) {
      this._smtp = nodemailer.createTransport(SmtpSesUtil_transportOptions());
    }
    return this._smtp;
  }

  public async sendEmail(args: {
    destination: string;
    source: string;
    subject: string;
    body: string;
  }): Promise<SendEmailCommandOutput | undefined> {
    const startTime = Date.now();
    const info = await this.smtp.sendMail({
      from: process.env.SMTP_FROM || args.source,
      to: args.destination,
      subject: args.subject,
      text: args.body,
    });
    this.log.log(`SMTP email '${args.subject}' to '${args.destination}' got sent - ${Date.now() - startTime}ms`);
    return { MessageId: info.messageId, $metadata: {} };
  }
}
