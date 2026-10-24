//! The picture check on Word and PowerPoint edits (Epo 2026-10-24, Q287):
//! a picture an update adds holds at most [MAX_BYTES] and [MAX_SIDE] px on
//! its long side, read from its header only, and is not EMF or WMF. The
//! editors compress every inserted picture to these first (src/lib/fitImage.ts),
//! so only a client past them meets the refusal, which is final. The gateway
//! checks uploads the same way (server/internal/imagecheck).
//!
//! A DOCX picture is a `data:` URL on its image embed until the next
//! publication; a PPTX one is the bytes on its shape's `pendingMedia`.

use base64::Engine;
use ydoc::Incoming;
use yrs::block::ItemContent;
use yrs::{Any, ID, ReadTxn};

/// The image cap, 2 MiB on every plan (Epo 2026-10-24).
pub const MAX_BYTES: usize = 2 << 20;
/// The long side (Q286), the gateway's `imagecheck.MaxSide`.
pub const MAX_SIDE: usize = 2400;
/// The PPTX shape key a pending picture's bytes sit at.
const PENDING_MEDIA: &str = "pendingMedia";

/// Refuses an update that adds a picture past the limits; entries the room
/// already holds pass, as they passed when they arrived.
pub fn picture_violation<T: ReadTxn>(txn: &T, incoming: &Incoming) -> Result<(), String> {
    let mut state = None;
    for item in incoming.items() {
        let content = item.content();
        if !carries_payload(content) {
            continue;
        }
        let state = state.get_or_insert_with(|| txn.state_vector());
        let ID { client, clock } = *item.id();
        if clock + item.len() <= state.get(&client) {
            continue;
        }
        let pending = item.parent_sub().is_some_and(|key| &**key == PENDING_MEDIA);
        let mut found = Ok(());
        visit(content, &mut |picture| {
            if found.is_ok() {
                found = check(picture, pending);
            }
        });
        found?;
    }
    Ok(())
}

/// A payload a picture could ride in: a string or bytes, alone or nested.
fn carries_payload(content: &ItemContent) -> bool {
    matches!(
        content,
        ItemContent::Any(_)
            | ItemContent::Embed(_)
            | ItemContent::Format(_, _)
            | ItemContent::Binary(_)
            | ItemContent::JSON(_)
    )
}

