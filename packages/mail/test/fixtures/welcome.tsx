import { Body, Button, Container, Head, Html, Preview, Text } from '@react-email/components'
import { z } from 'zod'
import { attach, defineMail } from '../../src/index.js'

function Welcome({ name, loginUrl }: { name: string; loginUrl: string }) {
  return (
    <Html>
      <Head />
      <Preview>Welcome aboard, {name}</Preview>
      <Body style={{ fontFamily: 'sans-serif' }}>
        <Container>
          <Text>Hi {name}, your account is ready.</Text>
          <Button href={loginUrl}>Sign in</Button>
        </Container>
      </Body>
    </Html>
  )
}
Welcome.PreviewProps = { name: 'Ann', loginUrl: 'https://app.example.test/login' }

export const WelcomeEmail = defineMail({
  name: 'users.welcome',
  props: z.object({ name: z.string(), loginUrl: z.url() }),
  subject: (p) => `Welcome, ${p.name}`,
  component: Welcome,
  tags: () => ({ category: 'onboarding' }),
})

export const InvoiceEmail = defineMail({
  name: 'billing.invoice',
  props: z.object({ number: z.string(), pdf: z.string().optional(), size: z.number().default(0) }),
  subject: (p) => `Invoice ${p.number}`,
  component: ({ number }: { number: string }) => (
    <Html>
      <Body>
        <Text>Invoice {number} is attached.</Text>
      </Body>
    </Html>
  ),
  attachments: (p) => [...(p.pdf ? [attach.fromStorage(p.pdf, { filename: `invoice-${p.number}.pdf` })] : []), ...(p.size ? [attach.content(new Uint8Array(p.size), 'big.bin')] : [])],
  preview: { number: 'INV-1' },
})
