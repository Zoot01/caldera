import { defineMail } from '@caldera/mail'
import { Body, Html, Text } from '@react-email/components'
import { z } from 'zod'
import { defineChannel, defineNotifiable, defineNotification } from '../../src/index.js'

export const InvoicePaidEmail = defineMail({
  name: 'billing.invoice-paid',
  props: z.object({ name: z.string(), number: z.string(), amount: z.number() }),
  subject: (p) => `Invoice ${p.number} paid`,
  component: ({ name, number, amount }: { name: string; number: string; amount: number }) => (
    <Html>
      <Body>
        <Text>
          Thanks {name}: invoice {number} for ${amount} is paid.
        </Text>
      </Body>
    </Html>
  ),
})

export interface User {
  id: number
  email: string
  name: string
  phone: string | null
  wantsSms: boolean
}

export const Users = defineNotifiable<User>({
  type: 'user',
  id: (u) => u.id,
  routes: { mail: (u) => ({ email: u.email, name: u.name }), sms: (u) => u.phone },
})

export const sms: { to: unknown; text: string; id: string }[] = []
export const smsFailures = { remaining: 0 }
export const Sms = defineChannel<{ text: string }>({
  name: 'sms',
  send: async (message, { notifiable, id }) => {
    if (smsFailures.remaining > 0) {
      smsFailures.remaining--
      throw new Error('sms gateway down')
    }
    sms.push({ to: notifiable.routes.sms, text: message.text, id })
  },
})

export const InvoicePaid = defineNotification({
  name: 'billing.invoice-paid',
  payload: z.object({ number: z.string(), amount: z.number(), name: z.string() }),
  channels: {
    mail: (_n, p) => ({ mail: InvoicePaidEmail, props: { name: p.name, number: p.number, amount: p.amount } }),
    database: {
      schema: z.object({ number: z.string(), amount: z.number() }),
      data: (_n, p) => ({ number: p.number, amount: p.amount }),
    },
    sms: (n, p) => (n.routes.sms ? { text: `Invoice ${p.number} paid` } : null),
  },
  via: (n) => (n.onDemand ? ['mail'] : ['mail', 'database', 'sms']),
})

export const QueuedInvoicePaid = defineNotification({
  name: 'billing.invoice-paid-queued',
  payload: z.object({ number: z.string(), amount: z.number(), name: z.string() }),
  channels: InvoicePaid.channels,
  queue: { perChannel: { mail: { queue: 'mail' } } },
})
