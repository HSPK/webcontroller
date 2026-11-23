use std::{
    collections::BTreeSet,
    sync::mpsc::{self, SyncSender},
    time::{Duration, Instant},
};

use anyhow::{Context, Result, anyhow, bail, ensure};
use tokio::sync::oneshot;

use crate::{platform, protocol::Command};

pub const LEASE: Duration = Duration::from_millis(1200);
const REPEAT_DELAY: Duration = Duration::from_millis(450);
const REPEAT_INTERVAL: Duration = Duration::from_millis(45);

pub trait Adapter {
    fn key(&mut self, key: u16, down: bool, modifiers: u8) -> Result<()>;
    fn text(&mut self, text: &str) -> Result<()>;
    fn pointer(&mut self, action: Pointer, modifiers: u8) -> Result<()>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Pointer {
    Move { x: i16, y: i16, buttons: u8 },
    Button { button: u8, down: bool, count: u8 },
    Scroll { x: i16, y: i16 },
}

struct Request {
    command: Command,
    reply: oneshot::Sender<Result<()>>,
}

#[derive(Clone)]
pub struct InputHandle {
    sender: SyncSender<Request>,
}

impl InputHandle {
    pub fn start(dry_run: bool) -> Result<Self> {
        let (sender, receiver) = mpsc::sync_channel::<Request>(64);
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        std::thread::Builder::new()
            .name("input-executor".into())
            .spawn(move || {
                let adapter = match platform::create(dry_run) {
                    Ok(adapter) => adapter,
                    Err(error) => {
                        let _ = ready_tx.send(Err(error));
                        return;
                    }
                };
                let mut engine = Engine::new(adapter);
                if ready_tx.send(Ok(())).is_err() {
                    return;
                }
                let mut retry = false;
                loop {
                    let request = if retry {
                        receiver.recv_timeout(Duration::from_millis(8))
                    } else if let Some(deadline) = engine.next_wake() {
                        receiver.recv_timeout(deadline.saturating_duration_since(Instant::now()))
                    } else {
                        receiver
                            .recv()
                            .map_err(|_| mpsc::RecvTimeoutError::Disconnected)
                    };
                    let tick = engine.tick(Instant::now());
                    retry = tick.is_err();
                    if let Err(error) = &tick {
                        tracing::error!(%error, "input watchdog failed");
                    }
                    match request {
                        Ok(request) => {
                            if request.reply.is_closed()
                                && !matches!(request.command, Command::Release)
                            {
                                continue;
                            }
                            let result =
                                tick.and_then(|_| engine.apply(request.command, Instant::now()));
                            if let Err(error) = &result {
                                tracing::warn!(%error, "input command failed");
                            }
                            let _ = request.reply.send(result);
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Err(mpsc::RecvTimeoutError::Disconnected) => {
                            if let Err(error) = engine.release() {
                                tracing::error!(%error, "input shutdown cleanup failed");
                            }
                            break;
                        }
                    }
                }
            })?;
        ready_rx
            .recv()
            .context("input executor failed to start")??;
        Ok(Self { sender })
    }

    pub async fn execute(&self, command: Command) -> Result<()> {
        let (reply, result) = oneshot::channel();
        self.sender
            .try_send(Request { command, reply })
            .map_err(|error| anyhow!("input executor unavailable: {error}"))?;
        tokio::time::timeout(Duration::from_millis(700), result)
            .await
            .context("input executor timed out; result is uncertain")?
            .context("input executor stopped")?
    }
}

struct Engine<A> {
    adapter: A,
    held: BTreeSet<u16>,
    deadline: Option<Instant>,
    repeat: Option<(u16, Instant)>,
    expired: bool,
    buttons: u8,
    last_click: Option<(u8, Instant)>,
}

impl<A: Adapter> Engine<A> {
    fn new(adapter: A) -> Self {
        Self {
            adapter,
            held: BTreeSet::new(),
            deadline: None,
            repeat: None,
            expired: false,
            buttons: 0,
            last_click: None,
        }
    }

