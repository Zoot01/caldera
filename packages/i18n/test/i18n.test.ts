import { createApp, defineEnv } from '@caldera/core'
import { createRouter, defineRequest, defineRoutes, errorHandler, notFoundHandler, sessionProvider, startSession } from '@caldera/http'
import { defineInertia } from '@caldera/inertia'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { compareSignatures, signatureOf, signatureType } from '../src/icu.js'
import type { Context } from 'hono'
import { createI18n, i18nProvider, zodErrorMap, type I18nConfig, type RequestI18n } from '../src/index.js'
import { createClientTranslator } from '../src/react.js'
import { messages } from './catalog.js'

const i18nOf = (c: Context) => (c.var as { i18n: RequestI18n }).i18n
const config: I18nConfig = { defaultLocale: 'en', locales: ['en', 'fr', 'fr-CA', 'es', 'de'] }
const i18n = (overrides: Partial<I18nConfig> = {}) => createI18n({ ...config, ...overrides }, { messages })
const t = (locale: string, key: string, params?: Record<string, unknown>, overrides?: Partial<I18nConfig>) => (i18n(overrides).translator(locale).t as (k: string, p?: unknown) => string)(key, params)

describe('ICU signatures (what codegen types)', () => {
  it('types each parameter by how the message uses it', () => {
    expect(signatureType(signatureOf('{count, plural, one {# post by {name}} other {# posts}}'))).toBe('{ "count": number; "name": string | number }')
    expect(signatureType(signatureOf('{when, date, medium} at {when, time, short}'))).toBe('{ "when": Date | number }')
    expect(() => signatureOf('{g, select, female {her} male {him}}')).toThrow(/MISSING_OTHER_CLAUSE/) // ICU requires `other`
    expect(signatureType(signatureOf('{g, select, female {her} other {them}}'))).toBe('{ "g": "female" | (string & {}) }')
    expect(signatureType(signatureOf('Read <b>the guide</b>'))).toBe('{ "b": (chunks: string[]) => string }')
    expect(signatureType(signatureOf('Save'))).toBe('{}')
    expect(() => signatureOf('{count, plural, one {x}')).toThrow()
  })

  it('reports where a translation takes different parameters than the canonical message', () => {
    const en = signatureOf('{count, plural, one {# post} other {# posts}} by {name}')
    expect(compareSignatures(en, signatureOf('{count, plural, one {# article} other {# articles}} par {name}'))).toEqual([])
    expect(compareSignatures(en, signatureOf('{count} articles par {author}'))).toEqual(["doesn't use {name}", "uses {author}, which the canonical message doesn't take"])
    expect(compareSignatures(signatureOf('{n, number}'), signatureOf('{n, date}'))).toEqual(['formats {n} as date, not number'])
  })
})

