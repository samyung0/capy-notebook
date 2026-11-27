//! capy-sync 1 (DESIGN.md 1.3): `varuint channel` `u8 type` `varuint length`
//! `payload`, several messages per WebSocket frame. Payloads of SYNC and
//! AWARENESS are y-sync v1 and y-protocols awareness messages unchanged, but
//! for SYNC's pieces of a step 2 or update cut in pieces (`sync::PIECE`).

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

/// A client's heartbeat (protocol 41): a WebSocket text frame of exactly
/// this, which its socket sends every [HEARTBEAT_MS] while open (`HEARTBEAT`
/// and `HEARTBEAT_MS` in src/features/collaboration/protocol.ts, a test
/// keeps them equal). It proves the tab's code runs, which the browser's
/// automatic pongs do not: a long send to the client holds back the
/// server's pings and the acknowledgement a group's rest waits for, so its
/// heartbeats keep the socket heard (`socket.rs`) and renew a group waiting
/// on its first piece's acknowledgement, up to the group's limit
/// (`Room::drop_late_groups`). Any other text frame is ignored.
pub const HEARTBEAT: &str = "heartbeat";
/// How often a client sends its [HEARTBEAT]: the silent window and a
/// group's slack hold at least two (`config.rs` refuses less).
pub const HEARTBEAT_MS: u64 = 20_000;

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
pub const CLIENT_PROTOCOL: u32 = 45;
/// The oldest client material rooms accept (`material:`, `keys:`: notes,
/// mindmaps, diagrams, quizzes, quiz keys, flashcard sets, canvases).
pub const MIN_MATERIAL: u32 = 45;
/// The oldest client source rooms accept (`source:`: Office and text); every
/// BetterOffice pin bump and Office protocol bump raises it.
pub const MIN_SOURCE: u32 = 42;
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
    /// The session's Yjs client id (Q213): its first joined token's, the
    /// only id it writes document changes and awareness under.
    pub client: Option<u64>,
    /// The last stored version the session holds, never above the version
    /// its oldest unsent edit was made at (in-place collection; 0: a new
    /// session holding nothing). None from a source tab of an older build.
    pub version: Option<u64>,
    /// An embedded quiz's or set's note channel on the same socket, inside
    /// which it joins (Epo 2026-10-20).
    pub parent: Option<u64>,
    /// The editing session's random id (Q472): 16 bytes its RoomProvider
    /// draws at its start and sends with every JOIN, so a reconnect of the
    /// same session takes over its own channel. None from an older client.
    pub session_id: Option<u128>,
}

/// JOIN's payload: the room name, the token, then optionally the client
/// protocol, the session's client id, the stored version it holds, an
/// embed's note channel (0 for none: channels count from 1) and the editing
/// session's id (a varbytes of 16).
pub fn decode_join(payload: &[u8]) -> Result<Join, FrameError> {
    let mut at = 0;
    let room = read_string(payload, &mut at)?.to_owned();
    let token = read_string(payload, &mut at)?.to_owned();
    let protocol = if at < payload.len() {
        Some(u32::try_from(read_var(payload, &mut at)?).map_err(|_| FrameError::Payload)?)
    } else {
        None
    };
    let mut next = || -> Result<Option<u64>, FrameError> {
        if at < payload.len() {
            read_var(payload, &mut at).map(Some)
        } else {
            Ok(None)
        }
    };
    let client = next()?;
    let version = next()?;
    let parent = next()?.filter(|&note| note != 0);
    let session_id = if at < payload.len() {
        let len = read_var(payload, &mut at)?;
        let bytes = payload.get(at..at + 16).filter(|_| len == 16);
        let bytes: [u8; 16] = bytes
            .and_then(|bytes| bytes.try_into().ok())
            .ok_or(FrameError::Payload)?;
        Some(u128::from_be_bytes(bytes))
    } else {
        None
    };
    Ok(Join {
        room,
        token,
        protocol,
        client,
        version,
        parent,
        session_id,
    })
}

