import { SESClient, SendEmailCommand, SendEmailCommandOutput } from "@aws-sdk/client-ses";
import nodemailer, { Transporter } from "nodemailer";
import { ILogUtil } from "./log";

export interface ISesUtil {
  sendEmail(args: {
    destination: string;
    source: string;
    subject: string;
    body: string;
  }): Promise<SendEmailCommandOutput | undefined>;
}

export class SesUtil implements ISesUtil {
  private _ses?: SESClient;
  private _smtp?: Transporter;

  constructor(public readonly log: ILogUtil) {}

  private get ses(): SESClient {
    if (this._ses == null) {
      this._ses = new SESClient({});
    }
    return this._ses;
  }

  private get smtp(): Transporter | undefined {
    const host = process.env.SMTP_HOST;
    if (!host) {
      return undefined;
    }
    if (this._smtp == null) {
      const port = process.env.SMTP_PORT || "587";
      const user = process.env.SMTP_USER;
      const pass = process.env.SMTP_PASS;
      this._smtp = nodemailer.createTransport({
        host,
        port: parseInt(port, 10),
        secure: port === "465",
        auth: user && pass ? { user, pass } : undefined,
      });
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
    const smtp = this.smtp;
    if (smtp != null) {
      const info = await smtp.sendMail({
        from: process.env.SMTP_FROM || args.source,
        to: args.destination,
        subject: args.subject,
        text: args.body,
      });
      this.log.log(`SMTP email '${args.subject}' to '${args.destination}' got sent - ${Date.now() - startTime}ms`);
      return { MessageId: info.messageId, $metadata: {} };
    }
    const result = await this.ses.send(
      new SendEmailCommand({
        Destination: { ToAddresses: [args.destination] },
        Source: args.source,
        Message: { Subject: { Data: args.subject }, Body: { Text: { Data: args.body } } },
      })
    );
    this.log.log(`SES email '${args.subject}' to '${args.destination}' got sent - ${Date.now() - startTime}ms`);
    return result;
  }
}