describe('translating', () => {
  it('formats plurals, selects, dates and tags with each locale’s rules', () => {
    expect(t('en', 'posts.count', { count: 0 })).toBe('No posts')
    expect(t('en', 'posts.count', { count: 1 })).toBe('1 post')
    expect(t('en', 'posts.count', { count: 1200 })).toBe('1,200 posts')
    expect(t('fr', 'posts.count', { count: 1200 })).toBe('1 200 articles')
    expect(t('fr', 'posts.by', { gender: 'female' })).toBe('par elle')
    expect(t('fr', 'posts.published', { when: new Date(Date.UTC(2026, 9, 30, 12)) })).toBe('Publié le 30 oct. 2026')
    expect(t('en', 'posts.link', { b: (chunks: string[]) => `<strong>${chunks.join('')}</strong>` })).toBe('Read <strong>the guide</strong>')
  })

  it('falls back through fr-CA → fr → en, and shows the key when nothing has it', () => {
    expect(t('fr-CA', 'common.save')).toBe('Sauvegarder')
    expect(t('fr-CA', 'posts.greeting', { name: 'Ann' })).toBe('Bonjour, Ann !')
    expect(t('fr', 'common.cancel')).toBe('Cancel')
    expect(t('fr', 'nope.missing')).toBe('nope.missing')
    expect(i18n().chain('fr-CA')).toEqual(['fr-CA', 'fr', 'en'])
    expect(i18n({ fallbacks: { de: 'fr' } }).chain('de-AT')).toEqual(['de-AT', 'de', 'fr', 'en'])
  })

  it('marks untranslated text in development, but not a regional locale reading its language', () => {
    const dev = { missing: 'marker' as const }
    expect(t('fr', 'common.cancel', undefined, dev)).toBe('⟦Cancel⟧')
    expect(t('fr', 'nope.missing', undefined, dev)).toBe('⟦nope.missing⟧')
    expect(t('fr-CA', 'posts.greeting', { name: 'Ann' }, dev)).toBe('Bonjour, Ann !')
  })

  it('reports each missing message once', () => {
    const app = i18n()
    const seen: unknown[] = []
    app.onMissing((m) => seen.push(m))
    const fr = app.translator('fr').t as (k: string) => string
    fr('common.cancel')
    fr('common.cancel')
    fr('gone')
    expect(seen).toEqual([
      { key: 'common.cancel', locale: 'fr', foundIn: 'en' },
      { key: 'gone', locale: 'fr', foundIn: null },
    ])
  })

  it('names the message when formatting fails, and caches formatters', () => {
    expect(() => t('en', 'posts.count')).toThrow(/Couldn't format "posts.count" \(en\)/)
    const broken = createI18n(config, { messages: { en: { bad: '{x, plural, one {' } } })
    expect(() => (broken.translator('en').t as (k: string) => string)('bad')).toThrow(/Message "bad" \(en\) isn't valid ICU/)
    const app = i18n()
    expect(app.translator('fr')).toBe(app.translator('fr'))
  })

  it('formats numbers, currency, dates, relative times and lists', () => {
    const fr = i18n().translator('fr')
    expect(fr.currency(1234.5, 'EUR')).toBe('1 234,50 €')
    expect(fr.relativeTime(-1, 'day')).toBe('hier')
    expect(fr.list(['a', 'b', 'c'])).toBe('a, b et c')
    expect(i18n().translator('de').number(1234.5)).toBe('1.234,5')
  })

  it('negotiates Accept-Language against the supported locales', () => {
    const app = i18n()
    expect(app.negotiate('de-CH,de;q=0.9,en;q=0.8')).toBe('de')
    expect(app.negotiate('fr-CA')).toBe('fr-CA')
    expect(app.negotiate('fr-BE;q=0.9, ja;q=1')).toBe('fr')
    expect(app.negotiate('ja, zh;q=0.5')).toBeUndefined()
    expect(app.negotiate('*;q=0.1, xx-??')).toBeUndefined()
    expect(app.match('EN-us')).toBe('en')
  })

  it('refuses an invalid locale tag in the config', () => {
    expect(() => createI18n({ defaultLocale: 'english!', locales: [] }, { messages })).toThrow(/isn't a valid locale tag/)
  })
})

describe('validation messages (Zod error map)', () => {
  const Signup = z.object({
    name: z.string().min(2),
    email: z.email(),
    password: z.string().min(8),
    age: z.number().int().positive(),
    tags: z.array(z.string().max(5)),
    picks: z.array(z.string()).max(2),
    plan: z.enum(['free', 'pro']),
    nickname: z.string().min(2, 'Too short, says the schema'),
  })
  const input = { name: 'A', email: 'nope', password: 'short', age: 0, tags: ['ok', 'toolong'], picks: ['a', 'b', 'c'], plan: 'gold', nickname: 'x' }
  const errors = async (locale: string) => {
    const result = await Signup.safeParseAsync(input, { error: zodErrorMap(i18n().translator(locale)) as never })
    return Object.fromEntries(result.error!.issues.map((i) => [i.path.join('.'), i.message]))
  }

  it('writes English messages with attribute names, plurals and per-field overrides', async () => {
    expect(await errors('en')).toEqual({
      name: 'The name field must be at least 2 characters.',
      email: 'The email address field must be a valid email address.',
      password: 'Pick a longer password (at least 8 characters).',
      age: 'The age field must be greater than 0.',
      'tags.1': 'The tags field must be at most 5 characters.',
      picks: 'The picks field must have at most 2 items.',
      plan: 'The selected plan is invalid.',
      nickname: 'Too short, says the schema',
    })
  })

  it('writes them in the request’s language', async () => {
    const fr = await errors('fr')
    expect(fr.name).toBe('Le champ name doit contenir au moins 2 caractères.')
    expect(fr.email).toBe('Le champ adresse e-mail doit être une adresse e-mail valide.')
    expect(fr.age).toBe('Le champ age doit être supérieur à 0.')
    expect(fr.nickname).toBe('Too short, says the schema')
    expect((await errors('de')).name).toBe('Das Feld name muss mindestens 2 Zeichen lang sein.')
  })

  it('says required for a missing value', async () => {
    const result = await z.object({ title: z.string() }).safeParseAsync({}, { error: zodErrorMap(i18n().translator('es')) as never })
    expect(result.error!.issues[0]!.message).toBe('El campo title es obligatorio.')
  })
})

describe('in an app', () => {
  const Store = defineRequest({ body: z.object({ title: z.string().min(3) }) })
  const routes = defineRoutes('posts')
    .get('count', '/count', (c) => c.json({ text: i18nOf(c).t('posts.count', { count: 3 }), locale: i18nOf(c).locale, source: i18nOf(c).source }))
    .post('store', '/posts', { request: Store }, (c) => c.json(c.req.valid('json')))
    .post('locale', '/locale', (c) => {
      i18nOf(c).setLocale('fr')
      return c.json({ locale: i18nOf(c).locale })
    })
  const build = (user?: { locale: string }) => {
    const app = createApp({ env: defineEnv({}), providers: [i18nProvider(() => config, { messages })] })
    return new Hono()
      .use(app.middleware())
      .use(async (c, next) => {
        if (user) c.set('user' as never, user as never)
        await next()
      })
      .route('/', createRouter(routes).app)
      .onError(errorHandler())
      .notFound(notFoundHandler())
  }
  const get = (path: string, headers: Record<string, string> = {}, user?: { locale: string }) => build(user).request(path, { headers })

  it('picks the locale: user, then cookie, then Accept-Language, then the default, and varies the response', async () => {
    const header = await get('/count', { 'accept-language': 'fr-FR,fr;q=0.9' })
    expect(await header.json()).toEqual({ text: '3 articles', locale: 'fr', source: 'header' })
    expect(header.headers.get('vary')).toContain('Accept-Language')
    expect(await (await get('/count', { 'accept-language': 'fr', cookie: 'caldera_locale=de' })).json()).toMatchObject({ locale: 'de', source: 'cookie' })
    expect(await (await get('/count', { cookie: 'caldera_locale=de' }, { locale: 'es' })).json()).toMatchObject({ locale: 'es', source: 'user' })
    expect(await (await get('/count', { cookie: 'caldera_locale=klingon' })).json()).toMatchObject({ locale: 'en', source: 'default' })
  })

  it('remembers a chosen locale in a cookie', async () => {
    const res = await build().request('/locale', { method: 'POST' })
    expect(await res.json()).toEqual({ locale: 'fr' })
    expect(res.headers.get('set-cookie')).toMatch(/^caldera_locale=fr; Max-Age=31536000; Path=\/; SameSite=Lax/)
  })

  it('sends validation errors and envelope messages in the visitor’s language', async () => {
    const res = await build().request('/posts', { method: 'POST', headers: { 'content-type': 'application/json', 'accept-language': 'fr' }, body: JSON.stringify({ title: 'x' }) })
    expect(res.status).toBe(422)
    expect((await res.json()).error).toMatchObject({ message: 'Les données fournies ne sont pas valides.', fields: { title: ['Le champ title doit contenir au moins 3 caractères.'] } })
    const missing = await get('/nowhere', { 'accept-language': 'es' })
    expect((await missing.json()).error.message).toBe('No encontrado.')
  })

  it('gives a page only its declared messages, in its locale, and sets <html lang>', async () => {
    const app = createApp({ env: defineEnv({}), providers: [sessionProvider(() => ({ keys: ['k'.repeat(32)] })), i18nProvider(() => config, { messages, shared: ['common.*'], pages: { 'Posts/Index': ['posts.count', 'posts.greeting'] } })] })
    const inertia = defineInertia({ version: 'v1', share: (c, { component }) => ({ i18n: i18nOf(c).page(component) }) })
    const server = new Hono()
      .use(app.middleware())
      .use(startSession())
      .use(inertia.middleware())
      .get('/posts', (c) => c.render('Posts/Index' as never, {} as never))
    const json = await (await server.request('/posts', { headers: { 'x-inertia': 'true', 'x-inertia-version': 'v1', 'accept-language': 'fr' } })).json()
    expect(json.props.i18n).toEqual({
      locale: 'fr',
      messages: { 'posts.count': '{count, plural, =0 {Aucun article} one {# article} other {# articles}}', 'posts.greeting': 'Bonjour, {name} !', 'common.save': 'Enregistrer', 'common.cancel': 'Cancel' },
    })
    const html = await (await server.request('/posts', { headers: { 'accept-language': 'fr-CA' } })).text()
    expect(html).toContain('<html lang="fr-CA">')

    // The client formats what it was sent, with the page's locale.
    const client = createClientTranslator(json.props.i18n)
    expect((client.t as (k: string, p?: unknown) => string)('posts.count', { count: 2 })).toBe('2 articles')
    expect((client.t as (k: string) => string)('posts.published')).toBe('⟦posts.published⟧')
  })
})
