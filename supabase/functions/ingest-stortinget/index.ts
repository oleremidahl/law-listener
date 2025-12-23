import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Edge function that ingests items into `law_proposals`.
// Protected by a shared secret in the `x-ingest-secret` header.
Deno.serve(async (req: Request): Promise<Response> => {
  const secret = req.headers.get("x-ingest-secret");
  if (!secret || secret !== Deno.env.get("STORTINGET_WORKER_SECRET")) {
    return new Response("Unauthorized bitch", { status: 401 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !supabaseKey) {
    console.error("Missing environment variables:", {
      hasUrl: !!supabaseUrl,
      hasKey: !!supabaseKey,
    });
    return new Response("Server configuration error", { status: 500 });
  }

  const supabaseAdmin = createClient(supabaseUrl, supabaseKey);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const { items } = await req.json();

  for (const item of items) {
    const { error } = await supabaseAdmin
    .from("law_proposals")
    .upsert(item, { 
      onConflict: "stortinget_id",
      ignoreDuplicates: true
    });
    if (error) {
      console.error(`Error upserting item ${item.stortinget_id}:`, error);      
      continue;
    }

    await sleep(1000); // Allows stortinget-law-matcher to avoid rate limiting
  }

  return new Response("OK", { status: 200 });
});


