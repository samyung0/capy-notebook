//! Text sources: one `Y.Text` named `source` holding the file's text.

use yrs::{
    Doc, GetString, OffsetKind, Options, ReadTxn, Text, Transact, Update, updates::decoder::Decode,
};

pub const TEXT_ROOT: &str = "source";

/// A working document for text sources: UTF-16 offsets, as the browser and
/// the TS server indexed `Y.Text`.
pub fn text_doc(client_id: u64) -> Doc {
    Doc::with_options(Options {
        client_id: yrs::block::ClientID::new(client_id),
        offset_kind: OffsetKind::Utf16,
        ..Options::default()
    })
}

/// A text source's bytes as text: newlines and a BOM kept, invalid UTF-8
/// refused (TextDecoder fatal, ignoreBOM).
pub fn decode_text(bytes: &[u8]) -> Result<&str, std::str::Utf8Error> {
    std::str::from_utf8(bytes)
}

/// seed(base) of a text source, written under client 0 so every instance
/// seeds the same lineage for a state that is still NULL (textSeed).
pub fn text_seed(bytes: &[u8]) -> Result<Vec<u8>, std::str::Utf8Error> {
    let text = decode_text(bytes)?;
    let doc = text_doc(0);
    let root = doc.get_or_insert_text(TEXT_ROOT);
    {
        let mut txn = doc.transact_mut();
        root.insert(&mut txn, 0, text);
    }
    Ok(doc
        .transact()
        .encode_state_as_update_v1(&yrs::StateVector::default()))
}

/// The text a state holds (textState).
pub fn text_state(state: &[u8]) -> Result<String, yrs::encoding::read::Error> {
    let doc = text_doc(1);
    let root = doc.get_or_insert_text(TEXT_ROOT);
    let update = Update::decode_v1(state)?;
    let mut txn = doc.transact_mut();
    let _ = txn.apply_update(update);
    Ok(root.get_string(&txn))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_seed_is_deterministic_and_reads_back() {
        let bytes = "\u{feff}line one\r\nzwei 😀\n".as_bytes();
        let seed = text_seed(bytes).unwrap();
        assert_eq!(seed, text_seed(bytes).unwrap());
        assert_eq!(text_state(&seed).unwrap(), "\u{feff}line one\r\nzwei 😀\n");
        assert!(text_seed(&[0xff, 0xfe, 0x00]).is_err());
    }
}
