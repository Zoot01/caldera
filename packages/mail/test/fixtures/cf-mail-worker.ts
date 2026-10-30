import { createMail, attach } from '../../src/index.js'
import { WelcomeEmail } from './welcome.js'

export default {
  async fetch(request: Request, env: { EMAIL: unknown }) {
    const mail = createMail({ default: 'cf', mailers: { cf: { driver: 'cloudflare', binding: env.EMAIL } }, from: 'App <hello@example.test>' })
    try {
      const to = new URL(request.url).searchParams.get('to') ?? 'ann@example.test'
      const result = await mail.to({ email: to, name: 'Ann' }).send(WelcomeEmail, { name: 'Ann', loginUrl: 'https://app.example.test/login' })
      return Response.json({ result, attach: typeof attach })
    } catch (error) {
      return Response.json({ error: (error as Error).message, code: (error as { code?: string }).code }, { status: 500 })
    }
  },
}
