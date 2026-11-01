import { type NextRequest, NextResponse } from 'next/server'

/** Tells Server Components which page was asked for (`requireUser()` sends guests back to it after signing in). */
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers)
  headers.set('x-pathname', `${request.nextUrl.pathname}${request.nextUrl.search}`)
  return NextResponse.next({ request: { headers } })
}

export const config = { matcher: ['/((?!api|_next|_caldera|favicon.svg).*)'] }
