import { defineConfig } from '@caldera/core'

export const mail = defineConfig('mail', (env) => ({
  default: env.MAIL_MAILER,
  mailers: {
    log: { driver: 'log' },
    ...(env.RESEND_API_KEY ? { resend: { driver: 'resend', apiKey: env.RESEND_API_KEY } } : {}),
    ...(env.POSTMARK_SERVER_TOKEN ? { postmark: { driver: 'postmark', serverToken: env.POSTMARK_SERVER_TOKEN } } : {}),
    ...(env.SMTP_URL ? { smtp: { driver: 'smtp', url: env.SMTP_URL } } : {}),
    ...(env.SES_REGION && env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? { ses: { driver: 'ses', region: env.SES_REGION, accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY } }
      : {}),
  },
  from: env.MAIL_FROM,
  ...(env.MAIL_REDIRECT_TO ? { redirectTo: env.MAIL_REDIRECT_TO } : {}),
}))
