use anyhow::{Result, bail, ensure};

pub const VERSION: u8 = 1;
pub const MAX_TEXT_BYTES: usize = 16 * 1024;
pub const MAX_FRAME_BYTES: usize = MAX_TEXT_BYTES + 6;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    Down(u16),
    Up(u16),
    Text(String),
    Release,
    Heartbeat,
    Chord(Vec<u16>),
    Move(i16, i16),
    MouseDown(u8),
    MouseUp(u8),
    Scroll(i16, i16),
    Click(u8, u8),
}

#[derive(Debug, PartialEq, Eq)]
pub struct Frame {
    pub sequence: u32,
    pub command: Command,
}

impl Frame {
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        ensure!(
            (6..=MAX_FRAME_BYTES).contains(&bytes.len()),
            "invalid frame length"
        );
        ensure!(bytes[0] == VERSION, "unsupported protocol version");
        let sequence = u32::from_le_bytes(bytes[2..6].try_into()?);
        let payload = &bytes[6..];
        let command = match bytes[1] {
            1 | 2 => {
                ensure!(payload.len() == 2, "invalid key payload");
                let key = u16::from_le_bytes(payload.try_into()?);
                ensure!(supported_key(key), "unsupported key: {key}");
                if bytes[1] == 1 {
                    Command::Down(key)
                } else {
                    Command::Up(key)
                }
            }
            3 => {
                ensure!(!payload.is_empty(), "text cannot be empty");
                let text = std::str::from_utf8(payload)?;
                ensure!(!text.contains('\0'), "text cannot contain NUL");
                Command::Text(text.to_owned())
            }
            4 | 5 => {
                ensure!(payload.is_empty(), "unexpected payload");
                if bytes[1] == 4 {
                    Command::Release
                } else {
                    Command::Heartbeat
                }
            }
            6 => {
                ensure!(
                    !payload.is_empty() && payload.len().is_multiple_of(2) && payload.len() <= 16,
                    "invalid chord length"
                );
                let keys: Vec<u16> = payload
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                    .collect();
                for (index, key) in keys.iter().enumerate() {
                    ensure!(supported_key(*key), "unsupported chord key: {key}");
                    ensure!(!keys[..index].contains(key), "duplicate chord key");
                }
                Command::Chord(keys)
            }
            7 | 10 => {
                ensure!(payload.len() == 4, "invalid pointer delta");
                let x = i16::from_le_bytes(payload[..2].try_into()?);
                let y = i16::from_le_bytes(payload[2..].try_into()?);
                ensure!(
                    (-4096..=4096).contains(&x) && (-4096..=4096).contains(&y),
                    "pointer delta exceeds limit"
                );
                if bytes[1] == 7 {
                    Command::Move(x, y)
                } else {
                    Command::Scroll(x, y)
                }
            }
            8 | 9 => {
                ensure!(
                    payload.len() == 1 && (1..=3).contains(&payload[0]),
                    "invalid mouse button"
                );
                if bytes[1] == 8 {
                    Command::MouseDown(payload[0])
                } else {
                    Command::MouseUp(payload[0])
                }
            }
            11 => {
                ensure!(
                    payload.len() == 2
                        && (1..=3).contains(&payload[0])
                        && (1..=2).contains(&payload[1]),
                    "invalid mouse click"
                );
                Command::Click(payload[0], payload[1])
            }
            _ => bail!("unknown opcode"),
        };
        Ok(Self { sequence, command })
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut bytes = vec![
            VERSION,
            match self.command {
                Command::Down(_) => 1,
                Command::Up(_) => 2,
                Command::Text(_) => 3,
                Command::Release => 4,
                Command::Heartbeat => 5,
                Command::Chord(_) => 6,
                Command::Move(_, _) => 7,
                Command::MouseDown(_) => 8,
                Command::MouseUp(_) => 9,
                Command::Scroll(_, _) => 10,
                Command::Click(_, _) => 11,
            },
        ];
        bytes.extend(self.sequence.to_le_bytes());
        match &self.command {
            Command::Down(key) | Command::Up(key) => bytes.extend(key.to_le_bytes()),
            Command::Text(text) => bytes.extend(text.as_bytes()),
            Command::Chord(keys) => {
                for key in keys {
                    bytes.extend(key.to_le_bytes());
                }
            }
            Command::Move(x, y) | Command::Scroll(x, y) => {
                bytes.extend(x.to_le_bytes());
                bytes.extend(y.to_le_bytes());
            }
            Command::MouseDown(button) | Command::MouseUp(button) => bytes.push(*button),
            Command::Click(button, count) => bytes.extend([button, count]),
            Command::Release | Command::Heartbeat => {}
        }
        bytes
    }
}

pub fn supported_key(key: u16) -> bool {
    matches!(key, 0x04..=0x45 | 0x49..=0x63 | 0x65 | 0xe0..=0xe7)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_round_trip() {
        for command in [
            Command::Down(0xe0),
            Command::Up(0xe0),
            Command::Text("你好 👋".into()),
            Command::Release,
            Command::Heartbeat,
            Command::Chord(vec![0xe3, 0x06]),
            Command::Move(-41, 12),
            Command::MouseDown(1),
            Command::MouseUp(1),
            Command::Scroll(4, -120),
            Command::Click(1, 2),
        ] {
            let frame = Frame {
                sequence: u32::MAX,
                command,
            };
            assert_eq!(Frame::decode(&frame.encode()).unwrap(), frame);
        }
    }

    #[test]
    fn malformed_frames_are_rejected() {
        let mut invalid_utf8 = vec![1, 3, 0, 0, 0, 0];
        invalid_utf8.push(0xff);
        for bytes in [
            vec![],
            vec![1, 1, 0, 0, 0, 0],
            vec![1, 1, 0, 0, 0, 0, 0xff, 0xff],
            vec![1, 4, 0, 0, 0, 0, 1],
            vec![1, 3, 0, 0, 0, 0],
            vec![1, 6, 0, 0, 0, 0, 4, 0, 4, 0],
            vec![1, 7, 0, 0, 0, 0, 0xff, 0x7f, 0, 0],
            vec![1, 8, 0, 0, 0, 0, 4],
            vec![1, 11, 0, 0, 0, 0, 1, 3],
            invalid_utf8,
            vec![1; MAX_FRAME_BYTES + 1],
        ] {
            assert!(Frame::decode(&bytes).is_err());
        }
    }
}
