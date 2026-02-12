import { createClient } from "@supabase/supabase-js";
import {
  errorResponse,
  getOrCreateRequestId,
  jsonResponse,
  Logger,
} from "../shared/logger.ts";

const TEST_STORTINGET_ID = "TEST-PROPOSAL-001";

Deno.serve(async (req: Request): Promise<Response> => {
  const requestId = getOrCreateRequestId(req);
  const logger = new Logger("upsert-test-proposal", requestId);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseKey) {
      logger.error("configuration_missing", undefined, {
        has_supabase_url: Boolean(supabaseUrl),
        has_supabase_service_key: Boolean(supabaseKey),
        classification: "infrastructure_error",
      });

      return errorResponse(500, "Internal error", requestId, "config_missing");
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    const testEntry = {
      stortinget_id: TEST_STORTINGET_ID,
      title: "Test Proposal",
      stortinget_link:
        "https://www.stortinget.no/no/Saker-og-publikasjoner/Vedtak/Beslutninger/Lovvedtak/2025-2026/vedtak-202526-017/?utm_medium=rss&utm_source=www.stortinget.no&utm_campaign=Lovvedtak",
    };

    const deleteResult = await supabase
      .from("law_proposals")
      .delete()
      .eq("stortinget_id", TEST_STORTINGET_ID);

    if (deleteResult.error) {
      throw deleteResult.error;
    }

    const upsertResult = await supabase
      .from("law_proposals")
      .upsert(testEntry, {
        onConflict: "stortinget_id",
      })
      .select();

    if (upsertResult.error) {
      throw upsertResult.error;
    }

    logger.info("test_upsert_completed", {
      rows: Array.isArray(upsertResult.data) ? upsertResult.data.length : 0,
    });

    return jsonResponse(
      {
        message: "Upsert successful",
        request_id: requestId,
        data: upsertResult.data,
      },
      200,
      requestId,
    );
  } catch (error) {
    logger.error("test_upsert_failed", error, {
      classification: "infrastructure_error",
    });

    return errorResponse(500, "Internal error", requestId, "upsert_failed");
  }
});
