use worker::*;
use js_sys::Date;
use quick_xml::events::Event;
use quick_xml::Reader;
use serde::{Deserialize, Serialize};
use std::str;

#[derive(Debug, Serialize, Deserialize)]
struct LawProposal {
    stortinget_id: String,
    title: String,
    stortinget_link: Option<String>,
    feed_description: Option<String>,
    decision_date: Option<String>, // ISO date string (YYYY-MM-DD)
}

// Parse RSS XML and extract items
fn parse_rss_items(xml: &str) -> Result<Vec<LawProposal>> {
    let mut reader = Reader::from_str(xml);
    reader.trim_text(true);
    
    let mut items = Vec::new();
    let mut buf = Vec::new();
    let mut current_item: Option<LawProposal> = None;
    let mut current_tag = String::new();
    let mut in_item = false;
    let mut date_text = String::new();
    let mut capturing_date = false;
    
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let name = e.name();
                let name_bytes = name.as_ref();
                let tag_name = str::from_utf8(name_bytes)
                    .map_err(|_| Error::RustError("Invalid UTF-8 in XML".into()))?
                    .to_string();
                
                if tag_name == "item" {
                    in_item = true;
                    current_item = Some(LawProposal {
                        stortinget_id: String::new(),
                        title: String::new(),
                        stortinget_link: None,
                        feed_description: None,
                        decision_date: None,
                    });
                } else if in_item {
                    current_tag = tag_name.to_string();
                    if tag_name == "dc:date" {
                        capturing_date = true;
                        date_text.clear();
                    }
                }
            }
            Ok(Event::Text(e)) => {
                if in_item {
                    let text = e.unescape()
                        .map_err(|_| Error::RustError("Failed to unescape XML".into()))?
                        .to_string();
                    
                    if capturing_date {
                        date_text.push_str(&text);
                    } else {
                        match current_tag.as_str() {
                            "title" => {
                                if let Some(ref mut item) = current_item {
                                    item.title = text.clone();
                                    item.stortinget_id = text; // Same value for both
                                }
                            }
                            "link" => {
                                if let Some(ref mut item) = current_item {
                                    item.stortinget_link = Some(text);
                                }
                            }
                            "description" => {
                                if let Some(ref mut item) = current_item {
                                    item.feed_description = Some(text);
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
            Ok(Event::End(e)) => {
                let name = e.name();
                let name_bytes = name.as_ref();
                let tag_name = str::from_utf8(name_bytes)
                    .map_err(|_| Error::RustError("Invalid UTF-8 in XML".into()))?
                    .to_string();
                
                if tag_name == "item" {
                    if let Some(item) = current_item.take() {
                        items.push(item);
                    }
                    in_item = false;
                    current_tag.clear();
                    capturing_date = false;
                    date_text.clear();
                } else if (tag_name == "dc:date") && in_item {
                    // Finished reading date, parse and store it
                    if let Some(ref mut item) = current_item {
                        if let Some(parsed_date) = parse_date(&date_text) {
                            item.decision_date = Some(parsed_date);
                        }
                    }
                    capturing_date = false;
                    date_text.clear();
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => {
                console_error!("XML parsing error: {:?}", e);
                return Err(Error::RustError(format!("XML parse error: {:?}", e)));
            }
            _ => {}
        }
        buf.clear();
    }
    
    Ok(items)
}

// Parse ISO 8601 date to YYYY-MM-DD format
fn parse_date(date_str: &str) -> Option<String> {
    // Try to parse various date formats and convert to YYYY-MM-DD
    // Common formats: "2024-12-19T10:00:00Z", "2024-12-19", etc.
    if let Some(date_part) = date_str.split('T').next() {
        if date_part.len() >= 10 {
            return Some(date_part[..10].to_string());
        }
    }
    None
}

// Internal async job logic that can use `Result` and `?`.
async fn run_scheduled_job(env: Env) -> Result<()> {
    let start = Date::now();
    console_log!("scheduled job: starting fetch");

    // Read config from env vars
    let feed_url = env
        .var("FEED_URL")
        .map_err(|_| Error::RustError("Missing FEED_URL var".into()))?
        .to_string();
    
    let edge_function_url = env
        .var("EDGE_FUNCTION_URL")
        .map_err(|_| Error::RustError("Missing EDGE_FUNCTION_URL var".into()))?
        .to_string();
    
    let worker_secret = env
        .var("STORTINGET_WORKER_SECRET")
        .map_err(|_| Error::RustError("Missing STORTINGET_WORKER_SECRET var".into()))?
        .to_string();

    // Fetch RSS feed
    let mut init = RequestInit::new();
    init.with_method(Method::Get);
    let req = Request::new_with_init(&feed_url, &init)?;
    let mut resp = Fetch::Request(req).send().await?;

    if resp.status_code() >= 400 {
        console_error!("fetch failed: status={}", resp.status_code());
        return Ok(());
    }

    let body_text = resp.text().await?;
    console_log!("fetch ok: bytes={}", body_text.len());

    // Parse RSS XML
    let parse_start = Date::now();
    let items = parse_rss_items(&body_text)?;
    let parse_duration = Date::now() - parse_start;
    console_log!("parsed {} items in {:.2} ms", items.len(), parse_duration);

    if items.is_empty() {
        console_log!("no items found in RSS feed");
        return Ok(());
    }

    // Send to Edge Function
    let payload = serde_json::json!({ "items": items });
    // log the three first items
    console_log!("first three items: {:?}", items.iter().take(3).collect::<Vec<&LawProposal>>());
    let payload_str = serde_json::to_string(&payload)
        .map_err(|e| Error::RustError(format!("JSON serialization error: {:?}", e)))?;

    let headers = {
        let h = Headers::new();
        h.set("Content-Type", "application/json")?;
        h.set("x-ingest-secret", &worker_secret)?;
        h
    };
    
    let mut edge_init = RequestInit::new();
    edge_init.with_method(Method::Post);
    edge_init.with_headers(headers);
    edge_init.with_body(Some(payload_str.into()));

    let edge_req = Request::new_with_init(&edge_function_url, &edge_init)?;
    let mut edge_resp = Fetch::Request(edge_req).send().await?;
    
    if edge_resp.status_code() >= 400 {
        let error_text = edge_resp.text().await.unwrap_or_else(|_| "Unknown error".into());
        console_error!("edge function error: status={}, body={}", edge_resp.status_code(), error_text);
        return Err(Error::RustError(format!("Edge function failed: {}", edge_resp.status_code())));
    }

    console_log!("successfully sent {} items to edge function", items.len());

    let duration_ms = Date::now() - start;
    console_log!("scheduled job completed in {:.2} ms", duration_ms);

    Ok(())
}

#[event(scheduled)]
pub async fn scheduled(_event: ScheduledEvent, env: Env, _ctx: ScheduleContext) {
    if let Err(e) = run_scheduled_job(env).await {
        console_error!("scheduled job error: {:?}", e);
    }
}

#[event(fetch)]
pub async fn fetch(_req: Request, _env: Env, _ctx: Context) -> Result<Response> {
    Response::ok("Worker is running")
}
