use worker::{web_sys::console, *};
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
struct WebhookPayload {
    record: LawProposal,
}

#[derive(Deserialize, Serialize)]
struct LawProposal {
    id: String, // UUID
    stortinget_link: Option<String>,
}

#[derive(Serialize)]
struct AiMessage {
    role: String,
    content: String,
}

#[derive(Serialize)]
struct AiInput {
    messages: Vec<AiMessage>,
}

#[derive(Deserialize)]
struct AiResponse {
    response: String,
}

#[event(fetch)]
pub async fn main(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    console_error_panic_hook::set_once();
    let mut req = req;
    
    let expected = env.secret("WEBHOOK_SHARED_SECRET")?.to_string();
    let got = req.headers().get("x-webhook-secret")?.unwrap_or_default();
    if got != expected {
        return Response::error("You don't know the secret ;)))", 403);
    }

    // 1. Receive Webhook from Supabase
    let payload: WebhookPayload = match req.json().await {
        Ok(p) => p,
        Err(_) => return Response::error("Invalid JSON payload", 400),
    };

    let target_url = match payload.record.stortinget_link {
        Some(url) => url,
        None => return Response::ok("No link provided in record"),
    };
    console_log!("Step 1: Webhook received");

    // 2. Fetch content
    let html = fetch_html(&target_url).await?;
    console_log!("Step 2: HTML fetched (length: {})", html.len());

    // 3. Extract Content between and 
    let extracted_section = extract_between_comments(
        &html, 
        "<!-- INNHOLD -->", 
        "<!-- /INNHOLD -->",
    ).unwrap_or_else(|| "Target markers not found".to_string());

    // 4. Dumb down: Strip all remaining HTML tags to leave just the text
    let clean_text = strip_html_tags(&extracted_section);

    console_log!("Extracted Clean Text: {}", clean_text);

    // 5. Send clean_text to Workers AI (Llama 3.1)
    let ai = env.ai("AI")?;

    let system_prompt: &str = "Du er en norsk juridisk ekspert. Din oppgave er å trekke ut Law IDs fra en lovtekst som beskriver endringer i eksisterende lover.

        Instruksjoner:
        1. Identifiser hver lov som skal endres. Disse står alltid etter romertall (I, II, III, IV...) og starter med formelen 'I lov [dato] nr. [nummer]'.
        2. Formatet skal være: LOV-YYYY-MM-DD-NN.
        3. VIKTIG: Ikke bland sammen årstall for fødselsdato (f.eks. 'født i 1963') med selve lovens dato. Lovens dato står rett etter ordet 'lov'.
        4. Månedsnavn skal konverteres til tall (januar=01, juni=06, osv.).
        5. IKKE hallusiner lovnummer. Om det ikke eksplisitt står 'nr. XX', skal du IKKE finne på et nummer, og dermed har du ikke funnet en gyldig Id.
        6. Se bort fra teksten til slutt om ikrafttredelse (f.eks. 'Lova gjeld frå...'). Vi skal kun ha lovene som faktisk endres i hovedteksten.
        7. FORMAT: Returner KUN en kommaseparert liste med IDs, INGEN begrunnelser. Hvis ingen treff, returner 'NONE'.

        Eksempel på mapping:
        'I lov 28. juli 1949 nr. 26' -> LOV-1949-07-28-26
        'I lov 26. juni 1953 nr. 11' -> LOV-1953-06-26-11";

    let input = AiInput {
        messages: vec![
            AiMessage { role: "system".into(), content: system_prompt.into() },
            AiMessage { role: "user".into(), content: clean_text },
        ],
    };

    // Using Llama 3.1 8B for extraction
    let ai_response: AiResponse = ai.run("@cf/meta/llama-3.1-8b-instruct", input).await?;
    let law_ids = ai_response.response.trim();

    if law_ids == "NONE" {
        return Response::ok("No law IDs detected");
    }

    console_log!("Detected Law IDs: {}", law_ids);

    let edge_function_url = env.var("LAW_MATCHER_EDGE_FUNCTION_URL")?.to_string();
    let worker_secret = env.secret("LAW_MATCHER_WORKER_SECRET")?.to_string();
    console_log!("Worker secret is empty: {}", worker_secret.is_empty());

    match send_to_edge_function(&edge_function_url, &worker_secret, &payload.record.id, law_ids).await {
        Ok(_) => Response::ok("AI extraction and database linking complete"),
        Err(e) => {
            console_log!("Error in edge function call: {}", e);
            Response::error("Failed to link matched laws", 500)
        }
    }

    // Response::ok("Linked laws successfully");
    
    // TODO: Next steps - Lookup IDs in 'legal_documents' and insert into 'proposal_targets'

    /* TODO: IMPLEMENT LATER
       - Send clean_text to Workers AI (Llama 3.1)
       - Parse Law IDs from AI response
       - Lookup Law IDs in 'legal_documents' table
       - Insert matches into 'proposal_targets' table
    */

    // Response::ok("Content extracted successfully")
}

