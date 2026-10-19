//! capy-sync 1 (DESIGN.md 1.3): `varuint channel` `u8 type` `varuint length`
//! `payload`, several messages per WebSocket frame. Payloads of SYNC and
//! AWARENESS are y-sync v1 and y-protocols awareness messages unchanged.

use bytes::{BufMut, Bytes, BytesMut};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Kind {
    Join = 0,
    Joined = 1,
    Refused = 2,
    Leave = 3,
    Closed = 4,
    Sync = 5,
    Ack = 6,
    Awareness = 7,
    QueryAwareness = 8,
    Stateless = 9,
    TokenRequest = 10,
    Token = 11,
}

impl Kind {
    fn from_u8(value: u8) -> Option<Self> {
        Some(match value {
            0 => Kind::Join,
            1 => Kind::Joined,
            2 => Kind::Refused,
            3 => Kind::Leave,
            4 => Kind::Closed,
            5 => Kind::Sync,
            6 => Kind::Ack,
            7 => Kind::Awareness,
            8 => Kind::QueryAwareness,
            9 => Kind::Stateless,
            10 => Kind::TokenRequest,
            11 => Kind::Token,
            _ => return None,
        })
    }
}

/// One message of a frame; `payload` shares the frame's buffer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Message {
    pub channel: u64,
    pub kind: Kind,
    pub payload: Bytes,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum FrameError {
    #[error("truncated frame")]
    Truncated,
    #[error("unknown message type {0}")]
    UnknownKind(u8),
    #[error("malformed payload")]
    Payload,
    #[error("more than {MAX_FRAME_MESSAGES} messages in a frame")]
    TooMany,
}

/// The most messages one client frame may carry (clients send one each).
pub const MAX_FRAME_MESSAGES: usize = 64;

pub fn write_var(out: &mut impl BufMut, mut value: u64) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.put_u8(byte);
            return;
        }
        out.put_u8(byte | 0x80);
    }
}

/// A lib0 varuint at `at`, advancing it.
pub fn read_var(bytes: &[u8], at: &mut usize) -> Result<u64, FrameError> {
    let mut value = 0u64;
    let mut shift = 0;
    loop {
        let byte = *bytes.get(*at).ok_or(FrameError::Truncated)?;
        *at += 1;
        if shift >= 64 {
            return Err(FrameError::Payload);
        }
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Ok(value);
        }
        shift += 7;
    }
}

pub fn write_string(out: &mut impl BufMut, value: &str) {
    write_var(out, value.len() as u64);
    out.put_slice(value.as_bytes());
}

/// A lib0 varstring at `at`.
pub fn read_string<'a>(bytes: &'a [u8], at: &mut usize) -> Result<&'a str, FrameError> {
    let len = usize::try_from(read_var(bytes, at)?).map_err(|_| FrameError::Payload)?;
    let end = at.checked_add(len).ok_or(FrameError::Truncated)?;
    let slice = bytes.get(*at..end).ok_or(FrameError::Truncated)?;
    *at = end;
    std::str::from_utf8(slice).map_err(|_| FrameError::Payload)
}

/// Every message of one WebSocket frame.
pub fn decode_frame(frame: &Bytes) -> Result<Vec<Message>, FrameError> {
    let mut messages = Vec::new();
    let mut at = 0;
    while at < frame.len() {
        if messages.len() == MAX_FRAME_MESSAGES {
            return Err(FrameError::TooMany);
        }
        let channel = read_var(frame, &mut at)?;
        let kind = *frame.get(at).ok_or(FrameError::Truncated)?;
        at += 1;
        let kind = Kind::from_u8(kind).ok_or(FrameError::UnknownKind(kind))?;
        let len = usize::try_from(read_var(frame, &mut at)?).map_err(|_| FrameError::Truncated)?;
        let end = at.checked_add(len).ok_or(FrameError::Truncated)?;
        if end > frame.len() {
            return Err(FrameError::Truncated);
        }
        messages.push(Message {
            channel,
            kind,
            payload: frame.slice(at..end),
        });
        at = end;
    }
    Ok(messages)
}

/// Appends one message to an outgoing frame.
pub fn encode(out: &mut BytesMut, channel: u64, kind: Kind, payload: &[u8]) {
    write_var(out, channel);
    out.put_u8(kind as u8);
    write_var(out, payload.len() as u64);
    out.put_slice(payload);
}

pub fn message(channel: u64, kind: Kind, payload: &[u8]) -> Bytes {
    let mut out = BytesMut::with_capacity(payload.len() + 12);
    encode(&mut out, channel, kind, payload);
    out.freeze()
}

