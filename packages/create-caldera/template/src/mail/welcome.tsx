import { defineMail, useApp } from '@caldera/mail'
import { Body, Button, Container, Head, Heading, Html, Preview, Text } from '@react-email/components'
import { z } from 'zod'

function Welcome({ name, url }: { name: string; url: string }) {
  const app = useApp()
  return (
    <Html>
      <Head />
      <Preview>Welcome to {app.name}</Preview>
      <Body style={{ fontFamily: 'system-ui, sans-serif', background: '#f6f6f6' }}>
        <Container style={{ background: '#fff', padding: '24px', borderRadius: '8px' }}>
          <Heading as="h1">Welcome, {name}</Heading>
          <Text>Your account is ready.</Text>
          <Button href={url} style={{ background: '#111', color: '#fff', padding: '10px 16px', borderRadius: '6px' }}>
            Open {app.name}
          </Button>
        </Container>
      </Body>
    </Html>
  )
}
// What the preview page (/_caldera/mail/users.welcome) and tests render.
Welcome.PreviewProps = { name: 'Ann', url: 'http://localhost:3000' }

/** Send with `await mail.to(user).send(WelcomeEmail, { name, url })`, or `.queue(...)`. */
export const WelcomeEmail = defineMail({
  name: 'users.welcome',
  props: z.object({ name: z.string(), url: z.url() }),
  subject: (p, { app }) => `Welcome to ${app.name}, ${p.name}`,
  component: Welcome,
})
