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
    decision_date: Option<String>,
}

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
                
                match name_bytes {
                    b"item" => {
                        in_item = true;
                        current_item = Some(LawProposal {
                            stortinget_id: String::new(),
                            title: String::new(),
                            stortinget_link: None,
                            feed_description: None,
                            decision_date: None,
                        });
                    }
                    b"dc:date" if in_item => {
                        capturing_date = true;
                        date_text.clear();
                    }
                    _ if in_item => {
                        current_tag = str::from_utf8(name_bytes)
                            .map_err(|_| Error::RustError("Invalid UTF-8 in XML tag".into()))?
                            .to_string();
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(e)) => {
                if in_item {
                    let text = e.unescape()
                        .map_err(|_| Error::RustError("Failed to unescape XML".into()))?
                        .into_owned();
                    
                    if capturing_date {
                        date_text.push_str(&text);
                    } else {
                        match current_tag.as_str() {
                            "title" => {
                                if let Some(ref mut item) = current_item {
                                    item.title = text.clone();
                                    item.stortinget_id = text; 
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
                let name_bytes = e.name().into_inner();
                
                match name_bytes {
                    b"item" => {
                        if let Some(item) = current_item.take() {
                            items.push(item);
                        }
                        in_item = false;
                        capturing_date = false;
                    }
                    b"dc:date" if in_item => {
                        if let Some(ref mut item) = current_item {
                            item.decision_date = parse_date(&date_text);
                        }
                        capturing_date = false;
                    }
                    _ => {}
                }
                current_tag.clear(); // Tømmer taggen etter hver slutt-tag for sikkerhet
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(Error::RustError(format!("XML parse error: {:?}", e))),
            _ => {}
        }
        buf.clear();
    }
    Ok(items)
}

fn parse_date(date_str: &str) -> Option<String> {
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
    let kv = env.kv("STORTINGET_STATE")?;

    // 1. Fetch Config & Feed
    let feed_url = env.var("FEED_URL")?.to_string();
    let edge_function_url = env.var("EDGE_FUNCTION_URL")?.to_string();
    let worker_secret = env.var("STORTINGET_WORKER_SECRET")?.to_string();

    let mut resp = Fetch::Url(feed_url.parse()?).send().await?;
    let body_text = resp.text().await?;
    let all_items = parse_rss_items(&body_text)?;

    if all_items.is_empty() {
        return Ok(());
    }

    // 2. Determine what is actually new
    let last_seen_url: Option<String> = kv.get("latest_seen_url").text().await?;
    let mut new_items = Vec::new();

    for item in all_items {
        if let Some(ref seen_url) = last_seen_url {
            // Stop if we encounter the most recent item from the previous run
            if item.stortinget_link.as_deref() == Some(seen_url) {
                break;
            }
        }
        new_items.push(item);
    }

    // 3. Abort if no new data
    if new_items.is_empty() {
        console_log!("No new items found. Aborting execution.");
        return Ok(());
    }

    // 4. Send only new items to Edge Function
    let payload = serde_json::json!({ "items": new_items });
    let payload_str = serde_json::to_string(&payload)
        .map_err(|e| Error::RustError(format!("JSON error: {:?}", e)))?;

    let headers = Headers::new();
    headers.set("Content-Type", "application/json")?;
    headers.set("x-ingest-secret", &worker_secret)?;
    
    let mut edge_init = RequestInit::new();
    edge_init.with_method(Method::Post);
    edge_init.with_headers(headers);
    edge_init.with_body(Some(payload_str.into()));

    let edge_resp = Fetch::Request(Request::new_with_init(&edge_function_url, &edge_init)?).send().await?;
    
    if edge_resp.status_code() >= 400 {
        return Err(Error::RustError("Edge function ingestion failed".into()));
    }

    // 5. Update KV with the newest link from this batch
    // (new_items[0] is the top-most/newest item in the feed)
    if let Some(newest_link) = &new_items[0].stortinget_link {
        kv.put("latest_seen_url", newest_link)?.execute().await?;
    }
    let total_time = Date::now() - start;
    console_log!("Total time taken: {}ms", total_time);

    console_log!("Sent {} new items to edge function.", new_items.len());
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