    fn modifiers(keys: &BTreeSet<u16>) -> u8 {
        keys.iter()
            .filter(|key| (0xe0..=0xe7).contains(*key))
            .fold(0, |mask, key| mask | (1 << (key - 0xe0)))
    }

    fn next_wake(&self) -> Option<Instant> {
        self.deadline
            .into_iter()
            .chain(self.repeat.map(|(_, due)| due))
            .min()
    }

    fn key(&mut self, key: u16, down: bool, now: Instant) -> Result<()> {
        if self.held.contains(&key) == down {
            return Ok(());
        }
        let mut next = self.held.clone();
        if down {
            next.insert(key);
        } else {
            next.remove(&key);
        }
        self.adapter.key(key, down, Self::modifiers(&next))?;
        self.held = next;
        if down && key < 0xe0 && !matches!(key, 0x39 | 0x53 | 0x65) {
            self.repeat = Some((key, now + REPEAT_DELAY));
        } else if self.repeat.is_some_and(|(repeating, _)| repeating == key) {
            self.repeat = None;
        }
        Ok(())
    }

    fn apply(&mut self, command: Command, now: Instant) -> Result<()> {
        ensure!(
            !self.expired || matches!(command, Command::Release),
            "input lease expired; reconnect without replay"
        );
        match command {
            Command::Down(key) => self.key(key, true, now)?,
            Command::Up(key) => self.key(key, false, now)?,
            Command::Text(text) => {
                ensure!(
                    Self::modifiers(&self.held) == 0 && self.buttons == 0,
                    "release modifier keys and mouse buttons before submitting text"
                );
                self.adapter.text(&text)?;
            }
            Command::Release => {
                self.release()?;
                self.expired = false;
            }
            Command::Heartbeat => {}
            Command::Chord(keys) => {
                ensure!(
                    self.held.is_empty() && self.buttons == 0,
                    "release held keys and mouse buttons before a shortcut"
                );
                for key in keys {
                    if let Err(error) = self.key(key, true, now) {
                        return match self.release() {
                            Ok(()) => Err(error),
                            Err(cleanup) => Err(anyhow!("{error}; cleanup failed: {cleanup}")),
                        };
                    }
                }
                self.release()?;
            }
            Command::Move(x, y) => {
                self.last_click = None;
                self.adapter.pointer(
                    Pointer::Move {
                        x,
                        y,
                        buttons: self.buttons,
                    },
                    Self::modifiers(&self.held),
                )?;
            }
            Command::Scroll(x, y) => {
                self.last_click = None;
                self.adapter
                    .pointer(Pointer::Scroll { x, y }, Self::modifiers(&self.held))?;
            }
            Command::MouseDown(button) => {
                self.last_click = None;
                self.mouse_button(button, true, 1)?;
            }
            Command::MouseUp(button) => self.mouse_button(button, false, 1)?,
            Command::Click(button, count) => {
                ensure!(self.buttons == 0, "release mouse buttons before clicking");
                let double = count == 1
                    && self.last_click.is_some_and(|(previous, time)| {
                        previous == button
                            && now.saturating_duration_since(time) <= Duration::from_millis(350)
                    });
                for click in 1..=count {
                    let native_count = if double { 2 } else { click };
                    self.mouse_button(button, true, native_count)?;
                    self.mouse_button(button, false, native_count)?;
                }
                self.last_click = if count == 1 && !double {
                    Some((button, now))
                } else {
                    None
                };
            }
        }
        self.deadline = Some(now + LEASE);
        Ok(())
    }

    fn release(&mut self) -> Result<()> {
        self.repeat = None;
        self.last_click = None;
        let mut errors = Vec::new();
        for button in 1..=3 {
            if let Err(error) = self.mouse_button(button, false, 1) {
                errors.push(error.to_string());
            }
        }
        // Release ordinary keys before modifiers so shortcuts end predictably.
        let keys: Vec<_> = self.held.iter().copied().collect();
        for key in keys {
            if let Err(error) = self.key(key, false, Instant::now()) {
                errors.push(error.to_string());
            }
        }
        if !errors.is_empty() {
            bail!("failed to release keys: {}", errors.join("; "));
        }
        Ok(())
    }

