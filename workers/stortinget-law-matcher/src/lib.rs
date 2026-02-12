use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::Once;
use tracing::{error, info, warn};
use tracing_subscriber::layer::SubscriberExt;
use tracing_web::MakeWebConsoleWriter;
use worker::*;

const FUNCTION_NAME: &str = "stortinget-law-matcher";

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
    let timestamp = js_sys::Date::now() as u64;
    let random = (js_sys::Math::random() * 1_000_000_000.0) as u64;
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

fn response_with_request_id(mut response: Response, request_id: &str) -> Result<Response> {
    response.headers_mut().set("X-Request-ID", request_id)?;
    Ok(response)
}

#[derive(Deserialize, Serialize)]
struct WebhookPayload {
    record: LawProposal,
}

#[derive(Deserialize, Serialize)]
struct LawProposal {
    id: String,
    stortinget_link: Option<String>,
}

#[event(fetch)]
pub async fn main(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    init_tracing();
    console_error_panic_hook::set_once();

    let request_id = request_id_from_request(&req, "law-matcher");
    let mut req = req;

    let expected = env.secret("WEBHOOK_SHARED_SECRET")?.to_string();
    let got = req.headers().get("x-webhook-secret")?.unwrap_or_default();
    if got != expected {
        warn!(
            event = "webhook_secret_mismatch",
            function = FUNCTION_NAME,
            request_id = %request_id
        );
        return response_with_request_id(Response::error("Unauthorized", 403)?, &request_id);
    }

    let payload: WebhookPayload = match req.json().await {
        Ok(parsed) => parsed,
        Err(_) => {
            warn!(
                event = "invalid_payload",
                function = FUNCTION_NAME,
                request_id = %request_id
            );
            return response_with_request_id(
                Response::error("Invalid JSON payload", 400)?,
                &request_id,
            );
        }
    };

    let target_url = match payload.record.stortinget_link {
        Some(url) => url,
        None => {
            info!(
                event = "missing_link",
                function = FUNCTION_NAME,
                request_id = %request_id,
                proposal_id = payload.record.id.as_str()
            );
            return response_with_request_id(
                Response::ok("No link provided in record")?,
                &request_id,
            );
        }
    };

    info!(
        event = "webhook_received",
        function = FUNCTION_NAME,
        request_id = %request_id,
        proposal_id = payload.record.id.as_str()
    );

    let html = fetch_html(&target_url, &request_id).await?;

    let extracted_section =
        extract_between_comments(&html, "<!-- INNHOLD -->", "<!-- /INNHOLD -->")
            .unwrap_or_else(|| "Target markers not found".to_string());

    let clean_text = strip_html_tags(&extracted_section);
    let extracted_ids = extract_law_ids(&clean_text);

    info!(
        event = "law_ids_extracted",
        function = FUNCTION_NAME,
        request_id = %request_id,
        proposal_id = payload.record.id.as_str(),
        extracted_ids_count = extracted_ids.len()
    );

    let edge_function_url = env.var("LAW_MATCHER_EDGE_FUNCTION_URL")?.to_string();
    let matcher_secret = env.secret("LAW_MATCHER_WORKER_SECRET")?.to_string();
    let law_ids_str = extracted_ids.join(",");

    match send_to_edge_function(
        &edge_function_url,
        &matcher_secret,
        &payload.record.id,
        &law_ids_str,
        &request_id,
    )
    .await
    {
        Ok(_) => {
            info!(
                event = "laws_linked_successfully",
                function = FUNCTION_NAME,
                request_id = %request_id,
                proposal_id = payload.record.id.as_str(),
                extracted_ids_count = extracted_ids.len()
            );
            response_with_request_id(Response::ok("Linked laws successfully")?, &request_id)
        }
        Err(e) => {
            error!(
                event = "edge_function_error",
                function = FUNCTION_NAME,
                request_id = %request_id,
                proposal_id = payload.record.id.as_str(),
                error = ?e
            );
            response_with_request_id(Response::error("Failed to link laws", 500)?, &request_id)
        }
    }
}

async fn fetch_html(url: &str, request_id: &str) -> Result<String> {
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
            event = "fetch_html_failed",
            function = FUNCTION_NAME,
            request_id = %request_id,
            url = %url,
            status_code = resp.status_code(),
            body_length = body.len()
        );

        return Err(Error::RustError(format!(
            "Fetch error {} for {} (body length {})",
            resp.status_code(),
            url,
            body.len()
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
    request_id: &str,
) -> Result<()> {
    let headers = Headers::new();
    headers.set("Content-Type", "application/json")?;
    headers.set("x-worker-secret", secret)?;
    headers.set("x-request-id", request_id)?;

    let body_json = serde_json::json!({
        "proposal_id": proposal_id,
        "extracted_ids": law_ids.split(',').map(|s| s.trim()).collect::<Vec<&str>>()
    });

    let mut init = RequestInit::new();
    init.with_method(Method::Post)
        .with_headers(headers)
        .with_body(Some(wasm_bindgen::JsValue::from_str(
            &body_json.to_string(),
        )));

    let req = Request::new_with_init(url, &init)?;
    let resp = Fetch::Request(req).send().await?;

    if resp.status_code() != 200 {
        error!(
            event = "edge_function_request_failed",
            function = FUNCTION_NAME,
            request_id = %request_id,
            proposal_id = proposal_id,
            status_code = resp.status_code()
        );
        return Err(Error::from(format!(
            "Edge function returned status {}",
            resp.status_code()
        )));
    }

    Ok(())
}

fn extract_law_ids(text: &str) -> Vec<String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_law_ids_finds_and_deduplicates_ids() {
        let text = "lov 16. juni 2017 nr. 60 og LOV 16. juni 2017 nr 60";
        let mut ids = extract_law_ids(text);
        ids.sort();

        assert_eq!(ids, vec!["LOV-2017-06-16-60".to_string()]);
    }

    #[test]
    fn extract_law_ids_ignores_unknown_month() {
        let text = "lov 12. foo 2024 nr. 1";
        let ids = extract_law_ids(text);
        assert!(ids.is_empty());
    }

    #[test]
    fn map_norwegian_month_maps_known_and_unknown() {
        assert_eq!(map_norwegian_month("januar"), Some("01"));
        assert_eq!(map_norwegian_month("desember"), Some("12"));
        assert_eq!(map_norwegian_month("not-a-month"), None);
    }

    #[test]
    fn extract_between_comments_returns_inner_content() {
        let html = "before <!-- INNHOLD -->hello<!-- /INNHOLD --> after";
        assert_eq!(
            extract_between_comments(html, "<!-- INNHOLD -->", "<!-- /INNHOLD -->").as_deref(),
            Some("hello")
        );
    }

    #[test]
    fn strip_html_tags_normalizes_whitespace() {
        let html = "<div>Hei&nbsp;</div><p> verden</p>\\n\\t";
        let text = strip_html_tags(html);
        assert_eq!(text, "Hei verden");
    }

    #[test]
    fn resolve_request_id_preserves_non_empty_value() {
        let result = resolve_request_id_with_generator(Some("req-abc"), || "generated".to_string());
        assert_eq!(result, "req-abc");
    }

    #[test]
    fn resolve_request_id_generates_when_missing_or_blank() {
        let missing = resolve_request_id_with_generator(None, || "gen-1".to_string());
        let blank = resolve_request_id_with_generator(Some("  "), || "gen-2".to_string());

        assert_eq!(missing, "gen-1");
        assert_eq!(blank, "gen-2");
    }
}