/// The client protocol this server speaks; the SPA's `CLIENT_PROTOCOL`
/// (src/features/collaboration/protocol.ts, a test keeps them equal) rides
/// every JOIN and draft send. A change an older client would break (openwiki
/// plate-editor "Client protocol") raises it to N+1 and sets the broken
/// family's minimum to N+1; the other family keeps its minimum.
pub const CLIENT_PROTOCOL: u32 = 5;
/// The oldest client material rooms accept (`material:`, `keys:`: notes,
/// mindmaps, diagrams, quizzes, quiz keys, flashcard sets).
pub const MIN_MATERIAL: u32 = 4;
/// The oldest client source rooms accept (`source:`: Office and text); every
/// BetterOffice pin bump and Office protocol bump raises it.
pub const MIN_SOURCE: u32 = 5;
// A minimum above the server's own protocol would refuse every client.
const _: () = assert!(MIN_MATERIAL <= CLIENT_PROTOCOL && MIN_SOURCE <= CLIENT_PROTOCOL);

/// Whether a client's protocol is refused: below its room family's minimum,
/// or above this server's own (a newer tab after a rollback). A client from
/// before the gate sends none, read as 0.
pub fn outdated(minimum: u32, client: Option<u32>) -> bool {
    let client = client.unwrap_or(0);
    client < minimum || client > CLIENT_PROTOCOL
}

/// JOIN's payload.
#[derive(Debug, PartialEq, Eq)]
pub struct Join {
    pub room: String,
    pub token: String,
    /// The client protocol (none from a client before the version gate).
    pub protocol: Option<u32>,
    /// An embedded quiz's or set's note channel on the same socket, inside
    /// which it joins (Epo 2026-10-20).
    pub parent: Option<u64>,
}

/// JOIN's payload: the room name, the token, then optionally the client
/// protocol and an embed's note channel.
pub fn decode_join(payload: &[u8]) -> Result<Join, FrameError> {
    let mut at = 0;
    let room = read_string(payload, &mut at)?.to_owned();
    let token = read_string(payload, &mut at)?.to_owned();
    let protocol = if at < payload.len() {
        Some(u32::try_from(read_var(payload, &mut at)?).map_err(|_| FrameError::Payload)?)
    } else {
        None
    };
    let parent = if at < payload.len() {
        Some(read_var(payload, &mut at)?)
    } else {
        None
    };
    Ok(Join {
        room,
        token,
        protocol,
        parent,
    })
}

/// A varstring payload (REFUSED, STATELESS, TOKEN).
pub fn decode_text(payload: &[u8]) -> Result<String, FrameError> {
    let mut at = 0;
    Ok(read_string(payload, &mut at)?.to_owned())
}

pub fn text(value: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(value.len() + 4);
    write_string(&mut out, value);
    out
}

/// CLOSED's payload: a code (0 for none) and a reason.
pub fn closed(code: u16, reason: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(reason.len() + 6);
    write_var(&mut out, u64::from(code));
    write_string(&mut out, reason);
    out
}

pub fn ack(count: u64) -> Vec<u8> {
    let mut out = Vec::with_capacity(4);
    write_var(&mut out, count);
    out
}

/// y-sync v1 message types inside SYNC.
pub mod sync {
    use super::{FrameError, read_var, write_var};

    pub const STEP1: u64 = 0;
    pub const STEP2: u64 = 1;
    pub const UPDATE: u64 = 2;

    /// A SYNC payload: its y-sync type and its body (a state vector for step
    /// 1, an update otherwise).
    pub fn decode(payload: &[u8]) -> Result<(u64, &[u8]), FrameError> {
        let mut at = 0;
        let kind = read_var(payload, &mut at)?;
        if kind > UPDATE {
            return Err(FrameError::Payload);
        }
        let len = usize::try_from(read_var(payload, &mut at)?).map_err(|_| FrameError::Payload)?;
        let end = at.checked_add(len).ok_or(FrameError::Truncated)?;
        let body = payload.get(at..end).ok_or(FrameError::Truncated)?;
        Ok((kind, body))
    }

    pub fn encode(kind: u64, body: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(body.len() + 6);
        write_var(&mut out, kind);
        write_var(&mut out, body.len() as u64);
        out.extend_from_slice(body);
        out
    }
}

/// y-protocols awareness updates: `count`, then per client `id`, `clock`,
/// `state` (a JSON string, "null" for a removal). The server never parses the
/// JSON.
pub mod awareness {
    use super::{FrameError, read_string, read_var, write_string, write_var};

    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct Entry {
        pub client: u64,
        pub clock: u64,
        pub state: String,
    }

