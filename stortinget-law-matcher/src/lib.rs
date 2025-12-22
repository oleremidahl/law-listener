use worker::*;
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

    // 2. Fetch Rendered Content from Cloudflare API
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

    /* TODO: IMPLEMENT LATER
       - Send clean_text to Workers AI (Llama 3.1)
       - Parse Law IDs from AI response
       - Lookup Law IDs in 'legal_documents' table
       - Insert matches into 'proposal_targets' table
    */

    Response::ok("Content extracted successfully")
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
