use worker::*;
use serde::{Deserialize, Serialize};
use regex::Regex;
use std::collections::HashSet;
use tracing::{info, error, debug, warn};
use tracing_subscriber::layer::SubscriberExt;
use tracing_web::MakeWebConsoleWriter;

fn init_tracing() {
    let fmt_layer = tracing_subscriber::fmt::layer()
        .with_writer(MakeWebConsoleWriter::new())
        .with_target(false)
        .json();

    let subscriber = tracing_subscriber::registry().with(fmt_layer);
    let _ = tracing::subscriber::set_default(subscriber);
}

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
    init_tracing();
    console_error_panic_hook::set_once();
    let mut req = req;
    
    let expected = env.secret("WEBHOOK_SHARED_SECRET")?.to_string();
    let got = req.headers().get("x-webhook-secret")?.unwrap_or_default();
    if got != expected {
        warn!("webhook_secret_mismatch");
        return Response::error("You don't know the secret ;)))", 403);
    }

    let payload: WebhookPayload = match req.json().await {
        Ok(p) => p,
        Err(_) => return Response::error("Invalid JSON payload", 400),
    };

    let target_url = match payload.record.stortinget_link {
        Some(url) => url,
        None => return Response::ok("No link provided in record"),
    };
    info!(proposal_id = payload.record.id, "webhook_received");

    let html = fetch_html(&target_url).await?;
    debug!(html_length = html.len(), "html_fetched");

    let extracted_section = extract_between_comments(
        &html, 
        "<!-- INNHOLD -->", 
        "<!-- /INNHOLD -->",
    ).unwrap_or_else(|| "Target markers not found".to_string());

    let clean_text = strip_html_tags(&extracted_section);

    debug!(clean_text_length = clean_text.len(), "html_tags_stripped");

    let extracted_ids = extract_law_ids(&clean_text);

    info!(
        extracted_ids_count = extracted_ids.len(),
        extracted_ids = ?extracted_ids,
        "law_ids_extracted"
    );

    let edge_function_url = env.var("LAW_MATCHER_EDGE_FUNCTION_URL")?.to_string();
    let matcher_secret = env.secret("LAW_MATCHER_WORKER_SECRET")?.to_string();
    info!(edge_function_url = %edge_function_url, "sending_to_edge_function");
    let law_ids_str = extracted_ids.join(",");
    match send_to_edge_function(&edge_function_url, &matcher_secret, &payload.record.id, &law_ids_str).await {
        Ok(_) => {
            info!(
                proposal_id = payload.record.id,
                extracted_ids_count = extracted_ids.len(),
                "laws_linked_successfully"
            );
            Response::ok("Linked laws successfully")
        },
        Err(e) => {
            error!(error = ?e, proposal_id = payload.record.id, "edge_function_error");
            Response::error("Failed to link laws", 500)
        }
    }   
}

async fn fetch_html(url: &str) -> Result<String> {    
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
        error!(
            status_code = resp.status_code(),
            url = %url,
            body_length = body.len(),
            "fetch_html_error"
        );
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

fn strip_html_tags(html: &str) -> String {
    let mut text = String::with_capacity(html.len());
    let mut inside_tag = false;

    for c in html.chars() {
        match c {
            '<' => inside_tag = true,
            '>' => inside_tag = false,
            _ if !inside_tag => text.push(c),
            _ => {}
        }
    }

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
    
    debug!(body = %body_json, "sending_to_edge_function_payload");

    let mut init = RequestInit::new();
    init
        .with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(wasm_bindgen::JsValue::from_str(&body_json.to_string())));

    let req = Request::new_with_init(url, &init)?;
    
    let resp = Fetch::Request(req).send().await?;

    if resp.status_code() != 200 {
        error!(
            status_code = resp.status_code(),
            proposal_id = proposal_id,
            "edge_function_request_failed"
        );
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