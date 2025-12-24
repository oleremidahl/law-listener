import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

Deno.serve(async (req) => {
  // Use local environment variables provided by the Supabase CLI
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  )

  try {
    // Test data entry
    const testEntry = {
      title: "Test Proposal",
      stortinget_link: "https://www.stortinget.no/no/Saker-og-publikasjoner/Vedtak/Beslutninger/Lovvedtak/2025-2026/vedtak-202526-017/?utm_medium=rss&utm_source=www.stortinget.no&utm_campaign=Lovvedtak"
    }

    const { error: deleteError } = await supabase
      .from('law_proposals')
      .delete()
      .eq('title', 'Test Proposal');

    if (deleteError) throw deleteError;

    const { data, error } = await supabase
      .from('law_proposals')
      .upsert(testEntry, { 
        onConflict: 'stortinget_id' 
      })
      .select()

    if (error) throw error

    return new Response(JSON.stringify({ message: "Upsert successful", data }), {
      headers: { "Content-Type": "application/json" },
      status: 200,
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      headers: { "Content-Type": "application/json" },
      status: 500,
    })
  }
})