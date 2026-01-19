import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

Deno.serve(async (req) => {
  // 1. Security Check: Verify the custom secret header
  const incomingSecret = req.headers.get("x-worker-secret");
  const localSecret = Deno.env.get("LAW_MATCHER_WORKER_SECRET");

  console.log("[edge] incomingSecret present:", !!incomingSecret);
  console.log("[edge] localSecret length:", localSecret ? localSecret.length : "undefined");

  if (!incomingSecret || incomingSecret !== localSecret) {
    return new Response(JSON.stringify({ error: "Unauthorized bitch" }), { 
      status: 401, 
      headers: { "Content-Type": "application/json" } 
    });
  }

  try {
    const { proposal_id, extracted_ids } = await req.json();
    
    console.log(`Linking proposal ${proposal_id} to legacy IDs:`, extracted_ids);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );
    console.log("Supabase client initialized.");
   
    const cleanIds = extracted_ids.filter((id: string) => id.trim().length > 0);

    if (cleanIds.length === 0) {
      console.log(`No IDs found by Regex for ${proposal_id}. Marking as is_new_law.`);
      const { error } = await supabase
        .from('law_proposals')
        .update({ is_new_law: true })
        .eq('id', proposal_id);

      if (error) throw error;
      
      return new Response(JSON.stringify({ status: "marked_as_new" }));
    }

    const { data: documents, error: fetchError } = await supabase
      .from('legal_documents')
      .select('id')
      .in('legacy_id', cleanIds);

    if (fetchError) throw fetchError;
   
    if (documents && documents.length > 0) {
      const linkEntries = documents.map(doc => ({
        proposal_id: proposal_id,
        document_id: doc.id
      }));

      const { error: insertError } = await supabase
        .from('proposal_targets')
        .upsert(linkEntries, { onConflict: 'proposal_id,document_id' });

      if (insertError) throw insertError;
      
      return new Response(JSON.stringify({ status: "linked", count: documents.length }));
    } else {
      return new Response(JSON.stringify({ status: "ids_not_found_in_db" }));
    }

  } catch (err) {
    console.error("Error:", err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
});