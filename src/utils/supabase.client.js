import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';

let client;

export function getSupabaseClient() {
  if (!client) {
    client = createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }

  return client;
}