    impl Entry {
        pub fn removed(&self) -> bool {
            self.state == "null"
        }
    }

    pub fn decode(payload: &[u8]) -> Result<Vec<Entry>, FrameError> {
        let mut at = 0;
        let count = read_var(payload, &mut at)?;
        let mut entries = Vec::new();
        for _ in 0..count {
            let client = read_var(payload, &mut at)?;
            let clock = read_var(payload, &mut at)?;
            let state = read_string(payload, &mut at)?.to_owned();
            entries.push(Entry {
                client,
                clock,
                state,
            });
        }
        Ok(entries)
    }

    pub fn encode<'a>(entries: impl ExactSizeIterator<Item = &'a Entry>) -> Vec<u8> {
        let mut out = Vec::new();
        write_var(&mut out, entries.len() as u64);
        for entry in entries {
            write_var(&mut out, entry.client);
            write_var(&mut out, entry.clock);
            write_string(&mut out, &entry.state);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_frame_carries_at_most_its_message_cap() {
        let mut frame = BytesMut::new();
        for _ in 0..MAX_FRAME_MESSAGES {
            encode(&mut frame, 1, Kind::QueryAwareness, &[]);
        }
        let full = frame.clone().freeze();
        assert_eq!(decode_frame(&full).map(|m| m.len()), Ok(MAX_FRAME_MESSAGES));
        encode(&mut frame, 1, Kind::QueryAwareness, &[]);
        assert_eq!(decode_frame(&frame.freeze()), Err(FrameError::TooMany));
    }

    #[test]
    fn frames_round_trip_several_messages() {
        let mut out = BytesMut::new();
        encode(&mut out, 1, Kind::Sync, &sync::encode(sync::UPDATE, b"abc"));
        encode(&mut out, 300, Kind::Ack, &ack(7));
        encode(&mut out, 2, Kind::Stateless, &text("{\"type\":\"x\"}"));
        let messages = decode_frame(&out.freeze()).unwrap();
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0].channel, 1);
        assert_eq!(
            sync::decode(&messages[0].payload).unwrap(),
            (sync::UPDATE, &b"abc"[..])
        );
        assert_eq!(messages[1].channel, 300);
        assert_eq!(messages[1].kind, Kind::Ack);
        assert_eq!(
            decode_text(&messages[2].payload).unwrap(),
            "{\"type\":\"x\"}"
        );
    }

    #[test]
    fn malformed_frames_are_refused() {
        assert_eq!(
            decode_frame(&Bytes::from_static(&[1, 99, 0])),
            Err(FrameError::UnknownKind(99))
        );
        assert_eq!(
            decode_frame(&Bytes::from_static(&[1, 5, 4, 0])),
            Err(FrameError::Truncated)
        );
        assert_eq!(
            decode_frame(&Bytes::from_static(&[0x80])),
            Err(FrameError::Truncated)
        );
    }

    #[test]
    fn join_carries_the_client_protocol_and_an_embeds_note_channel_after_the_token() {
        let mut payload = Vec::new();
        write_string(&mut payload, "material:abc:schema:1");
        write_string(&mut payload, "token");
        let join = |protocol, parent| Join {
            room: "material:abc:schema:1".into(),
            token: "token".into(),
            protocol,
            parent,
        };
        // A client from before the gate sends two fields.
        assert_eq!(decode_join(&payload).unwrap(), join(None, None));
        write_var(&mut payload, 300);
        assert_eq!(decode_join(&payload).unwrap(), join(Some(300), None));
        write_var(&mut payload, 7);
        assert_eq!(decode_join(&payload).unwrap(), join(Some(300), Some(7)));
    }

    #[test]
    fn protocols_below_the_minimum_or_above_the_server_are_outdated() {
        assert!(outdated(1, None));
        assert!(outdated(1, Some(0)));
        assert!(!outdated(1, Some(1)));
        assert!(!outdated(CLIENT_PROTOCOL, Some(CLIENT_PROTOCOL)));
        assert!(outdated(1, Some(CLIENT_PROTOCOL + 1)));
        assert!(outdated(CLIENT_PROTOCOL + 1, Some(CLIENT_PROTOCOL)));
    }

    #[test]
    fn awareness_payloads() {
        let entries = vec![
            awareness::Entry {
                client: 3_000_000_000,
                clock: 4,
                state: "{\"a\":1}".into(),
            },
            awareness::Entry {
                client: 2,
                clock: 9,
                state: "null".into(),
            },
        ];
        let encoded = awareness::encode(entries.iter());
        assert_eq!(awareness::decode(&encoded).unwrap(), entries);
        assert!(entries[1].removed());
    }
}