/// One picture payload: a `data:` URL or raw bytes.
enum Picture<'a> {
    DataUrl(&'a str),
    Bytes(&'a [u8]),
}

fn visit<'a>(content: &'a ItemContent, found: &mut impl FnMut(Picture<'a>)) {
    match content {
        ItemContent::Any(values) => values.iter().for_each(|value| visit_any(value, found)),
        ItemContent::Embed(value) => visit_any(value, found),
        ItemContent::Format(_, value) => visit_any(value, found),
        ItemContent::Binary(bytes) => found(Picture::Bytes(bytes)),
        ItemContent::JSON(values) => values
            .iter()
            .filter(|value| is_data_url(value))
            .for_each(|value| found(Picture::DataUrl(value))),
        _ => {}
    }
}

fn visit_any<'a>(value: &'a Any, found: &mut impl FnMut(Picture<'a>)) {
    match value {
        Any::String(text) if is_data_url(text) => found(Picture::DataUrl(text)),
        Any::Buffer(bytes) => found(Picture::Bytes(bytes)),
        Any::Array(values) => values.iter().for_each(|value| visit_any(value, found)),
        Any::Map(entries) => entries.values().for_each(|value| visit_any(value, found)),
        _ => {}
    }
}

fn is_data_url(text: &str) -> bool {
    text.len() > 5 && text.as_bytes()[..5].eq_ignore_ascii_case(b"data:")
}

/// Checks one payload. Bytes that are no known picture pass (a comment
/// anchor's position is bytes too), except at `pendingMedia`, where only a
/// picture goes; a `data:` URL is a picture whatever it holds.
fn check(picture: Picture, pending: bool) -> Result<(), String> {
    let decoded;
    let (bytes, media_type) = match picture {
        Picture::Bytes(bytes) => (bytes, ""),
        Picture::DataUrl(url) => {
            let Some((head, payload)) = url[5..].split_once(',') else {
                return Err("Office update holds a malformed picture".into());
            };
            if !head.to_ascii_lowercase().ends_with(";base64") {
                return Err("Office update holds a picture that is not base64".into());
            }
            // Base64 is four characters per three bytes: refused before decoding.
            if payload.len() / 4 * 3 > MAX_BYTES + 3 {
                return Err(too_large());
            }
            decoded = base64::engine::general_purpose::STANDARD
                .decode(payload.trim_end())
                .map_err(|_| "Office update holds a picture that is not base64".to_owned())?;
            (decoded.as_slice(), head)
        }
    };
    let media_type = media_type.to_ascii_lowercase();
    // A standard WMF header is only four bytes: read as one only where a
    // picture goes.
    let wmf = pending && (bytes.starts_with(&[1, 0, 9, 0]) || bytes.starts_with(&[2, 0, 9, 0]));
    if wmf || is_vector(bytes) || media_type.contains("emf") || media_type.contains("wmf") {
        return Err("Office update adds an EMF or WMF picture".into());
    }
    let raster = imagesize::image_type(bytes).is_ok();
    if !raster && !pending && media_type.is_empty() {
        return Ok(());
    }
    if bytes.len() > MAX_BYTES {
        return Err(too_large());
    }
    if !raster {
        // A picture of a format whose size its header does not give (SVG).
        return Ok(());
    }
    match imagesize::blob_size(bytes) {
        Ok(size) if size.width.max(size.height) <= MAX_SIDE => Ok(()),
        Ok(_) => Err(too_large()),
        Err(_) => Err("Office update adds a picture whose size cannot be read".into()),
    }
}

fn too_large() -> String {
    format!(
        "Office update adds a picture over {} MiB or {MAX_SIDE} px",
        MAX_BYTES >> 20
    )
}

/// EMF (record 1 with " EMF" at byte 40) or a placeable WMF header.
fn is_vector(bytes: &[u8]) -> bool {
    (bytes.starts_with(&[1, 0, 0, 0]) && bytes.get(40..44) == Some(b" EMF"))
        || bytes.starts_with(&[0xd7, 0xcd, 0xc6, 0x9a])
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Arc;

    use base64::Engine;
    use yrs::updates::decoder::Decode;
    use yrs::{Doc, Map, MapPrelim, Text, Transact, Update};

    use super::*;

    /// A PNG signature and an IHDR claiming width x height, no pixels.
    fn png(width: u32, height: u32) -> Vec<u8> {
        let mut out = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
        out.extend(width.to_be_bytes());
        out.extend(height.to_be_bytes());
        out.extend([8, 2, 0, 0, 0, 0, 0, 0, 0]);
        out
    }

    fn data_url(bytes: &[u8]) -> String {
        format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )
    }

    /// The update a client sends after `edit` on a copy of `room`.
    fn violation(room: &Doc, edit: impl FnOnce(&Doc)) -> Result<(), String> {
        let client = Doc::new();
        let state = room
            .transact()
            .encode_state_as_update_v1(&Default::default());
        client
            .transact_mut()
            .apply_update(Update::decode_v1(&state).unwrap())
            .unwrap();
        let before = client.transact().state_vector();
        edit(&client);
        let update = client.transact().encode_state_as_update_v1(&before);
        let decoded = Update::decode_v1(&update).unwrap();
        picture_violation(&room.transact(), &Incoming::new(&decoded))
    }

    fn docx_image(src: String) -> impl FnOnce(&Doc) {
        move |doc| {
            let text = doc.get_or_insert_text("story");
            let mut txn = doc.transact_mut();
            let attrs = Any::Map(Arc::new(HashMap::from([
                ("type".to_owned(), Any::from("image")),
                ("src".to_owned(), Any::from(src)),
            ])));
            text.insert_embed(&mut txn, 0, attrs);
        }
    }

    fn pptx_picture(bytes: Vec<u8>) -> impl FnOnce(&Doc) {
        move |doc| {
            let shapes = doc.get_or_insert_map("pptx:shapes");
            let mut txn = doc.transact_mut();
            let shape = shapes.insert(&mut txn, "shape-1", MapPrelim::default());
            shape.insert(&mut txn, PENDING_MEDIA, Any::Buffer(Arc::from(bytes)));
        }
    }

    #[test]
    fn a_docx_picture_past_the_long_side_or_the_cap_is_refused() {
        let room = Doc::new();
        assert!(violation(&room, docx_image(data_url(&png(2400, 1600)))).is_ok());
        assert!(violation(&room, docx_image(data_url(&png(2401, 10)))).is_err());
        // A decompression bomb, refused from its header.
        assert!(violation(&room, docx_image(data_url(&png(50_000, 50_000)))).is_err());
        let mut big = png(800, 600);
        big.resize(MAX_BYTES + 1, 0);
        assert!(violation(&room, docx_image(data_url(&big))).is_err());
    }

    #[test]
    fn a_pptx_picture_past_the_long_side_or_in_emf_is_refused() {
        let room = Doc::new();
        assert!(violation(&room, pptx_picture(png(1000, 1000))).is_ok());
        assert!(violation(&room, pptx_picture(png(10, 2401))).is_err());
        let mut emf = vec![0; 64];
        emf[..4].copy_from_slice(&[1, 0, 0, 0]);
        emf[40..44].copy_from_slice(b" EMF");
        assert!(violation(&room, pptx_picture(emf.clone())).is_err());
        assert!(
            violation(
                &room,
                docx_image(format!(
                    "data:image/x-wmf;base64,{}",
                    base64::engine::general_purpose::STANDARD.encode([1, 0, 9, 0])
                ))
            )
            .is_err()
        );
        // A string whatever its characters, and bytes that are no picture
        // away from pendingMedia, pass.
        assert!(
            violation(&room, |doc| {
                let map = doc.get_or_insert_map("comments");
                map.insert(&mut doc.transact_mut(), "text", "\u{e9}t\u{e9}");
            })
            .is_ok()
        );
        assert!(
            violation(&room, |doc| {
                let map = doc.get_or_insert_map("comments");
                map.insert(
                    &mut doc.transact_mut(),
                    "anchor",
                    Any::Buffer(Arc::from(vec![1u8, 0, 9, 0])),
                );
            })
            .is_ok()
        );
    }
}
