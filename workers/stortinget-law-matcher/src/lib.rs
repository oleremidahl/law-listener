use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::Once;
use std::time::Duration;
use tracing::{error, info, warn};
use tracing_subscriber::layer::SubscriberExt;
use tracing_web::MakeWebConsoleWriter;
use worker::*;

const FUNCTION_NAME: &str = "stortinget-law-matcher";
const RETRY_DELAYS_MS: [u64; 3] = [0, 250, 750];

const ENFORCEMENT_KONGEN_BESTEMMER: &str = "KONGEN_BESTEMMER";
const ENFORCEMENT_STRAKS: &str = "STRAKS";
const ENFORCEMENT_FLERE_DATOER: &str = "FLERE_DATOER";
const ENFORCEMENT_PARSER_IKKE_FUNNET: &str = "PARSER_IKKE_FUNNET";
const ENFORCEMENT_PARSER_FEIL: &str = "PARSER_FEIL";
const ENFORCEMENT_SNIPPET_NONE: &str = "none";

static TRACING_INIT: Once = Once::new();

#[derive(Debug, Clone, PartialEq, Eq)]
struct EnforcementParseResult {
    value: String,
    matched_snippet: String,
    source: &'static str,
}

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

fn parser_fail_result() -> EnforcementParseResult {
    EnforcementParseResult {
        value: ENFORCEMENT_PARSER_FEIL.to_string(),
        matched_snippet: ENFORCEMENT_SNIPPET_NONE.to_string(),
        source: "parser_fail",
    }
}

fn parser_no_match_result() -> EnforcementParseResult {
    EnforcementParseResult {
        value: ENFORCEMENT_PARSER_IKKE_FUNNET.to_string(),
        matched_snippet: ENFORCEMENT_SNIPPET_NONE.to_string(),
        source: "none",
    }
}

fn result_with_match(
    value: &'static str,
    source: &'static str,
    text: &str,
    m: regex::Match<'_>,
) -> EnforcementParseResult {
    EnforcementParseResult {
        value: value.to_string(),
        matched_snippet: snippet_around_match(text, m.start(), m.end()),
        source,
    }
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

    let proposal_id = payload.record.id;
    let target_url = payload.record.stortinget_link;

    info!(
        event = "webhook_received",
        function = FUNCTION_NAME,
        request_id = %request_id,
        proposal_id = proposal_id.as_str()
    );

    // Return early if there's no link - cannot extract without a source
    let Some(url) = target_url.as_deref() else {
        warn!(
            event = "missing_link",
            function = FUNCTION_NAME,
            request_id = %request_id,
            proposal_id = proposal_id.as_str()
        );
        return response_with_request_id(
            Response::ok("Skipped: no stortinget_link")?,
            &request_id,
        );
    };

    // Fetch and parse the text, return early on failure
    let clean_text = match fetch_clean_text_with_retry(url, &request_id).await {
        Ok(text) => text,
        Err(fetch_error) => {
            error!(
                event = "fetch_extract_failed_after_retries",
                function = FUNCTION_NAME,
                request_id = %request_id,
                proposal_id = proposal_id.as_str(),
                stortinget_link = url,
                error = ?fetch_error
            );
            return response_with_request_id(
                Response::error("Failed to fetch source text", 500)?,
                &request_id,
            );
        }
    };

    let extracted_ids = extract_law_ids(&clean_text);
    let enforcement_result = extract_enforcement_date(&clean_text);

    info!(
        event = "law_ids_extracted",
        function = FUNCTION_NAME,
        request_id = %request_id,
        proposal_id = proposal_id.as_str(),
        extracted_ids_count = extracted_ids.len()
    );

    info!(
        event = "enforcement_derived",
        function = FUNCTION_NAME,
        request_id = %request_id,
        proposal_id = proposal_id.as_str(),
        stortinget_link = url,
        enforcement_date = enforcement_result.value.as_str(),
        enforcement_source = enforcement_result.source,
        match_snippet = enforcement_result.matched_snippet.as_str()
    );

    let edge_function_url = env.var("LAW_MATCHER_EDGE_FUNCTION_URL")?.to_string();
    let matcher_secret = env.secret("LAW_MATCHER_WORKER_SECRET")?.to_string();

    match send_to_edge_function(
        &edge_function_url,
        &matcher_secret,
        &proposal_id,
        &extracted_ids,
        &enforcement_result.value,
        &request_id,
    )
    .await
    {
        Ok(_) => {
            info!(
                event = "laws_linked_successfully",
                function = FUNCTION_NAME,
                request_id = %request_id,
                proposal_id = proposal_id.as_str(),
                extracted_ids_count = extracted_ids.len(),
                enforcement_date = enforcement_result.value.as_str()
            );
            response_with_request_id(Response::ok("Linked laws successfully")?, &request_id)
        }
        Err(e) => {
            error!(
                event = "edge_function_error",
                function = FUNCTION_NAME,
                request_id = %request_id,
                proposal_id = proposal_id.as_str(),
                error = ?e
            );
            response_with_request_id(Response::error("Failed to link laws", 500)?, &request_id)
        }
    }
}

