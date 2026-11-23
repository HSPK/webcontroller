mod daemon;
mod input;
mod platform;
mod protocol;
mod server;

use std::net::{IpAddr, SocketAddr};

use anyhow::{Context, Result, ensure};
use clap::{Parser, Subcommand};
use url::Url;

#[derive(Parser)]
#[command(version, about = "LAN-first mobile web keyboard controller")]
struct Cli {
    #[command(subcommand)]
    command: Option<Mode>,

    #[command(flatten)]
    listen: Listen,
}

#[derive(clap::Args)]
struct Listen {
    #[arg(
        long,
        default_value = "0.0.0.0",
        help = "Listener interface; use 127.0.0.1 for loopback only"
    )]
    host: IpAddr,
    #[arg(long, default_value_t = 8787)]
    port: u16,
    #[arg(
        long,
        help = "External HTTP(S) origin when behind a trusted reverse proxy"
    )]
    public_url: Option<Url>,
    #[arg(long, help = "Disable system injection and allow UI/network testing")]
    dry_run: bool,
    #[arg(long, help = "Do not print a terminal QR code")]
    no_qr: bool,
}

#[derive(Subcommand)]
enum Mode {
    /// Run a relay server without accessing the server machine's keyboard.
    Server {
        #[command(flatten)]
        listen: Listen,
        #[arg(long, env = "WEBCONTROLLER_DAEMON_TOKEN", hide_env_values = true)]
        daemon_token: String,
    },
    /// Connect this computer's user-session input agent to a relay server.
    Daemon {
        #[arg(long)]
        server: Url,
        #[arg(long, env = "WEBCONTROLLER_DAEMON_TOKEN", hide_env_values = true)]
        token: String,
        #[arg(long)]
        dry_run: bool,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_ansi(false)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "webcontroller=info".into()),
        )
        .with_writer(std::io::stderr)
        .init();
    let cli = Cli::parse();
    match cli.command {
        None => {
            let input = input::InputHandle::start(cli.listen.dry_run)?;
            server::serve(settings(cli.listen, Some(input), String::new())).await
        }
        Some(Mode::Server {
            listen,
            daemon_token,
        }) => {
            ensure!(
                !listen.dry_run,
                "relay mode cannot disable the computer's native input; run the computer daemon with --dry-run instead"
            );
            ensure!(
                daemon_token.len() >= 32,
                "daemon token must be at least 32 characters"
            );
            server::serve(settings(listen, None, daemon_token)).await
        }
        Some(Mode::Daemon {
            server,
            token,
            dry_run,
        }) => {
            ensure!(
                token.len() >= 32,
                "daemon token must be at least 32 characters"
            );
            let input =
                input::InputHandle::start(dry_run).context("cannot initialize input agent")?;
            daemon::run(server, token, input, dry_run).await
        }
    }
}

fn settings(
    listen: Listen,
    backend: Option<input::InputHandle>,
    daemon_token: String,
) -> server::Settings {
    server::Settings {
        address: SocketAddr::new(listen.host, listen.port),
        public_url: listen.public_url,
        no_qr: listen.no_qr,
        backend,
        daemon_token,
        dry_run: listen.dry_run,
    }
}

pub async fn shutdown_signal() -> std::io::Result<()> {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => result,
            _ = terminate.recv() => Ok(()),
        }
    }
    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c().await
    }
}
