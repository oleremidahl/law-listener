use js_sys::{Date, Math};
use quick_xml::events::Event;
use quick_xml::Reader;
use serde::{Deserialize, Serialize};
use std::str;
use std::sync::Once;
use tracing::{error, info};
use tracing_subscriber::layer::SubscriberExt;
use tracing_web::MakeWebConsoleWriter;
use worker::*;

const FUNCTION_NAME: &str = "stortinget-rss-worker";

static TRACING_INIT: Once = Once::new();

fn init_tracing() {
    TRACING_INIT.call_once(|| {
        let fmt_layer = tracing_subscriber::fmt::layer()
            .with_writer(MakeWebConsoleWriter::new())
            .with_target(false)
            .with_ansi(false)
            .json();

        let subscriber = tracing_subscriber::registry().with(fmt_layer);

        if let Err(init_error) = tracing::subscriber::set_global_default(subscriber) {
            console_error!("failed_to_initialize_tracing: {:?}", init_error);
        }
    });
}

fn generate_request_id(prefix: &str) -> String {
    let timestamp = Date::now() as u64;
    let random = (Math::random() * 1_000_000_000.0) as u64;
    format!("{}-{}-{}", prefix, timestamp, random)
}

fn resolve_request_id_with_generator<F>(incoming: Option<&str>, generate: F) -> String
where
    F: FnOnce() -> String,
{
    match incoming {
        Some(value) if !value.trim().is_empty() => value.to_string(),
        _ => generate(),
    }
}

fn resolve_request_id(incoming: Option<&str>, prefix: &str) -> String {
    resolve_request_id_with_generator(incoming, || generate_request_id(prefix))
}

fn request_id_from_request(req: &Request, prefix: &str) -> String {
    let incoming = req
        .headers()
        .get("x-request-id")
        .ok()
        .and_then(|value| value);

    resolve_request_id(incoming.as_deref(), prefix)
}

fn set_request_id_header(response: &mut Response, request_id: &str) {
    if let Err(error) = response.headers_mut().set("X-Request-ID", request_id) {
        tracing::error!(
            event = "set_response_request_id_failed",
            function = FUNCTION_NAME,
            request_id = %request_id,
            error = ?error
        );
    }
}

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
                    let text = e
                        .unescape()
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
                current_tag.clear();
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

async fn run_scheduled_job(env: Env, request_id: &str, trigger: &str) -> Result<()> {
    let start = Date::now();
    let kv = env.kv("STORTINGET_STATE")?;

    info!(
        event = "job_started",
        function = FUNCTION_NAME,
        request_id = %request_id,
        trigger = %trigger
    );

    let feed_url = env.var("FEED_URL")?.to_string();
    let edge_function_url = env.var("EDGE_FUNCTION_URL")?.to_string();
    let worker_secret = env.var("STORTINGET_WORKER_SECRET")?.to_string();

    let mut resp = Fetch::Url(feed_url.parse()?).send().await?;
    let body_text = resp.text().await?;
    let all_items = parse_rss_items(&body_text)?;

    if all_items.is_empty() {
        info!(
            event = "feed_empty",
            function = FUNCTION_NAME,
            request_id = %request_id
        );
        return Ok(());
    }

    let last_seen_url: Option<String> = kv.get("latest_seen_url").text().await?;
    let mut new_items = Vec::new();

    for item in all_items {
        if let Some(ref seen_url) = last_seen_url {
            if item.stortinget_link.as_deref() == Some(seen_url) {
                break;
            }
        }
        new_items.push(item);
    }

    if new_items.is_empty() {
        info!(
            event = "no_new_items",
            function = FUNCTION_NAME,
            request_id = %request_id
        );
        return Ok(());
    }

    let payload = serde_json::json!({ "items": new_items });
    let payload_str = serde_json::to_string(&payload)
        .map_err(|e| Error::RustError(format!("JSON error: {:?}", e)))?;

    let headers = Headers::new();
    headers.set("Content-Type", "application/json")?;
    headers.set("x-ingest-secret", &worker_secret)?;
    headers.set("x-request-id", request_id)?;

    let mut edge_init = RequestInit::new();
    edge_init.with_method(Method::Post);
    edge_init.with_headers(headers);
    edge_init.with_body(Some(payload_str.into()));

    let edge_resp = Fetch::Request(Request::new_with_init(&edge_function_url, &edge_init)?)
        .send()
        .await?;
    let status_code = edge_resp.status_code();

    if status_code >= 400 {
        error!(
            event = "edge_ingest_failed",
            function = FUNCTION_NAME,
            request_id = %request_id,
            status_code = status_code
        );
        return Err(Error::RustError("Edge function ingestion failed".into()));
    }

    if let Some(newest_link) = &new_items[0].stortinget_link {
        kv.put("latest_seen_url", newest_link)?.execute().await?;
    }

    let total_time = Date::now() - start;
    info!(
        event = "job_completed",
        function = FUNCTION_NAME,
        request_id = %request_id,
        duration_ms = total_time,
        sent_items = new_items.len()
    );

    Ok(())
}

