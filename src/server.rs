use std::{
    collections::HashSet,
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, anyhow, bail, ensure};
use axum::{
    Json, Router,
    extract::{
        DefaultBodyLimit, State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{HeaderMap, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use futures_util::SinkExt;
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, mpsc, oneshot};
use url::Url;

use crate::{
    input::{InputHandle, LEASE},
    protocol::{Command, Frame, MAX_FRAME_BYTES},
};

const IO_TIMEOUT: Duration = Duration::from_millis(900);

pub fn secret() -> Result<String> {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).map_err(|error| anyhow!("OS randomness unavailable: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn same_secret(left: &str, right: &str) -> bool {
    left.len() == right.len()
        && left
            .bytes()
            .zip(right.bytes())
            .fold(0, |diff, (a, b)| diff | (a ^ b))
            == 0
}

pub struct Settings {
    pub address: SocketAddr,
    pub public_url: Option<Url>,
    pub no_qr: bool,
    pub backend: Option<InputHandle>,
    pub daemon_token: String,
    pub dry_run: bool,
}

struct Pairing {
    ticket: Option<String>,
    expires: Instant,
    credential: Option<String>,
    attempts: u32,
    window: Instant,
}

struct Owner {
    id: String,
    last_seen: Instant,
    sequence: u32,
}

pub struct RemoteRequest {
    pub command: Command,
    pub reply: oneshot::Sender<Result<()>>,
}

struct RemoteLink {
    id: String,
    sender: mpsc::Sender<RemoteRequest>,
    platform: String,
    dry_run: bool,
}

struct App {
    pairing: Mutex<Pairing>,
    owner: Mutex<Option<Owner>>,
    local: Option<InputHandle>,
    remote: Mutex<Option<RemoteLink>>,
    daemon_token: String,
    hosts: HashSet<String>,
    dry_run: bool,
    stopping: tokio::sync::watch::Sender<bool>,
}

impl App {
    async fn execute(&self, command: Command) -> Result<()> {
        if let Some(input) = &self.local {
            return input.execute(command).await;
        }
        let sender = self
            .remote
            .lock()
            .await
            .as_ref()
            .context("computer daemon is offline")?
            .sender
            .clone();
        let (reply, result) = oneshot::channel();
        sender
            .try_send(RemoteRequest { command, reply })
            .context("daemon queue unavailable")?;
        tokio::time::timeout(IO_TIMEOUT, result)
            .await
            .context("daemon timed out; result is uncertain")?
            .context("daemon disconnected; result is uncertain")?
    }

    async fn release(&self) {
        if let Err(error) = self.execute(Command::Release).await {
            tracing::error!(%error, "release failed; native watchdog remains active");
        }
    }
}

pub async fn serve(settings: Settings) -> Result<()> {
    let interfaces =
        if_addrs::get_if_addrs().context("cannot enumerate local network interfaces")?;
    let mut hosts: HashSet<String> = ["localhost", "127.0.0.1", "[::1]", "::1"]
        .into_iter()
        .map(str::to_owned)
        .collect();
    for interface in &interfaces {
        hosts.insert(interface.ip().to_string());
        if interface.ip().is_ipv6() {
            hosts.insert(format!("[{}]", interface.ip()));
        }
    }
    if !settings.address.ip().is_unspecified() {
        hosts.insert(settings.address.ip().to_string());
    }
    if let Some(url) = &settings.public_url {
        ensure!(
            matches!(url.scheme(), "http" | "https"),
            "public URL must use HTTP(S)"
        );
        ensure!(
            url.path() == "/"
                && url.query().is_none()
                && url.fragment().is_none()
                && url.username().is_empty()
                && url.password().is_none(),
            "public URL must contain only an origin, without credentials, path, query or fragment"
        );
        hosts.insert(
            url.host_str()
                .context("public URL needs a host")?
                .to_owned(),
        );
    }
    let ticket = secret()?;
    let (stopping, _) = tokio::sync::watch::channel(false);
    let state = Arc::new(App {
        pairing: Mutex::new(Pairing {
            ticket: Some(ticket.clone()),
            expires: Instant::now() + Duration::from_secs(300),
            credential: None,
            attempts: 0,
            window: Instant::now(),
        }),
        owner: Mutex::new(None),
        local: settings.backend,
        remote: Mutex::new(None),
        daemon_token: settings.daemon_token,
        hosts,
        dry_run: settings.dry_run,
        stopping,
    });
    let router = Router::new()
        .route("/", get(index))
        .route("/app.mjs", get(app_js))
        .route("/protocol.mjs", get(protocol_js))
        .route("/transport.mjs", get(transport_js))
        .route("/touchpad.mjs", get(touchpad_js))
        .route("/style.css", get(css))
        .route("/api/pair", post(pair))
        .route("/health", get(health))
        .route("/ws/control", get(control_upgrade))
        .route("/ws/daemon", get(daemon_upgrade))
        .fallback(|| async { StatusCode::NOT_FOUND })
        .layer(DefaultBodyLimit::max(2048))
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind(settings.address).await?;
    let port = listener.local_addr()?.port();
    let mut urls = Vec::new();
    if let Some(url) = settings.public_url {
        urls.push(url.to_string());
    } else {
        if settings.address.ip().is_unspecified() {
            for interface in interfaces {
                if let IpAddr::V4(ip) = interface.ip()
                    && !ip.is_loopback()
                    && !urls.contains(&format!("http://{ip}:{port}/"))
                {
                    urls.push(format!("http://{ip}:{port}/"));
                }
            }
        }
        let host = if settings.address.ip().is_unspecified() {
            IpAddr::from([127, 0, 0, 1])
        } else {
            settings.address.ip()
        };
        urls.push(format!("http://{}/", SocketAddr::new(host, port)));
    }
    println!(
        "\nWeb Controller — {}",
        if state.dry_run { "DRY RUN" } else { "READY" }
    );
    println!("Pair once within 5 minutes. This link grants keyboard access; do not share it.");
    for url in &urls {
        println!("PAIR_URL={url}#pair={ticket}");
    }
    if !settings.no_qr {
        let code = qrcode::QrCode::new(format!("{}#pair={ticket}", urls[0]))?;
        println!(
            "{}",
            code.render::<qrcode::render::unicode::Dense1x2>()
                .dark_color(qrcode::render::unicode::Dense1x2::Light)
                .light_color(qrcode::render::unicode::Dense1x2::Dark)
                .build()
        );
    }
    println!("HTTP/WS is unencrypted: use only on a trusted LAN, or configure HTTPS termination.");
    if state.local.is_none() {
        println!("Relay mode: waiting for an authenticated daemon.");
        if state.daemon_token.is_empty() {
            bail!("relay mode requires a daemon token");
        }
    }
    let monitor_state = state.clone();
    let monitor = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(100));
        loop {
            interval.tick().await;
            let mut owner = monitor_state.owner.lock().await;
            if owner
                .as_ref()
                .is_some_and(|owner| owner.last_seen.elapsed() >= LEASE)
            {
                *owner = None;
                monitor_state.release().await;
                tracing::warn!("controller lease expired; held keys released");
            }
        }
    });
    let shutdown_state = state.clone();
    let result = axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            if let Err(error) = crate::shutdown_signal().await {
                tracing::error!(%error, "shutdown signal handler failed");
            }
            let _ = shutdown_state.stopping.send(true);
            let mut owner = shutdown_state.owner.lock().await;
            *owner = None;
            shutdown_state.release().await;
        })
        .await;
    monitor.abort();
    result.context("HTTP server failed")
}

