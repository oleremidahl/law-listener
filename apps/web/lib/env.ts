interface PublicSupabaseEnv {
  url: string
  publicKey: string
}

let cachedEnv: PublicSupabaseEnv | null = null

export function getPublicSupabaseEnv(): PublicSupabaseEnv {
  if (cachedEnv) {
    return cachedEnv
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const publicKey = publishableKey ?? anonKey

  if (!url || !publicKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or key. Set NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (preferred) or NEXT_PUBLIC_SUPABASE_ANON_KEY before running the frontend."
    )
  }

  cachedEnv = { url, publicKey }
  return cachedEnv
}
