//! The picture check on Word and PowerPoint edits (Epo 2026-10-24, Q287,
//! Q344): a picture an update adds is a PNG, JPEG or GIF of at most the
//! plan image cap (`plan_limits.image_max_bytes`, passed in) and [MAX_SIDE]
//! px on its long side, read from its header only. EMF, WMF, SVG and every
//! other format are refused. The editors compress every inserted picture to
//! these first (src/lib/fitImage.ts), so only a client past them meets the
//! refusal, which is final. The gateway checks uploads the same way
//! (server/internal/imagecheck).
//!
//! A DOCX picture is a `data:` URL on its image embed until the next
//! publication; a PPTX one is the bytes on its shape's `pendingMedia`.

use base64::Engine;
use ydoc::Incoming;
use yrs::block::ItemContent;
use yrs::{Any, ID, ReadTxn};

/// The long side (Q286), the gateway's `imagecheck.MaxSide`.
pub const MAX_SIDE: usize = 2400;
/// The PPTX shape key a pending picture's bytes sit at.
const PENDING_MEDIA: &str = "pendingMedia";

/// Refuses an update that adds a picture past the limits, `max_bytes` the
/// image cap; entries the room already holds pass, as they passed when they
/// arrived.
pub fn picture_violation<T: ReadTxn>(
    txn: &T,
    incoming: &Incoming,
    max_bytes: usize,
) -> Result<(), String> {
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
                found = check(picture, pending, max_bytes);
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

/// A picture's `data:` URL: an image type or base64 data, so text that only
/// starts with "data:" (alt text "Data: survey results") passes (review S6).
fn is_data_url(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() > 5
        && bytes[..5].eq_ignore_ascii_case(b"data:")
        && (bytes.len() > 11 && bytes[..11].eq_ignore_ascii_case(b"data:image/")
            || text
                .split_once(',')
                .is_some_and(|(head, _)| head.to_ascii_lowercase().ends_with(";base64")))
}

/// The raster formats a picture may be (Q344).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Raster {
    Png,
    Jpeg,
    Gif,
}

fn raster(bytes: &[u8]) -> Option<Raster> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(Raster::Png)
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some(Raster::Jpeg)
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some(Raster::Gif)
    } else {
        None
    }
}

/// Checks one payload: a `data:` URL by its decoded bytes, and bytes at
/// `pendingMedia`, are pictures whatever they hold; other bytes are one only
/// when they read as PNG, JPEG, GIF, EMF or WMF (a comment anchor's position
/// is bytes too).
fn check(picture: Picture, pending: bool, max_bytes: usize) -> Result<(), String> {
    let decoded;
    let bytes = match picture {
        Picture::Bytes(bytes) => {
            if !pending && raster(bytes).is_none() && !is_vector(bytes) {
                return Ok(());
            }
            bytes
        }
        Picture::DataUrl(url) => {
            let Some((head, payload)) = url[5..].split_once(',') else {
                return Err("Office update holds a malformed picture".into());
            };
            if !head.to_ascii_lowercase().ends_with(";base64") {
                return Err("Office update holds a picture that is not base64".into());
            }
            // Base64 is four characters per three bytes: refused before decoding.
            if payload.len() / 4 * 3 > max_bytes + 3 {
                return Err(too_large(max_bytes));
            }
            decoded = base64::engine::general_purpose::STANDARD
                .decode(payload.trim_end())
                .map_err(|_| "Office update holds a picture that is not base64".to_owned())?;
            decoded.as_slice()
        }
    };
    // A standard WMF header is only four bytes: read as one only where a
    // picture goes.
    if is_vector(bytes) || bytes.starts_with(&[1, 0, 9, 0]) || bytes.starts_with(&[2, 0, 9, 0]) {
        return Err("Office update adds an EMF or WMF picture".into());
    }
    let Some(kind) = raster(bytes) else {
        return Err("Office update adds a picture that is not PNG, JPEG or GIF".into());
    };
    if bytes.len() > max_bytes {
        return Err(too_large(max_bytes));
    }
    let size = match kind {
        Raster::Gif => gif_size(bytes),
        _ => imagesize::blob_size(bytes)
            .ok()
            .map(|size| (size.width, size.height)),
    };
    match size {
        Some((width, height)) if width.max(height) <= MAX_SIDE => Ok(()),
        Some(_) => Err(too_large(max_bytes)),
        None => Err("Office update adds a picture whose size cannot be read".into()),
    }
}

