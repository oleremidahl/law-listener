import { createClient } from "@supabase/supabase-js"

import { getPublicSupabaseEnv } from "@/lib/env"

export function createSupabaseServerClient() {
  const { url, publicKey } = getPublicSupabaseEnv()

  return createClient(url, publicKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  })
}
