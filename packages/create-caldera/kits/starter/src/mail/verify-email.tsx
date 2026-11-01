import { defineMail, useApp } from '@caldera-js/mail'
import { Body, Button, Container, Head, Heading, Html, Preview, Text } from '@react-email/components'
import { z } from 'zod'

function VerifyEmail({ name, url }: { name: string; url: string }) {
  const app = useApp()
  return (
    <Html>
      <Head />
      <Preview>Confirm your email address</Preview>
      <Body style={{ fontFamily: 'system-ui, sans-serif', background: '#f6f6f6' }}>
        <Container style={{ background: '#fff', padding: '24px', borderRadius: '8px' }}>
          <Heading as="h1">Confirm your email address</Heading>
          <Text>Hi {name}, click below to confirm this address for your {app.name} account.</Text>
          <Button href={url} style={{ background: '#111', color: '#fff', padding: '10px 16px', borderRadius: '6px' }}>
            Confirm email address
          </Button>
          <Text>If you didn't create an account, ignore this email.</Text>
        </Container>
      </Body>
    </Html>
  )
}
VerifyEmail.PreviewProps = { name: 'Ann', url: 'http://localhost:3000/api/auth/verify-email?token=example' }

/** Sent by Better Auth (src/auth.ts) on sign-up (with `mustVerifyEmail`), on request, and for a changed address. */
export const VerifyEmailEmail = defineMail({
  name: 'auth.verify-email',
  props: z.object({ name: z.string(), url: z.url() }),
  subject: () => 'Confirm your email address',
  component: VerifyEmail,
})
