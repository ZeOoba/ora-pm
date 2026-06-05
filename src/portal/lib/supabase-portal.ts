import { createClient } from '@supabase/supabase-js'

// Portal uses anon key + user's JWT — service role NEVER goes to the browser
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string

export const portalSupabase = createClient(supabaseUrl, supabaseAnonKey)
