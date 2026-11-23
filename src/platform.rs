use anyhow::Result;

use crate::input::{Adapter, Pointer};

pub fn create(dry_run: bool) -> Result<Box<dyn Adapter>> {
    if dry_run {
        tracing::warn!("DRY RUN: system input injection is disabled");
        return Ok(Box::new(DryRun));
    }
    native::create()
}

struct DryRun;

impl Adapter for DryRun {
    fn key(&mut self, key: u16, down: bool, modifiers: u8) -> Result<()> {
        tracing::debug!(key, down, modifiers, "dry-run key");
        Ok(())
    }
    fn text(&mut self, text: &str) -> Result<()> {
        tracing::debug!(bytes = text.len(), "dry-run text (content omitted)");
        Ok(())
    }
    fn pointer(&mut self, action: Pointer, modifiers: u8) -> Result<()> {
        tracing::debug!(?action, modifiers, "dry-run pointer");
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod native {
    use std::{
        ffi::c_void,
        ptr,
        time::{Duration, Instant},
    };

    use anyhow::{Result, bail, ensure};

    use crate::input::{Adapter, Pointer};

    type Event = *mut c_void;

    #[repr(C)]
    struct Point {
        x: f64,
        y: f64,
    }

    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXIsProcessTrusted() -> bool;
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGEventCreateKeyboardEvent(source: Event, key: u16, down: bool) -> Event;
        fn CGEventCreate(source: Event) -> Event;
        fn CGEventGetLocation(event: Event) -> Point;
        fn CGEventSourceFlagsState(state: i32) -> u64;
        fn CGEventCreateMouseEvent(source: Event, kind: u32, position: Point, button: u32)
        -> Event;
        // wheel1 is a fixed argument; treating it as variadic breaks the Apple Silicon ABI.
        fn CGEventCreateScrollWheelEvent(
            source: Event,
            units: u32,
            wheels: u32,
            wheel1: i32,
            ...
        ) -> Event;
        #[cfg(test)]
        fn CGEventGetIntegerValueField(event: Event, field: u32) -> i64;
        fn CGEventSetIntegerValueField(event: Event, field: u32, value: i64);
        fn CGEventSetFlags(event: Event, flags: u64);
        fn CGEventKeyboardSetUnicodeString(event: Event, length: usize, text: *const u16);
        fn CGEventPost(tap: u32, event: Event);
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(value: *const c_void);
    }

    pub fn create() -> Result<Box<dyn Adapter>> {
        // The user-session process, not a system service, must have TCC permission.
        ensure!(
            unsafe { AXIsProcessTrusted() },
            "macOS Accessibility permission is required. Enable this executable/terminal in System Settings > Privacy & Security > Accessibility, then restart. Use --dry-run to preview without injection."
        );
        Ok(Box::new(Mac {
            caps_lock: unsafe { CGEventSourceFlagsState(1) } & (1 << 16) != 0,
        }))
    }

    struct Mac {
        caps_lock: bool,
    }

    fn location() -> Result<Point> {
        let event = unsafe { CGEventCreate(ptr::null_mut()) };
        ensure!(!event.is_null(), "cannot read current pointer position");
        let point = unsafe { CGEventGetLocation(event) };
        unsafe {
            CFRelease(event);
        }
        Ok(point)
    }

    fn post(event: Event, modifiers: u8, caps_lock: bool) -> Result<()> {
        ensure!(!event.is_null(), "cannot create pointer event");
        unsafe {
            CGEventSetFlags(
                event,
                flags(modifiers) | if caps_lock { 1 << 16 } else { 0 },
            );
            CGEventPost(0, event);
            CFRelease(event);
        }
        Ok(())
    }

    fn flags(modifiers: u8) -> u64 {
        let mut flags = 0;
        for (mask, flag) in [
            (0x11, 1 << 18),
            (0x22, 1 << 17),
            (0x44, 1 << 19),
            (0x88, 1 << 20),
        ] {
            if modifiers & mask != 0 {
                flags |= flag;
            }
        }
        flags
    }

    impl Adapter for Mac {
        fn key(&mut self, key: u16, down: bool, modifiers: u8) -> Result<()> {
            let code = match key {
                0x04..=0x1d => [
                    0, 11, 8, 2, 14, 3, 5, 4, 34, 38, 40, 37, 46, 45, 31, 35, 12, 15, 1, 17, 32, 9,
                    13, 7, 16, 6,
                ][usize::from(key - 0x04)],
                0x1e..=0x27 => [18, 19, 20, 21, 23, 22, 26, 28, 25, 29][usize::from(key - 0x1e)],
                0x28..=0x38 => [
                    36, 53, 51, 48, 49, 27, 24, 33, 30, 42, 42, 41, 39, 50, 43, 47, 44,
                ][usize::from(key - 0x28)],
                0x39 => 57,
                0x3a..=0x45 => [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111]
                    [usize::from(key - 0x3a)],
                0x49..=0x52 => {
                    [114, 115, 116, 117, 119, 121, 124, 123, 125, 126][usize::from(key - 0x49)]
                }
                0x53..=0x63 => [
                    71, 75, 67, 78, 69, 76, 83, 84, 85, 86, 87, 88, 89, 91, 92, 82, 65,
                ][usize::from(key - 0x53)],
                0x65 => 110,
                0xe0..=0xe7 => [59, 56, 58, 55, 62, 60, 61, 54][usize::from(key - 0xe0)],
                _ => bail!("unsupported macOS key: {key}"),
            };
            let event = unsafe { CGEventCreateKeyboardEvent(ptr::null_mut(), code, down) };
            ensure!(!event.is_null(), "CGEventCreateKeyboardEvent failed");
            if key == 0x39 && down {
                self.caps_lock = !self.caps_lock;
            }
            unsafe {
                CGEventSetFlags(
                    event,
                    flags(modifiers) | if self.caps_lock { 1 << 16 } else { 0 },
                );
                CGEventPost(0, event);
                CFRelease(event);
            }
            Ok(())
        }

        fn text(&mut self, text: &str) -> Result<()> {
            let deadline = Instant::now() + Duration::from_millis(400);
            for character in text.chars() {
                ensure!(
                    Instant::now() < deadline,
                    "text execution budget exceeded; text may be partial, do not automatically retry"
                );
                let mut buffer = [0; 2];
                let units = character.encode_utf16(&mut buffer);
                for down in [true, false] {
                    let event = unsafe { CGEventCreateKeyboardEvent(ptr::null_mut(), 0, down) };
                    ensure!(
                        !event.is_null(),
                        "Unicode event creation failed; text may be partial"
                    );
                    unsafe {
                        CGEventSetFlags(event, 0);
                        CGEventKeyboardSetUnicodeString(event, units.len(), units.as_ptr());
                        CGEventPost(0, event);
                        CFRelease(event);
                    }
                }
            }
            Ok(())
        }

        fn pointer(&mut self, action: Pointer, modifiers: u8) -> Result<()> {
            let event = match action {
                Pointer::Move { x, y, buttons } => {
                    let mut point = location()?;
                    point.x += f64::from(x);
                    point.y += f64::from(y);
                    let (kind, button) = if buttons & 1 != 0 {
                        (6, 0)
                    } else if buttons & 2 != 0 {
                        (7, 1)
                    } else if buttons & 4 != 0 {
                        (27, 2)
                    } else {
                        (5, 0)
                    };
                    let event =
                        unsafe { CGEventCreateMouseEvent(ptr::null_mut(), kind, point, button) };
                    ensure!(!event.is_null(), "cannot create pointer movement");
                    unsafe {
                        CGEventSetIntegerValueField(event, 4, i64::from(x));
                        CGEventSetIntegerValueField(event, 5, i64::from(y));
                    }
                    event
                }
                Pointer::Button {
                    button,
                    down,
                    count,
                } => {
                    let kind = match (button, down) {
                        (1, true) => 1,
                        (1, false) => 2,
                        (2, true) => 3,
                        (2, false) => 4,
                        (3, true) => 25,
                        (3, false) => 26,
                        _ => bail!("unsupported mouse button"),
                    };
                    let event = unsafe {
                        CGEventCreateMouseEvent(
                            ptr::null_mut(),
                            kind,
                            location()?,
                            u32::from(button - 1),
                        )
                    };
                    ensure!(!event.is_null(), "cannot create mouse button event");
                    unsafe {
                        CGEventSetIntegerValueField(event, 1, i64::from(count));
                    }
                    event
                }
                Pointer::Scroll { x, y } => unsafe {
                    CGEventCreateScrollWheelEvent(
                        ptr::null_mut(),
                        0,
                        2,
                        -i32::from(y),
                        -i32::from(x),
                    )
                },
            };
            post(event, modifiers, self.caps_lock)
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn scroll_events_preserve_both_pixel_axes() {
            for (x, y) in [(0_i16, 40_i16), (0, -40), (12, -24), (-12, 24)] {
                let event = unsafe {
                    CGEventCreateScrollWheelEvent(
                        ptr::null_mut(),
                        0,
                        2,
                        -i32::from(y),
                        -i32::from(x),
                    )
                };
                assert!(!event.is_null());
                let (vertical, horizontal, continuous) = unsafe {
                    let values = (
                        CGEventGetIntegerValueField(event, 96),
                        CGEventGetIntegerValueField(event, 97),
                        CGEventGetIntegerValueField(event, 88),
                    );
                    CFRelease(event);
                    values
                };
                assert_eq!(vertical, -i64::from(y), "native vertical pixel delta");
                assert_eq!(horizontal, -i64::from(x), "native horizontal pixel delta");
                assert_eq!(continuous, 1, "scrolling must use pixel units");
            }
        }
    }
}

#[cfg(target_os = "windows")]
mod native {
    use anyhow::{Result, bail, ensure};
    use std::time::{Duration, Instant};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY,
        KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, KEYEVENTF_UNICODE, MOUSEEVENTF_HWHEEL,
        MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP,
        MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_WHEEL,
        MOUSEINPUT, SendInput,
    };

    use crate::input::{Adapter, Pointer};

    pub fn create() -> Result<Box<dyn Adapter>> {
        Ok(Box::new(Windows))
    }

    struct Windows;

    fn send(scan: u16, flags: u32) -> Result<()> {
        let input = INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: 0,
                    wScan: scan,
                    dwFlags: flags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        inject(input)
    }

    fn inject(input: INPUT) -> Result<()> {
        ensure!(
            unsafe { SendInput(1, &input, std::mem::size_of::<INPUT>() as i32) } == 1,
            "SendInput failed (possibly UIPI / desktop restrictions): {}",
            std::io::Error::last_os_error()
        );
        Ok(())
    }

    impl Adapter for Windows {
        fn key(&mut self, key: u16, down: bool, _modifiers: u8) -> Result<()> {
            let (scan, extended) = match key {
                0x04..=0x1d => (
                    [
                        0x1e, 0x30, 0x2e, 0x20, 0x12, 0x21, 0x22, 0x23, 0x17, 0x24, 0x25, 0x26,
                        0x32, 0x31, 0x18, 0x19, 0x10, 0x13, 0x1f, 0x14, 0x16, 0x2f, 0x11, 0x2d,
                        0x15, 0x2c,
                    ][usize::from(key - 0x04)],
                    false,
                ),
                0x1e..=0x27 => (key - 0x1e + 2, false),
                0x28..=0x38 => (
                    [
                        0x1c, 0x01, 0x0e, 0x0f, 0x39, 0x0c, 0x0d, 0x1a, 0x1b, 0x2b, 0x2b, 0x27,
                        0x28, 0x29, 0x33, 0x34, 0x35,
                    ][usize::from(key - 0x28)],
                    false,
                ),
                0x39 => (0x3a, false),
                0x3a..=0x43 => (key - 0x3a + 0x3b, false),
                0x44 => (0x57, false),
                0x45 => (0x58, false),
                0x49..=0x52 => (
                    [0x52, 0x47, 0x49, 0x53, 0x4f, 0x51, 0x4d, 0x4b, 0x50, 0x48]
                        [usize::from(key - 0x49)],
                    true,
                ),
                0x53..=0x63 => (
                    [
                        0x45, 0x35, 0x37, 0x4a, 0x4e, 0x1c, 0x4f, 0x50, 0x51, 0x4b, 0x4c, 0x4d,
                        0x47, 0x48, 0x49, 0x52, 0x53,
                    ][usize::from(key - 0x53)],
                    matches!(key, 0x53 | 0x54 | 0x58),
                ),
                0x65 => (0x5d, true),
                0xe0..=0xe7 => (
                    [0x1d, 0x2a, 0x38, 0x5b, 0x1d, 0x36, 0x38, 0x5c][usize::from(key - 0xe0)],
                    matches!(key, 0xe3 | 0xe4 | 0xe6 | 0xe7),
                ),
                _ => bail!("unsupported Windows key: {key}"),
            };
            send(
                scan,
                KEYEVENTF_SCANCODE
                    | if extended { KEYEVENTF_EXTENDEDKEY } else { 0 }
                    | if down { 0 } else { KEYEVENTF_KEYUP },
            )
        }

        fn text(&mut self, text: &str) -> Result<()> {
            let deadline = Instant::now() + Duration::from_millis(400);
            for unit in text.encode_utf16() {
                ensure!(
                    Instant::now() < deadline,
                    "text execution budget exceeded; text may be partial, do not automatically retry"
                );
                send(unit, KEYEVENTF_UNICODE)?;
                send(unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)?;
            }
            Ok(())
        }

        fn pointer(&mut self, action: Pointer, _modifiers: u8) -> Result<()> {
            let mouse = |dx, dy, data, flags| {
                inject(INPUT {
                    r#type: INPUT_MOUSE,
                    Anonymous: INPUT_0 {
                        mi: MOUSEINPUT {
                            dx,
                            dy,
                            mouseData: data,
                            dwFlags: flags,
                            time: 0,
                            dwExtraInfo: 0,
                        },
                    },
                })
            };
            match action {
                Pointer::Move { x, y, .. } => {
                    mouse(i32::from(x), i32::from(y), 0, MOUSEEVENTF_MOVE)
                }
                Pointer::Button { button, down, .. } => {
                    let flag = match (button, down) {
                        (1, true) => MOUSEEVENTF_LEFTDOWN,
                        (1, false) => MOUSEEVENTF_LEFTUP,
                        (2, true) => MOUSEEVENTF_RIGHTDOWN,
                        (2, false) => MOUSEEVENTF_RIGHTUP,
                        (3, true) => MOUSEEVENTF_MIDDLEDOWN,
                        (3, false) => MOUSEEVENTF_MIDDLEUP,
                        _ => bail!("unsupported mouse button"),
                    };
                    mouse(0, 0, 0, flag)
                }
                Pointer::Scroll { x, y } => {
                    if y != 0 {
                        mouse(0, 0, (-i32::from(y) * 3) as u32, MOUSEEVENTF_WHEEL)?;
                    }
                    if x != 0 {
                        mouse(0, 0, (i32::from(x) * 3) as u32, MOUSEEVENTF_HWHEEL)?;
                    }
                    Ok(())
                }
            }
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod native {
    use crate::input::Adapter;
    use anyhow::{Result, bail};

    pub fn create() -> Result<Box<dyn Adapter>> {
        bail!("native injection supports macOS and Windows only; use --dry-run")
    }
}
