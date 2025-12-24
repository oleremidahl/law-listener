import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

Deno.serve(async (req) => {
  // 1. Security Check: Verify the custom secret header
  const incomingSecret = req.headers.get("x-worker-secret");
  const localSecret = Deno.env.get("LAW_MATCHER_WORKER_SECRET");

  if (!incomingSecret || incomingSecret !== localSecret) {
    return new Response(JSON.stringify({ error: "Unauthorized bitch" }), { 
      status: 401, 
      headers: { "Content-Type": "application/json" } 
    });
  }

  try {
    const { proposal_id, extracted_ids } = await req.json();
    
    console.log(`Linking proposal ${proposal_id} to legacy IDs:`, extracted_ids);

    // Initialize Supabase Admin Client (using service role to bypass RLS)
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );
    console.log("Supabase client initialized.");
    // 2. Fetch UUIDs for the matched legacy law IDs
    // .in() is highly efficient for matching an array of strings
    const { data: documents, error: fetchError } = await supabase
      .from('legal_documents')
      .select('id')
      .in('legacy_id', extracted_ids);
    console.log(`Fetched documents:`, documents);
    if (fetchError) throw fetchError;

    if (documents && documents.length > 0) {
      // 3. Prepare the link entries for the join table
      const linkEntries = documents.map(doc => ({
        proposal_id: proposal_id,
        document_id: doc.id
      }));
      console.log("Prepared link entries:", linkEntries);
      // 4. Bulk Insert/Upsert into proposal_targets
      // Using upsert handles cases where the same law is linked twice
      const { error: insertError } = await supabase
        .from('proposal_targets')
        .upsert(linkEntries, { onConflict: 'proposal_id,document_id' });

        if (insertError) throw insertError;
        console.log("Upsert completed.");
    }
    else {
      console.log("No matching legal documents found for the provided legacy IDs.");
    }

    return new Response(
      JSON.stringify({ 
        status: "success", 
        matched_count: documents?.length ?? 0 
      }), 
      { headers: { "Content-Type": "application/json" } }
    );

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { 
      status: 500, 
      headers: { "Content-Type": "application/json" } 
    });
  }
});