import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Edge function that ingests items into `law_proposals`.
// Protected by a shared secret in the `x-ingest-secret` header.
Deno.serve(async (req: Request): Promise<Response> => {
  const secret = req.headers.get("x-ingest-secret");

  if (!secret || secret !== Deno.env.get("STORTINGET_WORKER_SECRET")) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { items } = await req.json();

  const { error } = await supabaseAdmin
    .from("law_proposals")
    .upsert(items, { onConflict: "stortinget_id" });

  if (error) {
    console.error("Error upserting law_proposals", error);
    return new Response("DB error", { status: 500 });
  }

  return new Response("OK", { status: 200 });
});