async fn guard(
    State(state): State<Arc<App>>,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    let host = request
        .headers()
        .get("host")
        .and_then(|host| host.to_str().ok())
        .and_then(|host| Url::parse(&format!("http://{host}")).ok());
    if !host
        .as_ref()
        .and_then(Url::host_str)
        .is_some_and(|host| state.hosts.contains(host))
    {
        return (StatusCode::FORBIDDEN, "host not allowed").into_response();
    }
    if let Some(origin) = request.headers().get("origin") {
        let valid = origin
            .to_str()
            .ok()
            .and_then(|origin| Url::parse(origin).ok())
            .is_some_and(|origin| {
                let host = host.as_ref().expect("host checked above");
                matches!(origin.scheme(), "http" | "https")
                    && origin.host_str() == host.host_str()
                    && origin.port_or_known_default()
                        == request
                            .headers()
                            .get("host")
                            .and_then(|value| value.to_str().ok())
                            .and_then(|value| {
                                Url::parse(&format!("{}://{value}", origin.scheme())).ok()
                            })
                            .and_then(|url| url.port_or_known_default())
            });
        if !valid {
            return (StatusCode::FORBIDDEN, "origin not allowed").into_response();
        }
    }
    let mut response = next.run(request).await;
    for (name, value) in [
        ("cache-control", "no-store"),
        ("referrer-policy", "no-referrer"),
        ("x-content-type-options", "nosniff"),
        ("x-frame-options", "DENY"),
        (
            "content-security-policy",
            "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        ),
    ] {
        response
            .headers_mut()
            .insert(name, HeaderValue::from_static(value));
    }
    response
}

async fn index() -> impl IntoResponse {
    axum::response::Html(include_str!("../web/index.html"))
}

async fn app_js() -> impl IntoResponse {
    (
        [("content-type", "text/javascript; charset=utf-8")],
        include_str!("../web/app.mjs"),
    )
}

async fn protocol_js() -> impl IntoResponse {
    (
        [("content-type", "text/javascript; charset=utf-8")],
        include_str!("../web/protocol.mjs"),
    )
}

async fn transport_js() -> impl IntoResponse {
    (
        [("content-type", "text/javascript; charset=utf-8")],
        include_str!("../web/transport.mjs"),
    )
}

async fn touchpad_js() -> impl IntoResponse {
    (
        [("content-type", "text/javascript; charset=utf-8")],
        include_str!("../web/touchpad.mjs"),
    )
}

async fn css() -> impl IntoResponse {
    (
        [("content-type", "text/css; charset=utf-8")],
        include_str!("../web/style.css"),
    )
}

async fn health(State(state): State<Arc<App>>) -> Json<serde_json::Value> {
    let remote = state.remote.lock().await;
    let dry_run = if state.local.is_some() {
        Some(state.dry_run)
    } else {
        remote.as_ref().map(|remote| remote.dry_run)
    };
    Json(serde_json::json!({
        "status": "ok",
        "protocol": 1,
        "mode": if state.local.is_some() { "local" } else { "relay" },
        "daemon_online": state.local.is_some() || remote.is_some(),
        "dry_run": dry_run,
    }))
}

#[derive(Deserialize)]
struct PairRequest {
    ticket: String,
}

async fn pair(
    State(state): State<Arc<App>>,
    headers: HeaderMap,
    Json(request): Json<PairRequest>,
) -> Response {
    if !headers.contains_key("origin") {
        return (StatusCode::FORBIDDEN, "origin required").into_response();
    }
    let mut pairing = state.pairing.lock().await;
    if pairing.window.elapsed() >= Duration::from_secs(60) {
        pairing.attempts = 0;
        pairing.window = Instant::now();
    }
    pairing.attempts += 1;
    if pairing.attempts > 10 {
        return (StatusCode::TOO_MANY_REQUESTS, "too many pairing attempts").into_response();
    }
    if pairing.expires <= Instant::now()
        || !pairing
            .ticket
            .as_ref()
            .is_some_and(|ticket| same_secret(ticket, &request.ticket))
    {
        return (
            StatusCode::UNAUTHORIZED,
            "pairing link expired, used, or invalid",
        )
            .into_response();
    }
    match secret() {
        Ok(token) => {
            pairing.ticket = None;
            pairing.credential = Some(token.clone());
            Json(serde_json::json!({ "token": token })).into_response()
        }
        Err(error) => {
            tracing::error!(%error, "could not issue pairing credential");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

fn socket_limits(ws: WebSocketUpgrade) -> WebSocketUpgrade {
    ws.max_message_size(MAX_FRAME_BYTES)
        .max_frame_size(MAX_FRAME_BYTES)
        .write_buffer_size(0)
        .max_write_buffer_size(64 * 1024)
}

async fn control_upgrade(
    State(state): State<Arc<App>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if !headers.contains_key("origin") {
        return (StatusCode::FORBIDDEN, "origin required").into_response();
    }
    socket_limits(ws)
        .on_upgrade(move |socket| async move {
            if let Err(error) = control(socket, state).await {
                tracing::debug!(%error, "controller disconnected");
            }
        })
        .into_response()
}

#[derive(Deserialize)]
struct Hello {
    token: String,
    platform: Option<String>,
    dry_run: Option<bool>,
}

#[derive(Serialize, Deserialize)]
pub struct Ack {
    pub kind: String,
    pub sequence: u32,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

async fn send_json(socket: &mut WebSocket, value: &impl Serialize) -> Result<()> {
    tokio::time::timeout(
        IO_TIMEOUT,
        socket.send(Message::Text(serde_json::to_string(value)?.into())),
    )
    .await
    .context("websocket send timed out")??;
    Ok(())
}

async fn first_hello(socket: &mut WebSocket) -> Result<Hello> {
    let message = tokio::time::timeout(Duration::from_secs(3), socket.recv())
        .await
        .context("authentication timed out")?
        .context("connection closed before authentication")??;
    let Message::Text(text) = message else {
        bail!("expected authentication message");
    };
    ensure!(text.len() <= 256, "authentication message too large");
    serde_json::from_str(&text).context("invalid authentication message")
}

async fn control(mut socket: WebSocket, state: Arc<App>) -> Result<()> {
    let mut stopping = state.stopping.subscribe();
    let hello = first_hello(&mut socket).await?;
    let valid = state
        .pairing
        .lock()
        .await
        .credential
        .as_ref()
        .is_some_and(|credential| same_secret(credential, &hello.token));
    if !valid {
        send_json(
            &mut socket,
            &serde_json::json!({"kind":"error", "error":"unauthorized"}),
        )
        .await?;
        bail!("invalid controller credential");
    }
    let id = secret()?;
    {
        let mut owner = state.owner.lock().await;
        if owner.is_some() {
            send_json(
                &mut socket,
                &serde_json::json!({"kind":"error", "error":"another controller is active"}),
            )
            .await?;
            bail!("controller busy");
        }
        if let Err(error) = state.execute(Command::Release).await {
            send_json(
                &mut socket,
                &serde_json::json!({"kind":"error", "error":error.to_string()}),
            )
            .await?;
            return Err(error);
        }
        *owner = Some(Owner {
            id: id.clone(),
            last_seen: Instant::now(),
            sequence: 0,
        });
    }
    let result = async {
        let (platform, dry_run) = if state.local.is_some() {
            (std::env::consts::OS.to_owned(), state.dry_run)
        } else {
            let remote = state.remote.lock().await;
            let remote = remote.as_ref().context("daemon disconnected")?;
            (remote.platform.clone(), remote.dry_run)
        };
        send_json(
            &mut socket,
            &serde_json::json!({
                "kind":"ready", "session":id, "protocol":1,
                "platform":platform, "dry_run":dry_run,
                "transport":if state.local.is_some() {"direct"} else {"relay"},
                "lease_ms":LEASE.as_millis()
            }),
        )
        .await?;
        loop {
            let message = tokio::select! {
                _ = stopping.changed() => break,
                message = tokio::time::timeout(LEASE, socket.recv()) => {
                    message.context("controller idle timeout")?
                }
            };
            let Some(message) = message else { break };
            let bytes = match message? {
                Message::Binary(bytes) => bytes,
                Message::Close(_) => break,
                Message::Ping(_) | Message::Pong(_) => continue,
                Message::Text(_) => bail!("expected binary control frame"),
            };
            let frame = Frame::decode(&bytes)?;
            let mut owner = state.owner.lock().await;
            let current = owner.as_mut().context("control lease expired")?;
            ensure!(current.id == id, "control ownership changed");
            ensure!(current.last_seen.elapsed() < LEASE, "control lease expired");
            ensure!(
                current.sequence.checked_add(1) == Some(frame.sequence),
                "non-contiguous sequence; reconnect without replay"
            );
            current.sequence = frame.sequence;
            current.last_seen = Instant::now();
            let applied = state.execute(frame.command).await;
            let error = applied.as_ref().err().map(ToString::to_string);
            drop(owner);
            send_json(
                &mut socket,
                &Ack {
                    kind: "ack".into(),
                    sequence: frame.sequence,
                    ok: applied.is_ok(),
                    error,
                },
            )
            .await?;
            applied?;
        }
        Ok(())
    }
    .await;
    {
        let mut owner = state.owner.lock().await;
        if owner.as_ref().is_some_and(|owner| owner.id == id) {
            *owner = None;
            state.release().await;
        }
    }
    let _ = tokio::time::timeout(IO_TIMEOUT, socket.close()).await;
    result
}

async fn daemon_upgrade(State(state): State<Arc<App>>, ws: WebSocketUpgrade) -> Response {
    if state.local.is_some() {
        return StatusCode::NOT_FOUND.into_response();
    }
    socket_limits(ws)
        .on_upgrade(move |socket| async move {
            if let Err(error) = remote_socket(socket, state).await {
                tracing::warn!(%error, "daemon connection ended");
            }
        })
        .into_response()
}

async fn remote_socket(mut socket: WebSocket, state: Arc<App>) -> Result<()> {
    let mut stopping = state.stopping.subscribe();
    let hello = first_hello(&mut socket).await?;
    ensure!(
        same_secret(&state.daemon_token, &hello.token),
        "invalid daemon credential"
    );
    let id = secret()?;
    let platform = hello.platform.context("daemon platform is required")?;
    ensure!(
        matches!(platform.as_str(), "macos" | "windows" | "linux"),
        "unsupported daemon platform"
    );
    let dry_run = hello.dry_run.context("daemon dry_run flag is required")?;
    let (sender, mut receiver) = mpsc::channel::<RemoteRequest>(32);
    {
        let mut remote = state.remote.lock().await;
        ensure!(remote.is_none(), "a daemon is already connected");
        send_json(&mut socket, &serde_json::json!({"kind":"ready"})).await?;
        *remote = Some(RemoteLink {
            id: id.clone(),
            sender,
            platform,
            dry_run,
        });
    }
    tracing::info!("daemon connected");
    let result = async {
        let mut sequence = 0_u32;
        let mut interval = tokio::time::interval(Duration::from_millis(350));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            let request = tokio::select! {
                _ = stopping.changed() => break,
                request = receiver.recv() => request,
                _ = interval.tick() => {
                    // This is a transport ping, not a control lease renewal.
                    tokio::time::timeout(IO_TIMEOUT, socket.send(Message::Ping(vec![].into()))).await??;
                    continue;
                }
                incoming = socket.recv() => {
                    match incoming {
                        Some(Ok(Message::Pong(_) | Message::Ping(_))) => continue,
                        Some(Ok(Message::Close(_))) | None => bail!("daemon disconnected"),
                        Some(Err(error)) => return Err(error.into()),
                        _ => bail!("unexpected unsolicited daemon message"),
                    }
                }
            };
            let Some(request) = request else { break };
            if request.reply.is_closed() {
                continue;
            }
            sequence = sequence.checked_add(1).context("daemon sequence exhausted")?;
            let frame = Frame { sequence, command: request.command };
            let exchange = async {
                socket.send(Message::Binary(frame.encode().into())).await?;
                loop {
                    match socket.recv().await.context("daemon disconnected")?? {
                        Message::Text(text) => {
                            let ack: Ack = serde_json::from_str(&text)?;
                            ensure!(ack.kind == "ack" && ack.sequence == sequence, "invalid daemon ACK");
                            if !ack.ok {
                                bail!("{}", ack.error.as_deref().unwrap_or("daemon input failed"));
                            }
                            break;
                        }
                        Message::Ping(_) | Message::Pong(_) => continue,
                        _ => bail!("unexpected daemon reply"),
                    }
                }
                Ok::<_, anyhow::Error>(())
            };
            let applied = match tokio::time::timeout(IO_TIMEOUT, exchange).await {
                Ok(result) => result,
                Err(_) => Err(anyhow!("daemon ACK timed out; result is uncertain")),
            };
            let failed = applied.is_err();
            let _ = request.reply.send(applied);
            if failed {
                bail!("daemon command failed; closing transport");
            }
        }
        Ok(())
    }.await;
    let mut remote = state.remote.lock().await;
    if remote.as_ref().is_some_and(|remote| remote.id == id) {
        *remote = None;
    }
    drop(remote);
    let _ = tokio::time::timeout(IO_TIMEOUT, socket.close()).await;
    result
}
