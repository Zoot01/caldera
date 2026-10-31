import { ArrowRight, Bot, Database, Inbox, LayoutTemplate, Radio, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { CopyCommand } from '@/components/copy-command';
import { WelcomeArt } from '@/components/welcome-art';

// What comes built in: each is a real, tested part of Caldera.
const features = [
  { icon: LayoutTemplate, title: 'Routes and pages', text: 'Hono routes render React pages with Inertia: typed props, forms and validation, no API layer to write.' },
  { icon: Database, title: 'Database', text: 'Models on Drizzle, migrations, factories and seeders. SQLite or Postgres, transactions included.' },
  { icon: ShieldCheck, title: 'Auth and teams', text: 'Sign-up, passkeys, two-factor and email verification with Better Auth, policies for every action, and teams with roles.' },
  { icon: Inbox, title: 'Queues, mail and schedules', text: 'Jobs on Redis, a database or a platform queue; React Email mails; notifications; cron schedules.' },
  { icon: Radio, title: 'Realtime', text: 'Broadcast events to channels with presence, from your own server, Pusher or Cloudflare.' },
  { icon: Bot, title: 'Made for AI agents too', text: 'Every app documents itself in AGENTS.md and ships an MCP server, so coding agents know your routes, models and jobs.' },
];

export default function HomePage() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-16 px-6 py-16 md:py-24">
      <section className="grid overflow-hidden rounded-xl border bg-fd-card md:grid-cols-2">
        <div className="flex flex-col justify-center gap-6 p-8 md:p-12">
          <div className="space-y-3">
            <h1 className="font-medium text-3xl tracking-tight md:text-4xl">The TypeScript framework for web apps</h1>
            <p className="text-fd-muted-foreground">
              Caldera brings Laravel’s batteries-included way of working to TypeScript: everything a real app needs, with one way to do each thing, and it runs on Node, Vercel or Cloudflare.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <ButtonLink href="/docs" primary>
              Get started
              <ArrowRight className="size-4" />
            </ButtonLink>
            <ButtonLink href="/docs/installation">Installation</ButtonLink>
          </div>
          <CopyCommand command="pnpm create caldera my-app" />
        </div>
        <WelcomeArt className="aspect-[12/11] w-full md:aspect-auto md:h-full" />
      </section>

      <section className="space-y-6">
        <h2 className="font-medium text-xl tracking-tight">Built in, from the first commit</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map(({ icon: Icon, title, text }) => (
            <div key={title} className="space-y-2 rounded-xl border bg-fd-card p-5">
              <span className="flex size-8 items-center justify-center rounded-lg border bg-fd-background text-fd-muted-foreground">
                <Icon className="size-4" />
              </span>
              <h3 className="font-medium text-sm">{title}</h3>
              <p className="text-fd-muted-foreground text-sm">{text}</p>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

function ButtonLink({ href, primary = false, children }: { href: string; primary?: boolean; children: ReactNode }) {
  return (
    <Link
      href={href}
      className={
        primary
          ? 'inline-flex h-9 items-center gap-1.5 rounded-lg bg-fd-primary px-4 font-medium text-fd-primary-foreground text-sm transition-colors hover:bg-fd-primary/90'
          : 'inline-flex h-9 items-center gap-1.5 rounded-lg border bg-fd-background px-4 font-medium text-sm transition-colors hover:bg-fd-accent'
      }
    >
      {children}
    </Link>
  );
}
