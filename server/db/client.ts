import { createClient, SupabaseClient } from '@supabase/supabase-js'

// Module-level singleton (safe in Workers — each request gets a fresh isolate in production)
let _client: SupabaseClient | null = null

export function getDb(env: { SUPABASE_URL: string; SUPABASE_SERVICE_ROLE_KEY: string }): SupabaseClient {
  if (!_client) {
    _client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    })
  }
  return _client
}