#[event(scheduled)]
pub async fn scheduled(_event: ScheduledEvent, env: Env, _ctx: ScheduleContext) {
    init_tracing();

    let request_id = generate_request_id("rss-scheduled");
    if let Err(e) = run_scheduled_job(env, &request_id, "scheduled").await {
        error!(
            event = "scheduled_job_error",
            function = FUNCTION_NAME,
            request_id = %request_id,
            error = ?e
        );
    }
}

#[event(fetch)]
pub async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    init_tracing();

    let request_id = request_id_from_request(&req, "rss-fetch");
    if let Err(e) = run_scheduled_job(env, &request_id, "fetch").await {
        error!(
            event = "fetch_job_error",
            function = FUNCTION_NAME,
            request_id = %request_id,
            error = ?e
        );
    }

    let mut response = Response::ok("Worker is running")?;
    set_request_id_header(&mut response, &request_id);
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_date_extracts_iso_date() {
        assert_eq!(
            parse_date("2026-02-12T09:15:00+01:00"),
            Some("2026-02-12".to_string())
        );
    }

    #[test]
    fn parse_date_returns_none_for_invalid_input() {
        assert_eq!(parse_date("unknown"), None);
    }

    #[test]
    fn parse_rss_items_extracts_expected_fields() {
        let xml = r#"
            <rss>
              <channel>
                <item>
                  <title>Lovvedtak 42</title>
                  <link>https://example.com/lov/42</link>
                  <description>Beskrivelse av lovvedtak</description>
                  <dc:date>2026-02-12T09:15:00+01:00</dc:date>
                </item>
              </channel>
            </rss>
        "#;

        let items = parse_rss_items(xml).expect("rss parse should succeed");
        assert_eq!(items.len(), 1);

        let item = &items[0];
        assert_eq!(item.title, "Lovvedtak 42");
        assert_eq!(item.stortinget_id, "Lovvedtak 42");
        assert_eq!(
            item.stortinget_link.as_deref(),
            Some("https://example.com/lov/42")
        );
        assert_eq!(
            item.feed_description.as_deref(),
            Some("Beskrivelse av lovvedtak")
        );
        assert_eq!(item.decision_date.as_deref(), Some("2026-02-12"));
    }

    #[test]
    fn parse_rss_items_handles_incomplete_item_fields() {
        let xml = r#"
            <rss>
              <channel>
                <item>
                  <title>Lovvedtak uten link</title>
                </item>
              </channel>
            </rss>
        "#;

        let items = parse_rss_items(xml).expect("rss parse should succeed");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "Lovvedtak uten link");
        assert_eq!(items[0].stortinget_link, None);
        assert_eq!(items[0].feed_description, None);
        assert_eq!(items[0].decision_date, None);
    }

    #[test]
    fn resolve_request_id_preserves_non_empty_value() {
        let result = resolve_request_id_with_generator(Some("req-123"), || "generated".to_string());
        assert_eq!(result, "req-123");
    }

    #[test]
    fn resolve_request_id_generates_value_when_missing() {
        let result = resolve_request_id_with_generator(None, || "generated-id".to_string());
        assert_eq!(result, "generated-id");
    }

    #[test]
    fn resolve_request_id_generates_value_when_blank() {
        let result = resolve_request_id_with_generator(Some("   "), || "generated-id".to_string());
        assert_eq!(result, "generated-id");
    }
}
