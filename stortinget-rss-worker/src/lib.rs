use worker::*;
use js_sys::Date;

// Internal async job logic that can use `Result` and `?`.
async fn run_scheduled_job(env: Env) -> Result<()> {
    let start = Date::now();
    console_log!("scheduled job: starting fetch");

    // Read config from env vars (wrangler.toml [vars])
    let url = env
        .var("FEED_URL")
        .map_err(|_| Error::RustError("Missing FEED_URL var".into()))?
        .to_string();

    // Build request
    let mut init = RequestInit::new();
    init.with_method(Method::Get);

    let req = Request::new_with_init(&url, &init)?;

    // Execute fetch
    let mut resp = Fetch::Request(req).send().await?;

    if resp.status_code() >= 400 {
        console_error!("fetch failed: status={}", resp.status_code());
        return Ok(());
    }

    // Read body
    let body_text = resp.text().await?;
    let preview_len = body_text.len().min(500);
    let preview = &body_text[..preview_len];
    console_log!(
        "fetch ok: bytes={}, preview=\"{}\"",
        body_text.len(),
        preview
    );

    // TODO: parse RSS/XML and send extracted items to Supabase Edge Function.
    // For MVP: logging is enough.

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
