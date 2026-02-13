interface SummaryServerEnv {
  summaryEdgeFunctionUrl: string
  summaryTriggerSecret: string
}

let cachedSummaryEnv: SummaryServerEnv | null = null

function deriveSummaryEdgeFunctionUrl(): string | null {
  const direct = process.env.SUMMARY_EDGE_FUNCTION_URL?.trim()
  if (direct) {
    return direct
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  if (!supabaseUrl) {
    return null
  }

  return `${supabaseUrl}/functions/v1/generate-proposal-summary`
}

export function getSummaryServerEnv(): SummaryServerEnv {
  if (cachedSummaryEnv) {
    return cachedSummaryEnv
  }

  const summaryEdgeFunctionUrl = deriveSummaryEdgeFunctionUrl()
  const summaryTriggerSecret = process.env.SUMMARY_TRIGGER_SECRET?.trim()

  if (!summaryEdgeFunctionUrl || !summaryTriggerSecret) {
    throw new Error(
      "Missing summary generation env vars. Set SUMMARY_EDGE_FUNCTION_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUMMARY_TRIGGER_SECRET."
    )
  }

  cachedSummaryEnv = {
    summaryEdgeFunctionUrl,
    summaryTriggerSecret,
  }

  return cachedSummaryEnv
}
