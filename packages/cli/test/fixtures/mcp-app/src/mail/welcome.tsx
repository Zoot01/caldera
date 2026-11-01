import { defineMail } from '@caldera-js/mail'
import { Body, Html, Text } from '@react-email/components'
import { z } from 'zod'

function Welcome({ name }: { name: string }) {
  return (
    <Html>
      <Body>
        <Text>Hi {name}, welcome.</Text>
      </Body>
    </Html>
  )
}
Welcome.PreviewProps = { name: 'Ann' }

export const WelcomeEmail = defineMail({ name: 'users.welcome', props: z.object({ name: z.string() }), subject: (p) => `Welcome, ${p.name}`, component: Welcome })