async fn fetch_clean_text_with_retry(url: &str, request_id: &str) -> Result<String> {
    let mut last_error: Option<Error> = None;

    for (attempt_idx, delay_ms) in RETRY_DELAYS_MS.iter().copied().enumerate() {
        if delay_ms > 0 {
            Delay::from(Duration::from_millis(delay_ms)).await;
        }

        match fetch_clean_text_once(url, request_id).await {
            Ok(clean_text) => return Ok(clean_text),
            Err(fetch_error) => {
                warn!(
                    event = "fetch_extract_attempt_failed",
                    function = FUNCTION_NAME,
                    request_id = %request_id,
                    url = %url,
                    attempt = attempt_idx + 1,
                    max_attempts = RETRY_DELAYS_MS.len(),
                    error = ?fetch_error
                );
                last_error = Some(fetch_error);
            }
        }
    }

    Err(last_error.unwrap_or_else(|| {
        Error::RustError("Fetch/extraction failed without an explicit error".to_string())
    }))
}

async fn fetch_clean_text_once(url: &str, request_id: &str) -> Result<String> {
    let html = fetch_html(url, request_id).await?;

    let extracted_section =
        extract_between_comments(&html, "<!-- INNHOLD -->", "<!-- /INNHOLD -->").ok_or_else(
            || Error::RustError("Could not find expected INNHOLD section markers".to_string()),
        )?;

    let clean_text = strip_html_tags(&extracted_section);
    if clean_text.trim().is_empty() {
        return Err(Error::RustError(
            "Extracted INNHOLD section is empty after HTML stripping".to_string(),
        ));
    }

    Ok(clean_text)
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
    law_ids: &[String],
    enforcement_date: &str,
    request_id: &str,
) -> Result<()> {
    let headers = Headers::new();
    headers.set("Content-Type", "application/json")?;
    headers.set("x-worker-secret", secret)?;
    headers.set("x-request-id", request_id)?;

    let body_json = serde_json::json!({
        "proposal_id": proposal_id,
        "extracted_ids": law_ids,
        "enforcement_date": enforcement_date,
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
        let Ok(day_num) = cap[1].parse::<u32>() else {
            continue;
        };
        let day = format!("{:0>2}", day_num);
        let month_name = &cap[2].to_lowercase();
        let year = &cap[3];
        let nr = &cap[4];

        if let Some(month_num_str) = map_norwegian_month(month_name) {
            let Ok(year_num) = year.parse::<u32>() else {
                continue;
            };
            let Ok(month_num) = month_num_str.parse::<u32>() else {
                continue;
            };

            // Validate the date
            if !is_valid_date(year_num, month_num, day_num) {
                continue;
            }

            let law_id = format!("LOV-{}-{}-{}-{}", year, month_num_str, day, nr);
            found_ids.insert(law_id);
        }
    }

    found_ids.into_iter().collect()
}

fn extract_enforcement_date(text: &str) -> EnforcementParseResult {
    let straks_re = Regex::new(r"(?i)trer\s+i\s+kraft\s+straks").unwrap();
    if let Some(m) = straks_re.find(text) {
        return result_with_match(ENFORCEMENT_STRAKS, "straks", text, m);
    }

    let kongen_re = Regex::new(r"(?i)(fra\s+den\s+tid\s+)?kongen\s+bestemmer").unwrap();
    if let Some(m) = kongen_re.find(text) {
        return result_with_match(ENFORCEMENT_KONGEN_BESTEMMER, "kongen", text, m);
    }

    let fixed_date_re =
        Regex::new(r"(?i)trer\s+i\s+kraft\s+(\d{1,2})\.\s*([a-zæøå]+)\s+(\d{4})").unwrap();
    for cap in fixed_date_re.captures_iter(text) {
        let Some(full_match) = cap.get(0) else {
            continue;
        };

        let Ok(day_num) = cap[1].parse::<u32>() else {
            continue;
        };
        if !(1..=31).contains(&day_num) {
            continue;
        }

        let Some(month_num_str) = map_norwegian_month(&cap[2].to_lowercase()) else {
            continue;
        };

        let Ok(year_num) = cap[3].parse::<u32>() else {
            continue;
        };

        let Ok(month_num) = month_num_str.parse::<u32>() else {
            continue;
        };

        // Validate the date (e.g., reject "31. februar 2027")
        if !is_valid_date(year_num, month_num, day_num) {
            continue;
        }

        let iso_date = format!("{}-{}-{:0>2}", year_num, month_num_str, day_num);
        return EnforcementParseResult {
            value: iso_date,
            matched_snippet: snippet_around_match(text, full_match.start(), full_match.end()),
            source: "fixed_date",
        };
    }

    let trer_i_kraft_re = Regex::new(r"(?i)trer\s+i\s+kraft").unwrap();
    let has_trer_i_kraft = trer_i_kraft_re.find(text);
    let multi_time_re =
        Regex::new(r"(?i)(ulike\s+tider|forskjellige\s+tidspunkt|til\s+ulike\s+tider)").unwrap();

    let has_multi_signal = text.contains('§') || multi_time_re.is_match(text);
    if let Some(m) = has_trer_i_kraft {
        if has_multi_signal {
            return result_with_match(ENFORCEMENT_FLERE_DATOER, "multi", text, m);
        }
    }

    parser_no_match_result()
}

fn clamp_to_char_boundary_start(value: &str, mut index: usize) -> usize {
    index = index.min(value.len());
    while index > 0 && !value.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn clamp_to_char_boundary_end(value: &str, mut index: usize) -> usize {
    index = index.min(value.len());
    while index < value.len() && !value.is_char_boundary(index) {
        index += 1;
    }
    index
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    let char_count = value.chars().count();
    if char_count <= max_chars {
        return value.to_string();
    }

    let mut truncated = String::with_capacity(max_chars + 3);
    for ch in value.chars().take(max_chars) {
        truncated.push(ch);
    }

    format!("{}...", truncated.trim_end())
}

fn snippet_around_match(text: &str, start: usize, end: usize) -> String {
    let context_bytes = 80;
    let snippet_start = clamp_to_char_boundary_start(text, start.saturating_sub(context_bytes));
    let snippet_end = clamp_to_char_boundary_end(text, (end + context_bytes).min(text.len()));
    let snippet = text[snippet_start..snippet_end].trim();

    if snippet.is_empty() {
        ENFORCEMENT_SNIPPET_NONE.to_string()
    } else {
        truncate_chars(snippet, 200)
    }
}

fn is_valid_date(year: u32, month: u32, day: u32) -> bool {
    if month < 1 || month > 12 {
        return false;
    }

    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            // Check for leap year
            if (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0) {
                29
            } else {
                28
            }
        }
        _ => return false,
    };

    day >= 1 && day <= days_in_month
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
    use std::cell::Cell;

    fn run_retry_simulation<T, E, F>(
        retry_delays_ms: &[u64],
        mut operation: F,
    ) -> std::result::Result<T, E>
    where
        F: FnMut(usize) -> std::result::Result<T, E>,
    {
        let mut last_error: Option<E> = None;

        for attempt_idx in 0..retry_delays_ms.len() {
            match operation(attempt_idx) {
                Ok(value) => return Ok(value),
                Err(error) => last_error = Some(error),
            }
        }

        match last_error {
            Some(error) => Err(error),
            None => panic!("Retry simulation requires at least one attempt"),
        }
    }

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
    fn is_valid_date_accepts_valid_dates() {
        assert!(is_valid_date(2024, 1, 31));  // January 31
        assert!(is_valid_date(2024, 4, 30));  // April 30
        assert!(is_valid_date(2024, 2, 29));  // Feb 29 in leap year
        assert!(is_valid_date(2000, 2, 29));  // Feb 29 in leap year (divisible by 400)
    }

    #[test]
    fn is_valid_date_rejects_invalid_dates() {
        assert!(!is_valid_date(2024, 2, 30)); // Feb 30 doesn't exist
        assert!(!is_valid_date(2027, 2, 31)); // Feb 31 doesn't exist
        assert!(!is_valid_date(2023, 2, 29)); // Feb 29 in non-leap year
        assert!(!is_valid_date(1900, 2, 29)); // Feb 29 in non-leap year (divisible by 100 but not 400)
        assert!(!is_valid_date(2024, 4, 31)); // April 31 doesn't exist
        assert!(!is_valid_date(2024, 6, 31)); // June 31 doesn't exist
        assert!(!is_valid_date(2024, 9, 31)); // September 31 doesn't exist
        assert!(!is_valid_date(2024, 11, 31)); // November 31 doesn't exist
        assert!(!is_valid_date(2024, 0, 15));  // Month 0 doesn't exist
        assert!(!is_valid_date(2024, 13, 15)); // Month 13 doesn't exist
        assert!(!is_valid_date(2024, 1, 0));   // Day 0 doesn't exist
        assert!(!is_valid_date(2024, 1, 32));  // Day 32 doesn't exist
    }

    #[test]
    fn extract_law_ids_ignores_invalid_dates() {
        let text = "lov 31. februar 2027 nr. 99";
        let ids = extract_law_ids(text);
        assert!(ids.is_empty(), "Should reject invalid date like Feb 31");
    }

    #[test]
    fn extract_enforcement_date_rejects_invalid_dates() {
        let text = "Loven trer i kraft 31. februar 2027";
        let result = extract_enforcement_date(text);
        // Should fall through to no match since the invalid date is rejected
        assert_eq!(result.value, ENFORCEMENT_PARSER_IKKE_FUNNET);
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

    #[test]
    fn extract_enforcement_date_from_exact_date_fixture() {
        let text = include_str!("fixtures/enforcement/exact_date.txt");
        let result = extract_enforcement_date(text);

        assert_eq!(result.value, "2027-01-01");
        assert_eq!(result.source, "fixed_date");
        assert_ne!(result.matched_snippet, ENFORCEMENT_SNIPPET_NONE);
    }

    #[test]
    fn extract_enforcement_date_from_straks_fixture() {
        let text = include_str!("fixtures/enforcement/straks.txt");
        let result = extract_enforcement_date(text);

        assert_eq!(result.value, ENFORCEMENT_STRAKS);
        assert_eq!(result.source, "straks");
    }

    #[test]
    fn extract_enforcement_date_from_kongen_fixture() {
        let text = include_str!("fixtures/enforcement/kongen.txt");
        let result = extract_enforcement_date(text);

        assert_eq!(result.value, ENFORCEMENT_KONGEN_BESTEMMER);
        assert_eq!(result.source, "kongen");
    }

    #[test]
    fn extract_enforcement_date_from_multi_fixture() {
        let text = include_str!("fixtures/enforcement/multi.txt");
        let result = extract_enforcement_date(text);

        assert_eq!(result.value, ENFORCEMENT_FLERE_DATOER);
        assert_eq!(result.source, "multi");
    }

    #[test]
    fn extract_enforcement_date_from_no_match_fixture() {
        let text = include_str!("fixtures/enforcement/no_match.txt");
        let result = extract_enforcement_date(text);

        assert_eq!(result.value, ENFORCEMENT_PARSER_IKKE_FUNNET);
        assert_eq!(result.source, "none");
        assert_eq!(result.matched_snippet, ENFORCEMENT_SNIPPET_NONE);
    }

    #[test]
    fn enforcement_priority_straks_over_kongen() {
        let text = "Loven trer i kraft straks, fra den tid Kongen bestemmer.";
        let result = extract_enforcement_date(text);

        assert_eq!(result.value, ENFORCEMENT_STRAKS);
    }

    #[test]
    fn enforcement_priority_kongen_over_fixed_date() {
        let text = "Loven gjelder fra den tid Kongen bestemmer og trer i kraft 1. januar 2027.";
        let result = extract_enforcement_date(text);

        assert_eq!(result.value, ENFORCEMENT_KONGEN_BESTEMMER);
    }

    #[test]
    fn enforcement_priority_fixed_date_over_multi_signal() {
        let text = "Loven trer i kraft 1. januar 2027. § 2 trer i kraft til ulike tider.";
        let result = extract_enforcement_date(text);

        assert_eq!(result.value, "2027-01-01");
    }

    #[test]
    fn snippet_around_match_is_bounded() {
        let long_prefix = "A".repeat(240);
        let text = format!("{} trer i kraft straks {}", long_prefix, "B".repeat(240));

        let result = extract_enforcement_date(&text);
        assert_eq!(result.value, ENFORCEMENT_STRAKS);
        assert!(result.matched_snippet.chars().count() <= 203);
    }

    #[test]
    fn retry_exhaustion_attempts_three_times_then_parser_fail() {
        let attempts = Cell::new(0);

        let fetch_result: std::result::Result<String, &str> =
            run_retry_simulation(&RETRY_DELAYS_MS, |_| {
                attempts.set(attempts.get() + 1);
                Err("simulated extraction failure")
            });

        assert!(fetch_result.is_err());
        assert_eq!(attempts.get(), 3);

        let parser_result = parser_fail_result();
        assert_eq!(parser_result.value, ENFORCEMENT_PARSER_FEIL);
    }

    #[test]
    fn no_match_successful_fetch_does_not_retry() {
        let attempts = Cell::new(0);
        let clean_text_result: std::result::Result<String, &str> = run_retry_simulation(
            &RETRY_DELAYS_MS,
            |_| {
                attempts.set(attempts.get() + 1);
                Ok(
                    "Dette vedtaket beskriver organisering og prosess uten konkret ikrafttredelsesklausul."
                        .to_string(),
                )
            },
        );
        let clean_text = clean_text_result.expect("fetch should succeed on first attempt");

        let parsed = extract_enforcement_date(&clean_text);

        assert_eq!(attempts.get(), 1);
        assert_eq!(parsed.value, ENFORCEMENT_PARSER_IKKE_FUNNET);
    }

    // Tests for HTML extraction
    mod html_extraction {
        use super::*;

        #[test]
        fn extract_between_comments_handles_missing_start_marker() {
            let html = "no start marker hello<!-- /INNHOLD --> after";
            assert_eq!(
                extract_between_comments(html, "<!-- INNHOLD -->", "<!-- /INNHOLD -->"),
                None
            );
        }

        #[test]
        fn extract_between_comments_handles_missing_end_marker() {
            let html = "before <!-- INNHOLD -->hello no end marker";
            assert_eq!(
                extract_between_comments(html, "<!-- INNHOLD -->", "<!-- /INNHOLD -->"),
                None
            );
        }

        #[test]
        fn extract_between_comments_handles_reversed_markers() {
            let html = "before <!-- /INNHOLD -->hello<!-- INNHOLD --> after";
            // Should return None because end comes before start
            assert_eq!(
                extract_between_comments(html, "<!-- INNHOLD -->", "<!-- /INNHOLD -->"),
                None
            );
        }

        #[test]
        fn strip_html_tags_handles_nested_tags() {
            let html = "<div><p><span>nested</span> text</p></div>";
            let text = strip_html_tags(html);
            assert_eq!(text, "nested text");
        }

        #[test]
        fn strip_html_tags_preserves_text_with_no_tags() {
            let html = "plain text without tags";
            let text = strip_html_tags(html);
            assert_eq!(text, "plain text without tags");
        }

        #[test]
        fn strip_html_tags_handles_multiple_nbsp() {
            let html = "one&nbsp;two&nbsp;&nbsp;three";
            let text = strip_html_tags(html);
            assert_eq!(text, "one two three");
        }
    }

    // Tests for law ID extraction edge cases
    mod law_id_extraction {
        use super::*;

        #[test]
        fn extract_law_ids_handles_multiple_different_laws() {
            let text = "lov 16. juni 2017 nr. 60 og lov 21. desember 2005 nr. 123";
            let mut ids = extract_law_ids(text);
            ids.sort();

            assert_eq!(ids.len(), 2);
            assert!(ids.contains(&"LOV-2017-06-16-60".to_string()));
            assert!(ids.contains(&"LOV-2005-12-21-123".to_string()));
        }

        #[test]
        fn extract_law_ids_handles_case_insensitivity() {
            let text = "LOV 16. JUNI 2017 NR. 60";
            let ids = extract_law_ids(text);

            assert_eq!(ids.len(), 1);
            assert!(ids.contains(&"LOV-2017-06-16-60".to_string()));
        }

        #[test]
        fn extract_law_ids_handles_varying_spacing() {
            let text = "lov  16.   juni    2017   nr.   60";
            let ids = extract_law_ids(text);

            assert_eq!(ids.len(), 1);
            assert!(ids.contains(&"LOV-2017-06-16-60".to_string()));
        }

        #[test]
        fn extract_law_ids_handles_single_digit_days() {
            let text = "lov 5. mai 2020 nr. 42";
            let ids = extract_law_ids(text);

            assert_eq!(ids.len(), 1);
            assert!(ids.contains(&"LOV-2020-05-05-42".to_string()));
        }

        #[test]
        fn extract_law_ids_handles_no_matches() {
            let text = "Dette er en tekst uten lovhenvisninger";
            let ids = extract_law_ids(text);
            assert_eq!(ids.len(), 0);
        }
    }

    // Tests for enforcement date extraction edge cases
    mod enforcement_extraction {
        use super::*;

        #[test]
        fn extract_enforcement_date_handles_single_digit_day() {
            let text = "Loven trer i kraft 1. januar 2027";
            let result = extract_enforcement_date(text);

            assert_eq!(result.value, "2027-01-01");
            assert_eq!(result.source, "fixed_date");
        }

        #[test]
        fn extract_enforcement_date_handles_case_insensitivity() {
            let text = "Loven TRER I KRAFT STRAKS";
            let result = extract_enforcement_date(text);

            assert_eq!(result.value, ENFORCEMENT_STRAKS);
        }

        #[test]
        fn extract_enforcement_date_multi_signal_with_section() {
            let text = "Loven trer i kraft. § 5 gjelder fra en annen dato.";
            let result = extract_enforcement_date(text);

            assert_eq!(result.value, ENFORCEMENT_FLERE_DATOER);
            assert_eq!(result.source, "multi");
        }

        #[test]
        fn extract_enforcement_date_multi_signal_with_ulike_tider() {
            let text = "Loven trer i kraft til ulike tider";
            let result = extract_enforcement_date(text);

            assert_eq!(result.value, ENFORCEMENT_FLERE_DATOER);
            assert_eq!(result.source, "multi");
        }

        #[test]
        fn extract_enforcement_date_handles_fra_den_tid_kongen() {
            let text = "Loven trer i kraft fra den tid Kongen bestemmer";
            let result = extract_enforcement_date(text);

            assert_eq!(result.value, ENFORCEMENT_KONGEN_BESTEMMER);
            assert_eq!(result.source, "kongen");
        }

        #[test]
        fn extract_enforcement_date_no_trer_i_kraft() {
            let text = "Dette er en lovtekst uten noen ikrafttredelsesklausul";
            let result = extract_enforcement_date(text);

            assert_eq!(result.value, ENFORCEMENT_PARSER_IKKE_FUNNET);
            assert_eq!(result.source, "none");
        }

        #[test]
        fn snippet_around_match_handles_start_of_text() {
            let text = "trer i kraft straks og videre tekst";
            let result = extract_enforcement_date(text);

            assert_eq!(result.value, ENFORCEMENT_STRAKS);
            assert!(result.matched_snippet.contains("trer i kraft straks"));
        }

        #[test]
        fn snippet_around_match_handles_end_of_text() {
            let text = "lang tekst før slutten trer i kraft straks";
            let result = extract_enforcement_date(text);

            assert_eq!(result.value, ENFORCEMENT_STRAKS);
            assert!(result.matched_snippet.contains("trer i kraft straks"));
        }
    }

    // Tests for retry logic
    mod retry_logic {
        use super::*;

        #[test]
        fn retry_succeeds_on_first_attempt() {
            let attempts = Cell::new(0);

            let result: std::result::Result<String, &str> = run_retry_simulation(
                &RETRY_DELAYS_MS,
                |_| {
                    attempts.set(attempts.get() + 1);
                    Ok("success".to_string())
                },
            );

            assert!(result.is_ok());
            assert_eq!(attempts.get(), 1);
        }

        #[test]
        fn retry_succeeds_on_second_attempt() {
            let attempts = Cell::new(0);

            let result: std::result::Result<String, &str> = run_retry_simulation(
                &RETRY_DELAYS_MS,
                |attempt_idx| {
                    attempts.set(attempts.get() + 1);
                    if attempt_idx == 0 {
                        Err("first attempt failed")
                    } else {
                        Ok("success on retry".to_string())
                    }
                },
            );

            assert!(result.is_ok());
            assert_eq!(attempts.get(), 2);
        }

        #[test]
        fn retry_succeeds_on_third_attempt() {
            let attempts = Cell::new(0);

            let result: std::result::Result<String, &str> = run_retry_simulation(
                &RETRY_DELAYS_MS,
                |attempt_idx| {
                    attempts.set(attempts.get() + 1);
                    if attempt_idx < 2 {
                        Err("early attempts failed")
                    } else {
                        Ok("success on final retry".to_string())
                    }
                },
            );

            assert!(result.is_ok());
            assert_eq!(attempts.get(), 3);
        }
    }

    // Tests for helper functions
    mod helper_functions {
        use super::*;

        #[test]
        fn truncate_chars_handles_short_text() {
            let text = "short";
            assert_eq!(truncate_chars(text, 100), "short");
        }

        #[test]
        fn truncate_chars_truncates_long_text() {
            let text = "a".repeat(300);
            let truncated = truncate_chars(&text, 100);
            assert!(truncated.chars().count() <= 103); // 100 chars + "..."
            assert!(truncated.ends_with("..."));
        }

        #[test]
        fn truncate_chars_handles_exact_length() {
            let text = "a".repeat(100);
            let truncated = truncate_chars(&text, 100);
            assert_eq!(truncated.chars().count(), 100);
            assert!(!truncated.ends_with("..."));
        }

        #[test]
        fn clamp_to_char_boundary_start_handles_valid_index() {
            let text = "hello world";
            assert_eq!(clamp_to_char_boundary_start(text, 5), 5);
        }

        #[test]
        fn clamp_to_char_boundary_start_handles_overflow() {
            let text = "hello";
            assert_eq!(clamp_to_char_boundary_start(text, 100), 5);
        }

        #[test]
        fn clamp_to_char_boundary_end_handles_valid_index() {
            let text = "hello world";
            assert_eq!(clamp_to_char_boundary_end(text, 5), 5);
        }

        #[test]
        fn clamp_to_char_boundary_end_handles_overflow() {
            let text = "hello";
            assert_eq!(clamp_to_char_boundary_end(text, 100), 5);
        }
    }
}