/// A GIF's size: its logical screen, or its first frame where that runs past
/// the screen (review S9), as Pillow and browsers size it.
fn gif_size(bytes: &[u8]) -> Option<(usize, usize)> {
    let word = |at: usize| -> Option<usize> {
        Some(u16::from_le_bytes([*bytes.get(at)?, *bytes.get(at + 1)?]) as usize)
    };
    let (width, height) = (word(6)?, word(8)?);
    let flags = *bytes.get(10)?;
    let mut at = 13;
    if flags & 0x80 != 0 {
        at += 3 << ((flags & 7) + 1);
    }
    loop {
        match *bytes.get(at)? {
            0x2c => {
                let (left, top) = (word(at + 1)?, word(at + 3)?);
                return Some((
                    width.max(left + word(at + 5)?),
                    height.max(top + word(at + 7)?),
                ));
            }
            // An extension: its label, then sub-blocks up to an empty one.
            0x21 => {
                at += 2;
                loop {
                    let size = *bytes.get(at)? as usize;
                    at += 1 + size;
                    if size == 0 {
                        break;
                    }
                }
            }
            _ => return None,
        }
    }
}

fn too_large(max_bytes: usize) -> String {
    format!("Office update adds a picture over {max_bytes} bytes or {MAX_SIDE} px")
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

    /// The image cap on every plan today (`plan_limits.image_max_bytes`).
    const MAX_BYTES: usize = 2 << 20;

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
        picture_violation(&room.transact(), &Incoming::new(&decoded), MAX_BYTES)
    }

    fn docx_image(src: String) -> impl FnOnce(&Doc) {
        docx_image_with_alt(src, "")
    }

    fn docx_image_with_alt(src: String, alt: &'static str) -> impl FnOnce(&Doc) {
        move |doc| {
            let text = doc.get_or_insert_text("story");
            let mut txn = doc.transact_mut();
            let attrs = Any::Map(Arc::new(HashMap::from([
                ("type".to_owned(), Any::from("image")),
                ("src".to_owned(), Any::from(src)),
                ("alt".to_owned(), Any::from(alt)),
            ])));
            text.insert_embed(&mut txn, 0, attrs);
        }
    }

    /// A GIF whose logical screen and first frame (left, top, width,
    /// height) claim their own sizes.
    fn gif(screen: (u16, u16), frame: [u16; 4]) -> Vec<u8> {
        let mut out = b"GIF89a".to_vec();
        out.extend(screen.0.to_le_bytes());
        out.extend(screen.1.to_le_bytes());
        out.extend([0x80, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff]);
        out.extend([0x21, 0xf9, 0x04, 0, 0, 0, 0, 0, 0x2c]);
        for value in frame {
            out.extend(value.to_le_bytes());
        }
        out.extend([0, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b]);
        out
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
        // The cap is the one passed in (review N4).
        let cap = |max_bytes| {
            let client = Doc::new();
            docx_image(data_url(&png(800, 600)))(&client);
            let update = client
                .transact()
                .encode_state_as_update_v1(&Default::default());
            let decoded = Update::decode_v1(&update).unwrap();
            picture_violation(&room.transact(), &Incoming::new(&decoded), max_bytes)
        };
        assert!(cap(MAX_BYTES).is_ok());
        assert!(cap(10).is_err());
    }

    #[test]
    fn a_picture_is_png_jpeg_or_gif_by_its_decoded_bytes() {
        // Security regression (Q344, Q348; review S6, S9): a data URL is
        // read by its bytes, whatever type it names, and only PNG, JPEG and
        // GIF pass.
        let room = Doc::new();
        let url = |bytes: &[u8]| docx_image(data_url(bytes));
        assert!(violation(&room, url(&gif((10, 10), [0, 0, 10, 10]))).is_ok());
        let mut jpeg = vec![0xff, 0xd8, 0xff, 0xc0, 0, 0x11, 8, 0, 16, 0, 32];
        jpeg.resize(40, 0);
        assert!(violation(&room, url(&jpeg)).is_ok());
        for refused in [
            // A standard WMF behind data:image/png.
            vec![1, 0, 9, 0, 0, 3],
            b"<svg xmlns='http://www.w3.org/2000/svg'/>".to_vec(),
            b"RIFF\0\0\0\0WEBPVP8 ".to_vec(),
            b"not a picture".to_vec(),
            // A frame larger than the screen it claims.
            gif((1, 1), [10, 20, 60000, 50000]),
        ] {
            assert!(violation(&room, url(&refused)).is_err());
        }
        assert!(violation(&room, pptx_picture(b"<svg/>".to_vec())).is_err());
        assert!(violation(&room, pptx_picture(b"RIFF\0\0\0\0WEBPVP8 ".to_vec())).is_err());
        // Text that only starts with "data:" is no picture.
        assert!(
            violation(
                &room,
                docx_image_with_alt(data_url(&png(10, 10)), "Data: survey results, 2024")
            )
            .is_ok()
        );
        assert!(
            violation(&room, |doc| {
                let map = doc.get_or_insert_map("comments");
                map.insert(&mut doc.transact_mut(), "text", "data: see the table");
            })
            .is_ok()
        );
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
