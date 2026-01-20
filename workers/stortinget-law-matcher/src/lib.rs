use worker::*;
use serde::{Deserialize, Serialize};
use regex::Regex;
use std::collections::HashSet;

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

    // ... after cleaning HTML text ...
    let extracted_ids = extract_law_ids(&clean_text);

    let law_ids_str = extracted_ids.join(",");
    console_log!("Detected Law IDs: {}", law_ids_str);

    // 6. Send to Supabase Edge Function
    let edge_function_url = env.var("LAW_MATCHER_EDGE_FUNCTION_URL")?.to_string();
    let matcher_secret = env.secret("LAW_MATCHER_WORKER_SECRET")?.to_string();
    console_log!("Step 6: Sending to Edge Function at {}", edge_function_url);
    match send_to_edge_function(&edge_function_url, &matcher_secret, &payload.record.id, &law_ids_str).await {
        Ok(_) => Response::ok("Linked laws successfully"),
        Err(e) => {
            console_log!("Error in edge function: {}", e);
            Response::error("Failed to link laws", 500)
        }
    }   
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

fn extract_law_ids(text: &str) -> Vec<String> {
    // Pattern: "lov" followed by [day]. [month] [year] "nr." [number]
    // Matches: "lov 16. juni 2017 nr. 60"
    let re = Regex::new(r"(?i)lov\s+(\d{1,2})\.\s*([a-zæøå]+)\s+(\d{4})\s+nr\.?\s+(\d+)").unwrap();    
    let mut found_ids = HashSet::new();

    for cap in re.captures_iter(&text.to_lowercase()) {
        let day = format!("{:0>2}", &cap[1]);
        let month_name = &cap[2].to_lowercase();
        let year = &cap[3];
        let nr = &cap[4];

        if let Some(month_num) = map_norwegian_month(month_name) {
            let law_id = format!("LOV-{}-{}-{}-{}", year, month_num, day, nr);
            found_ids.insert(law_id);
        }
    }

    found_ids.into_iter().collect()
}

fn map_norwegian_month(month: &str) -> Option<&'static str> {
    match month {
        "januar" => Some("01"),
        "februar" => Some("02"),
        "mars" => Some("03"),
        "april" => Some("04"),
        "mai" => Some("05"),
        "juni" => Some("06"),
        "juli" => Some("07"),
        "august" => Some("08"),
        "september" => Some("09"),
        "oktober" => Some("10"),
        "november" => Some("11"),
        "desember" => Some("12"),
        _ => None,
    }
}