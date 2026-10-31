import { defineMail, useApp } from '@caldera/mail'
import { Body, Button, Container, Head, Heading, Html, Preview, Text } from '@react-email/components'
import { z } from 'zod'

function TeamInvitation({ team, inviter, url }: { team: string; inviter: string; url: string }) {
  const app = useApp()
  return (
    <Html>
      <Head />
      <Preview>
        {inviter} invited you to {team}
      </Preview>
      <Body style={{ fontFamily: 'system-ui, sans-serif', background: '#f6f6f6' }}>
        <Container style={{ background: '#fff', padding: '24px', borderRadius: '8px' }}>
          <Heading as="h1">Join {team}</Heading>
          <Text>
            {inviter} invited you to join the {team} team on {app.name}.
          </Text>
          <Button href={url} style={{ background: '#111', color: '#fff', padding: '10px 16px', borderRadius: '6px' }}>
            See the invitation
          </Button>
          <Text>It's valid for 7 days. If you don't want to join, ignore this email.</Text>
        </Container>
      </Body>
    </Html>
  )
}
TeamInvitation.PreviewProps = { team: 'Acme', inviter: 'Ann', url: 'http://localhost:3000/invitations/example' }

/** Sent by Better Auth's organization plugin (src/teams.ts) when someone is invited to a team. */
export const TeamInvitationEmail = defineMail({
  name: 'teams.invitation',
  props: z.object({ team: z.string(), inviter: z.string(), url: z.url() }),
  subject: (p) => `${p.inviter} invited you to ${p.team}`,
  component: TeamInvitation,
})