    fn mouse_button(&mut self, button: u8, down: bool, count: u8) -> Result<()> {
        let bit = 1 << (button - 1);
        if (self.buttons & bit != 0) == down {
            return Ok(());
        }
        self.adapter.pointer(
            Pointer::Button {
                button,
                down,
                count,
            },
            Self::modifiers(&self.held),
        )?;
        if down {
            self.buttons |= bit;
        } else {
            self.buttons &= !bit;
        }
        Ok(())
    }

    fn expire(&mut self, now: Instant) -> Result<()> {
        if self.deadline.is_some_and(|deadline| now >= deadline) {
            self.release()?;
            self.deadline = None;
            self.expired = true;
        }
        Ok(())
    }

    fn tick(&mut self, now: Instant) -> Result<()> {
        self.expire(now)?;
        if let Some((key, due)) = self.repeat
            && now >= due
        {
            self.adapter.key(key, true, Self::modifiers(&self.held))?;
            self.repeat = Some((key, now + REPEAT_INTERVAL));
        }
        Ok(())
    }
}

impl Adapter for Box<dyn Adapter> {
    fn key(&mut self, key: u16, down: bool, modifiers: u8) -> Result<()> {
        (**self).key(key, down, modifiers)
    }
    fn text(&mut self, text: &str) -> Result<()> {
        (**self).text(text)
    }
    fn pointer(&mut self, action: Pointer, modifiers: u8) -> Result<()> {
        (**self).pointer(action, modifiers)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Recording {
        events: Vec<(u16, bool, u8)>,
        text: String,
        pointer: Vec<(Pointer, u8)>,
    }
    impl Adapter for Recording {
        fn key(&mut self, key: u16, down: bool, modifiers: u8) -> Result<()> {
            self.events.push((key, down, modifiers));
            Ok(())
        }
        fn text(&mut self, text: &str) -> Result<()> {
            self.text.push_str(text);
            Ok(())
        }
        fn pointer(&mut self, action: Pointer, modifiers: u8) -> Result<()> {
            self.pointer.push((action, modifiers));
            Ok(())
        }
    }

    #[test]
    fn watchdog_releases_keys_and_stops_repeating() {
        let now = Instant::now();
        let mut engine = Engine::new(Recording::default());
        engine.apply(Command::Down(0xe0), now).unwrap();
        engine.apply(Command::Down(0x04), now).unwrap();
        engine.tick(now + REPEAT_DELAY).unwrap();
        assert_eq!(engine.adapter.events.last(), Some(&(0x04, true, 1)));
        engine.tick(now + LEASE).unwrap();
        assert!(engine.held.is_empty());
        assert!(engine.repeat.is_none());
        assert_eq!(
            &engine.adapter.events[3..],
            &[(0x04, false, 1), (0xe0, false, 0)]
        );
    }

    #[test]
    fn executor_sleeps_until_repeat_or_lease_deadlines_and_blocks_when_idle() {
        let now = Instant::now();
        let mut engine = Engine::new(Recording::default());
        assert_eq!(engine.next_wake(), None);
        engine.apply(Command::Down(0x04), now).unwrap();
        assert_eq!(engine.next_wake(), Some(now + REPEAT_DELAY));
        engine.tick(now + REPEAT_DELAY).unwrap();
        assert_eq!(
            engine.next_wake(),
            Some(now + REPEAT_DELAY + REPEAT_INTERVAL)
        );
        engine.apply(Command::Up(0x04), now + REPEAT_DELAY).unwrap();
        assert_eq!(engine.next_wake(), Some(now + REPEAT_DELAY + LEASE));
        engine.tick(now + REPEAT_DELAY + LEASE).unwrap();
        assert_eq!(engine.next_wake(), None);
        assert!(engine.expired);
    }

    #[test]
    fn duplicate_down_is_idempotent_and_text_requires_released_modifiers() {
        let now = Instant::now();
        let mut engine = Engine::new(Recording::default());
        engine.apply(Command::Down(0xe0), now).unwrap();
        engine.apply(Command::Down(0xe0), now).unwrap();
        assert_eq!(engine.adapter.events.len(), 1);
        assert!(engine.apply(Command::Text("你好".into()), now).is_err());
        engine.apply(Command::Release, now).unwrap();
        engine.apply(Command::Text("你好 👋".into()), now).unwrap();
        assert_eq!(engine.adapter.text, "你好 👋");
    }

    #[test]
    fn heartbeat_extends_lease_and_chord_preserves_order() {
        let now = Instant::now();
        let mut engine = Engine::new(Recording::default());
        engine.apply(Command::Chord(vec![0xe3, 0x06]), now).unwrap();
        assert_eq!(
            engine.adapter.events,
            vec![
                (0xe3, true, 8),
                (0x06, true, 8),
                (0x06, false, 8),
                (0xe3, false, 0)
            ]
        );
        engine.apply(Command::Down(0x04), now).unwrap();
        engine
            .apply(Command::Heartbeat, now + Duration::from_millis(900))
            .unwrap();
        engine.tick(now + LEASE).unwrap();
        assert!(engine.held.contains(&0x04));
    }

    #[test]
    fn late_input_cannot_revive_an_expired_lease() {
        let now = Instant::now();
        let mut engine = Engine::new(Recording::default());
        engine.apply(Command::Down(0x04), now).unwrap();
        engine.tick(now + LEASE).unwrap();
        assert!(engine.apply(Command::Heartbeat, now + LEASE).is_err());
        assert!(engine.apply(Command::Down(0x04), now + LEASE).is_err());
        assert!(
            engine
                .apply(Command::Text("late".into()), now + LEASE)
                .is_err()
        );
        engine.apply(Command::Release, now + LEASE).unwrap();
        engine.apply(Command::Down(0x04), now + LEASE).unwrap();
        assert!(engine.held.contains(&0x04));
    }

    #[test]
    fn dragging_is_leased_and_releases_buttons_before_modifiers() {
        let now = Instant::now();
        let mut engine = Engine::new(Recording::default());
        engine.apply(Command::Down(0xe1), now).unwrap();
        engine.apply(Command::MouseDown(1), now).unwrap();
        engine.apply(Command::MouseDown(1), now).unwrap();
        engine.apply(Command::Move(20, -8), now).unwrap();
        assert_eq!(engine.adapter.pointer.len(), 2);
        assert_eq!(
            engine.adapter.pointer[1],
            (
                Pointer::Move {
                    x: 20,
                    y: -8,
                    buttons: 1
                },
                2
            )
        );
        engine.tick(now + LEASE).unwrap();
        assert_eq!(engine.buttons, 0);
        assert_eq!(
            engine.adapter.pointer.last(),
            Some(&(
                Pointer::Button {
                    button: 1,
                    down: false,
                    count: 1
                },
                2
            ))
        );
        assert!(engine.apply(Command::MouseDown(1), now + LEASE).is_err());
        assert!(engine.apply(Command::Move(1, 0), now + LEASE).is_err());
    }

    #[test]
    fn double_click_preserves_native_click_counts() {
        let mut engine = Engine::new(Recording::default());
        engine.apply(Command::Click(1, 2), Instant::now()).unwrap();
        assert_eq!(
            engine
                .adapter
                .pointer
                .iter()
                .map(|(event, _)| event)
                .collect::<Vec<_>>(),
            vec![
                &Pointer::Button {
                    button: 1,
                    down: true,
                    count: 1
                },
                &Pointer::Button {
                    button: 1,
                    down: false,
                    count: 1
                },
                &Pointer::Button {
                    button: 1,
                    down: true,
                    count: 2
                },
                &Pointer::Button {
                    button: 1,
                    down: false,
                    count: 2
                },
            ]
        );
        assert_eq!(engine.buttons, 0);
    }
}
