import { useT } from '@caldera/i18n/react'
import { Head, Link } from '@inertiajs/react'
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'

// Rendered for people by errorHandler and notFoundHandler (src/http.ts) with the error's status;
// `message` is the error's own, safe to show (a 500's never says what went wrong).
export const messages = ['errors.*']

const TITLED = [403, 404, 419, 429, 500, 503] as const

export default function ErrorPage({ status, message }: { status: number; message: string }) {
  const { t } = useT()
  const titled = TITLED.find((s) => s === status) ?? (status >= 500 ? 500 : undefined)
  const title = titled ? t(`errors.${titled}`) : t('errors.code', { status })
  return (
    <>
      <Head title={title} />
      <main className="mx-auto flex min-h-svh w-full max-w-md flex-col justify-center px-4 pb-24">
        <Card>
          <CardHeader>
            <p className="font-mono text-muted-foreground text-xs">{status}</p>
            <CardTitle className="text-xl">{title}</CardTitle>
            <CardDescription>{message}</CardDescription>
          </CardHeader>
          <CardFooter>
            <Link href="/" className="font-medium text-sm underline underline-offset-4">
              {t('errors.home')}
            </Link>
          </CardFooter>
        </Card>
      </main>
    </>
  )
}
