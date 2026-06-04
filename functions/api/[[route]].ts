import { handle } from 'hono/cloudflare-pages'
import { createApp } from '../../server/index'

export const onRequest = handle(createApp())
