import { defineSchedule } from '@caldera-js/schedule'
import { Stamp } from '../jobs/stamp.js'

export const nightly = defineSchedule('stamp.nightly', { cron: '0 2 * * *', tz: 'Europe/Paris', job: Stamp, payload: { label: 'nightly' }, onOneServer: true })
