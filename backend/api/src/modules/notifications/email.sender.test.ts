import { describe, expect, it } from 'vitest';
import { LogEmailSender, ResendEmailSender, SmtpEmailSender, type SmtpTransport, createEmailSender } from './email.sender';

describe('createEmailSender', () => {
  it('prefers Resend, then SMTP, then the log', () => {
    const smtp = { SMTP_HOST: 'smtp.example.test', SMTP_USER: 'me@example.test', SMTP_PASS: 'app-password' };
    expect(createEmailSender({ RESEND_API_KEY: 're_x', EMAIL_FROM: 'a@b.test', ...smtp })).toBeInstanceOf(ResendEmailSender);
    expect(createEmailSender(smtp)).toBeInstanceOf(SmtpEmailSender);
    expect(createEmailSender({ SMTP_HOST: 'smtp.example.test', SMTP_USER: 'me@example.test' })).toBeInstanceOf(LogEmailSender);
    expect(createEmailSender({})).toBeInstanceOf(LogEmailSender);
  });
});

describe('SmtpEmailSender', () => {
  function fake(fail?: Error) {
    const sent: Parameters<SmtpTransport['sendMail']>[0][] = [];
    const transport: SmtpTransport = {
      async sendMail(message) {
        if (fail) throw fail;
        sent.push(message);
        return { messageId: '<abc@smtp>' };
      },
    };
    return { sent, transport };
  }

  it('sends from the one platform address, with the inviter as Reply-To', async () => {
    const { sent, transport } = fake();
    const sender = new SmtpEmailSender(transport, 'Oraly <team@example.test>');
    const result = await sender.send({ to: 'sam@example.test', subject: 'Hi', text: 'Body', replyTo: 'priya@example.test' });
    expect(result.id).toBe('<abc@smtp>');
    expect(sent).toEqual([{ from: 'Oraly <team@example.test>', to: 'sam@example.test', subject: 'Hi', text: 'Body', replyTo: 'priya@example.test' }]);
  });

  it('reports a failure by code only — the server may echo the envelope back', async () => {
    const error = Object.assign(new Error('535 5.7.8 Username and Password not accepted for me@example.test'), { responseCode: 535 });
    const sender = new SmtpEmailSender(fake(error).transport, 'team@example.test');
    await expect(sender.send({ to: 'sam@example.test', subject: 'Hi', text: 'Body' })).rejects.toThrow(/^smtp send failed: 535$/);
  });
});
