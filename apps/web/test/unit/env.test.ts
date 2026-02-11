import { afterEach, describe, expect, it, vi } from "vitest"

const originalEnv = { ...process.env }

afterEach(() => {
  process.env = { ...originalEnv }
  vi.resetModules()
})

describe("getPublicSupabaseEnv", () => {
  it("throws when required env vars are missing", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

    const { getPublicSupabaseEnv } = await import("@/lib/env")

    expect(() => getPublicSupabaseEnv()).toThrow(
      /Missing NEXT_PUBLIC_SUPABASE_URL or key/
    )
  })

  it("returns configured publishable key when present", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co"
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "publishable-key"
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key-ignored"

    const { getPublicSupabaseEnv } = await import("@/lib/env")

    expect(getPublicSupabaseEnv()).toEqual({
      url: "https://example.supabase.co",
      publicKey: "publishable-key",
    })
  })

  it("falls back to anon key for backward compatibility", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co"
    delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key"

    const { getPublicSupabaseEnv } = await import("@/lib/env")

    expect(getPublicSupabaseEnv()).toEqual({
      url: "https://example.supabase.co",
      publicKey: "anon-key",
    })
  })
})