async fn fetch_html(url: &str) -> Result<String> {
    // Optional: add UA/Accept to reduce “bot blocking”
    
    let headers = Headers::new();
    headers.set("User-Agent", "law-listener/1.0")?;
    headers.set("Accept", "text/html,application/xhtml+xml")?;
    let mut init = RequestInit::new();
    init.with_method(Method::Get);
    init.with_headers(headers);


    let req = Request::new_with_init(url, &init)?;
    let mut resp = Fetch::Request(req).send().await?;

    if resp.status_code() >= 400 {
        let body = resp.text().await.unwrap_or_default();
        return Err(Error::RustError(format!(
            "Fetch error {} for {}: {}",
            resp.status_code(),
            url,
            body
        )));
    }

    Ok(resp.text().await.unwrap_or_default())
}

fn extract_between_comments(html: &str, start: &str, end: &str) -> Option<String> {
    let start_idx = html.find(start)? + start.len();
    let end_idx = html.find(end)?;
    if end_idx > start_idx {
        Some(html[start_idx..end_idx].trim().to_string())
    } else {
        None
    }
}

// Simple tag stripper for the "dumbed down" version
fn strip_html_tags(html: &str) -> String {
    let mut text = String::with_capacity(html.len());
    let mut inside_tag = false;

    // 1. Strip HTML tags
    for c in html.chars() {
        match c {
            '<' => inside_tag = true,
            '>' => inside_tag = false,
            _ if !inside_tag => text.push(c),
            _ => {}
        }
    }

    // 2. Replace &nbsp; and normalize whitespace (incl. \n → " ")
    let text = text
        .replace("&nbsp;", " ")
        .replace("\\r\\n", " ")
        .replace("\\n", " ")
        .replace("\\r", " ")
        .replace("\\t", " ");

    let mut collapsed = String::with_capacity(text.len());
    let mut last_was_space = false;

    for ch in text.chars() {
        if ch.is_whitespace() {
            if !last_was_space {
                collapsed.push(' ');
                last_was_space = true;
            }
        } else {
            collapsed.push(ch);
            last_was_space = false;
        }
    }

    collapsed.trim().to_string()
}

async fn send_to_edge_function(
    url: &str,
    secret: &str,
    proposal_id: &str,
    law_ids: &str,
) -> Result<()> {
    let headers = Headers::new();
    headers.set("Content-Type", "application/json")?;
    headers.set("x-worker-secret", &secret)?;

    let body_json = serde_json::json!({
        "proposal_id": proposal_id,
        "extracted_ids": law_ids.split(',').map(|s| s.trim()).collect::<Vec<&str>>()
        });
    
    console_log!("Sending to edge function: {}", body_json.to_string());

    let mut init = RequestInit::new();
    init
        .with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(wasm_bindgen::JsValue::from_str(&body_json.to_string())));


    let req = Request::new_with_init(url, &init)?;
    
    // Perform the fetch and await the response
    let resp = Fetch::Request(req).send().await?;

    if resp.status_code() != 200 {
        return Err(Error::from(format!("Edge function returned status {}", resp.status_code())));
    }

    Ok(())
}