/// LEAVE's payload: one byte, 0 when the tab holds no unsent edits for the
/// document (Q236; anything else keeps its rows), then the session's client
/// id (in-place collection: the session a clean Leave ends; none from a
/// source tab of an older build).
pub fn decode_leave(payload: &[u8]) -> (bool, Option<u64>) {
    let clean = payload.first() == Some(&0);
    let mut at = 1;
    let session = if payload.len() > 1 {
        read_var(payload, &mut at)
            .ok()
            .filter(|_| at == payload.len())
    } else {
        None
    };
    (clean, session)
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

/// y-sync v1 message types inside SYNC, and capy's pieces.
pub mod sync {
    use super::{FrameError, read_var, write_var};

    pub const STEP1: u64 = 0;
    pub const STEP2: u64 = 1;
    pub const UPDATE: u64 = 2;
    /// One piece of a step 2 or update the browser cut in pieces
    /// (`splitUpdate`): a room admits a group's pieces as one update after
    /// its last, or none of them.
    pub const PIECE: u64 = 3;

    /// A [PIECE]'s body: the kind of what was cut (step 2 or update), the
    /// piece's place in its group and the group's count, then the piece.
    #[derive(Debug, PartialEq, Eq)]
    pub struct Piece<'a> {
        pub kind: u64,
        pub index: u64,
        pub count: u64,
        pub update: &'a [u8],
    }

    /// A [PIECE]'s body, or none when it names no step 2 or update, a group
    /// of fewer than two pieces or a place outside it.
    pub fn piece(body: &[u8]) -> Option<Piece<'_>> {
        let mut at = 0;
        let kind = read_var(body, &mut at).ok()?;
        let index = read_var(body, &mut at).ok()?;
        let count = read_var(body, &mut at).ok()?;
        let fits = matches!(kind, STEP2 | UPDATE) && count >= 2 && index < count;
        fits.then(|| Piece {
            kind,
            index,
            count,
            update: &body[at..],
        })
    }

    /// A SYNC payload: its type and its body (a state vector for step 1, an
    /// update for step 2 and update, a [Piece] for a piece).
    pub fn decode(payload: &[u8]) -> Result<(u64, &[u8]), FrameError> {
        let mut at = 0;
        let kind = read_var(payload, &mut at)?;
        if kind > PIECE {
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
    fn a_piece_names_its_kind_place_and_group() {
        let mut body = Vec::new();
        for value in [sync::STEP2, 1, 3] {
            write_var(&mut body, value);
        }
        body.extend_from_slice(b"update");
        let payload = sync::encode(sync::PIECE, &body);
        let (kind, decoded) = sync::decode(&payload).unwrap();
        assert_eq!(kind, sync::PIECE);
        assert_eq!(
            sync::piece(decoded),
            Some(sync::Piece {
                kind: sync::STEP2,
                index: 1,
                count: 3,
                update: b"update",
            })
        );
        // A step 1, a group of one or a place past the group is no piece.
        for (kind, index, count) in [
            (sync::STEP1, 0, 2),
            (sync::UPDATE, 0, 1),
            (sync::UPDATE, 2, 2),
        ] {
            let mut body = Vec::new();
            for value in [kind, index, count] {
                write_var(&mut body, value);
            }
            assert_eq!(sync::piece(&body), None, "{kind} {index} {count}");
        }
        assert_eq!(
            sync::decode(&sync::encode(sync::PIECE + 1, b"")),
            Err(FrameError::Payload)
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
    fn join_carries_the_protocol_client_id_version_note_channel_and_session_id_after_the_token() {
        let mut payload = Vec::new();
        write_string(&mut payload, "material:abc:schema:1");
        write_string(&mut payload, "token");
        let join = |protocol, client, version, parent, session_id| Join {
            room: "material:abc:schema:1".into(),
            token: "token".into(),
            protocol,
            client,
            version,
            parent,
            session_id,
        };
        // A client from before the gate sends two fields.
        assert_eq!(
            decode_join(&payload).unwrap(),
            join(None, None, None, None, None)
        );
        write_var(&mut payload, 300);
        write_var(&mut payload, 4_000_000_000);
        // A source tab of an older build sends no version.
        assert_eq!(
            decode_join(&payload).unwrap(),
            join(Some(300), Some(4_000_000_000), None, None, None)
        );
        write_var(&mut payload, 12);
        assert_eq!(
            decode_join(&payload).unwrap(),
            join(Some(300), Some(4_000_000_000), Some(12), None, None)
        );
        let outside = payload.clone();
        write_var(&mut payload, 7);
        assert_eq!(
            decode_join(&payload).unwrap(),
            join(Some(300), Some(4_000_000_000), Some(12), Some(7), None)
        );
        // Q472: the session id follows the note channel, 0 outside a note.
        let session = |mut payload: Vec<u8>, note| {
            write_var(&mut payload, note);
            write_var(&mut payload, 16);
            payload.extend_from_slice(&[0xab; 16]);
            decode_join(&payload)
        };
        let id = Some(u128::from_be_bytes([0xab; 16]));
        assert_eq!(
            session(outside.clone(), 0).unwrap(),
            join(Some(300), Some(4_000_000_000), Some(12), None, id)
        );
        assert_eq!(
            session(outside, 7).unwrap(),
            join(Some(300), Some(4_000_000_000), Some(12), Some(7), id)
        );
        // Any other length is malformed.
        write_var(&mut payload, 15);
        payload.extend_from_slice(&[0xab; 15]);
        assert_eq!(decode_join(&payload), Err(FrameError::Payload));
    }

    #[test]
    fn leave_says_whether_the_tab_is_clean_and_names_its_session() {
        assert_eq!(decode_leave(&[0]), (true, None));
        assert_eq!(decode_leave(&[1]), (false, None));
        assert_eq!(decode_leave(&[0, 0x80, 0x01]), (true, Some(128)));
        // A malformed session id names none.
        assert_eq!(decode_leave(&[0, 0x80]), (true, None));
        assert_eq!(decode_leave(&[0, 5, 6]), (true, None));
        assert_eq!(decode_leave(&[]), (false, None));
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

    /// Since protocol 37 (Epo 2026-11-22, "Yes, A everywhere") readers keep
    /// lists and texts two people's edits merged past a cap, up to twice it;
    /// a tab from before (36) reads a figure cut to the cap and its
    /// whole-figure write deletes what it did not read. Since 38 the board
    /// catalog changed and every viewer reads a canvas by the board rules,
    /// drawing what breaks them as a placeholder a tab from before (37) draws
    /// otherwise. Material rooms refuse both as outdated and they reload.
    /// Since 41 a long action goes as one group of pieces (SYNC type 3), which
    /// a tab from before (40) sends one by one and a room would admit apart, so
    /// both families refuse it. Source rooms then follow the BetterOffice pin,
    /// raised to 42 by the DOCX worker and caret pin. Since 44 a canvas
    /// stroke's points are one binary value: a tab from before (43) draws
    /// such a stroke as a placeholder and writes number arrays a newer tab
    /// draws as one, so material rooms refuse it. Since 45 a note may hold a
    /// `film` block and a canvas a film card: a tab from before (44) edits the
    /// film as a text block and refuses the card, so material rooms refuse it.
    #[test]
    fn a_material_tab_from_before_the_board_rules_is_outdated() {
        assert!(outdated(MIN_MATERIAL, Some(36)));
        assert!(outdated(MIN_MATERIAL, Some(37)));
        assert!(outdated(MIN_MATERIAL, Some(40)));
        assert!(outdated(MIN_MATERIAL, Some(44)));
        assert!(!outdated(MIN_MATERIAL, Some(45)));
        assert!(outdated(MIN_SOURCE, Some(41)));
        assert!(!outdated(MIN_SOURCE, Some(42)));
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
