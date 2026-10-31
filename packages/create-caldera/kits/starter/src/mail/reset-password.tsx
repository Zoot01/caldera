import { defineMail, useApp } from '@caldera/mail'
import { Body, Button, Container, Head, Heading, Html, Preview, Text } from '@react-email/components'
import { z } from 'zod'

function ResetPassword({ name, url }: { name: string; url: string }) {
  const app = useApp()
  return (
    <Html>
      <Head />
      <Preview>Reset your {app.name} password</Preview>
      <Body style={{ fontFamily: 'system-ui, sans-serif', background: '#f6f6f6' }}>
        <Container style={{ background: '#fff', padding: '24px', borderRadius: '8px' }}>
          <Heading as="h1">Reset your password</Heading>
          <Text>Hi {name}, someone (hopefully you) asked to reset the password of your {app.name} account.</Text>
          <Button href={url} style={{ background: '#111', color: '#fff', padding: '10px 16px', borderRadius: '6px' }}>
            Choose a new password
          </Button>
          <Text>The link works for an hour. If you didn't ask for this, ignore this email: nothing changes.</Text>
        </Container>
      </Body>
    </Html>
  )
}
ResetPassword.PreviewProps = { name: 'Ann', url: 'http://localhost:3000/reset-password?token=example' }

/** Sent by Better Auth (src/auth.ts) after a request on /forgot-password. */
export const ResetPasswordEmail = defineMail({
  name: 'auth.reset-password',
  props: z.object({ name: z.string(), url: z.url() }),
  subject: (_, { app }) => `Reset your ${app.name} password`,
  component: ResetPassword,
})
