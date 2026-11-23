use std::time::Duration;

use anyhow::{Context, Result, bail, ensure};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::{Message, protocol::WebSocketConfig};
use url::Url;

use crate::{
    input::InputHandle,
    protocol::{Command, Frame, MAX_FRAME_BYTES},
    server::Ack,
};

pub async fn run(server: Url, token: String, input: InputHandle, dry_run: bool) -> Result<()> {
    ensure!(
        matches!(server.scheme(), "http" | "https" | "ws" | "wss"),
        "server URL must use HTTP(S) or WS(S)"
    );
    ensure!(
        server.username().is_empty()
            && server.password().is_none()
            && server.query().is_none()
            && server.fragment().is_none()
            && server.path() == "/",
        "server URL must contain only an origin"
    );
    let mut endpoint = server.clone();
    endpoint
        .set_scheme(match server.scheme() {
            "https" | "wss" => "wss",
            _ => "ws",
        })
        .map_err(|_| anyhow::anyhow!("invalid server URL"))?;
    endpoint.set_path("/ws/daemon");
    if endpoint.scheme() == "ws" {
        tracing::warn!("daemon transport is unencrypted; use only on a trusted LAN");
    }
    let mut delay = Duration::from_millis(500);
    loop {
        tracing::info!(server = %server, "connecting daemon");
        let connection = connect(&endpoint, &token, &input, dry_run);
        tokio::select! {
            result = connection => {
                if let Err(error) = result {
                    tracing::warn!(%error, "daemon disconnected; no input will be replayed");
                }
            }
            result = crate::shutdown_signal() => {
                result.context("shutdown signal handler failed")?;
                input.execute(Command::Release).await?;
                return Ok(());
            }
        }
        if let Err(error) = input.execute(Command::Release).await {
            tracing::error!(%error, "daemon disconnect cleanup failed");
        }
        tokio::select! {
            _ = tokio::time::sleep(delay) => {},
            result = crate::shutdown_signal() => {
                result.context("shutdown signal handler failed")?;
                return Ok(());
            }
        }
        delay = (delay * 2).min(Duration::from_secs(5));
    }
}

async fn connect(endpoint: &Url, token: &str, input: &InputHandle, dry_run: bool) -> Result<()> {
    let config = WebSocketConfig::default()
        .write_buffer_size(0)
        .max_message_size(Some(MAX_FRAME_BYTES))
        .max_frame_size(Some(MAX_FRAME_BYTES));
    let (mut socket, _) = tokio::time::timeout(
        Duration::from_secs(10),
        tokio_tungstenite::connect_async_with_config(endpoint.as_str(), Some(config), true),
    )
    .await
    .context("daemon connection timed out")??;
    socket
        .send(Message::Text(
            serde_json::json!({
                "token":token, "platform":std::env::consts::OS, "dry_run":dry_run
            })
            .to_string()
            .into(),
        ))
        .await?;
    let response = tokio::time::timeout(Duration::from_secs(3), socket.next())
        .await
        .context("daemon authentication timed out")?
        .context("server closed during authentication")??;
    let Message::Text(response) = response else {
        bail!("server rejected daemon authentication");
    };
    let ready: serde_json::Value = serde_json::from_str(&response)?;
    ensure!(
        ready["kind"] == "ready",
        "server rejected daemon authentication"
    );
    tracing::info!("daemon authenticated");
    input.execute(Command::Release).await?;
    let mut last_sequence = 0_u32;
    loop {
        let message = tokio::time::timeout(Duration::from_secs(3), socket.next())
            .await
            .context("server transport timeout")?
            .context("server disconnected")??;
        let bytes = match message {
            Message::Binary(bytes) => bytes,
            Message::Ping(bytes) => {
                socket.send(Message::Pong(bytes)).await?;
                continue;
            }
            Message::Pong(_) => continue,
            Message::Close(_) => break,
            _ => bail!("unexpected server message"),
        };
        let frame = Frame::decode(&bytes)?;
        ensure!(
            last_sequence.checked_add(1) == Some(frame.sequence),
            "invalid server sequence"
        );
        last_sequence = frame.sequence;
        let result = input.execute(frame.command).await;
        let ack = Ack {
            kind: "ack".into(),
            sequence: frame.sequence,
            ok: result.is_ok(),
            error: result.as_ref().err().map(ToString::to_string),
        };
        tokio::time::timeout(
            Duration::from_millis(900),
            socket.send(Message::Text(serde_json::to_string(&ack)?.into())),
        )
        .await
        .context("daemon ACK send timed out")??;
        result?;
    }
    Ok(())
}
