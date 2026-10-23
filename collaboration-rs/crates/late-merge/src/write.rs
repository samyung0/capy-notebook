//! Writing the merged update: structs per client from the first clock the
//! current document lacks, items with their placed origins, the rest GC.

use std::collections::BTreeMap;
use std::sync::Arc;

use yrs::block::{ClientID, ItemContent};
use yrs::encoding::write::Write;
use yrs::updates::encoder::{Encode, Encoder, EncoderV1};
use yrs::{ID, IdSet};

use crate::{ParentRef, Refused};

/// An item's content, whole or units `start..=end` of it.
pub enum ContentRef {
    Owned(ItemContent),
    Slice(ItemContent, u32, u32),
}

impl ContentRef {
    fn ref_number(&self) -> u8 {
        match self {
            ContentRef::Owned(c) | ContentRef::Slice(c, _, _) => c.get_ref_number(),
        }
    }

    fn encode(&self, enc: &mut EncoderV1) {
        match self {
            ContentRef::Owned(c) => c.encode(enc),
            ContentRef::Slice(ItemContent::String(s), start, end) => {
                // yrs's `encode_slice` keeps the whole rest of a string when
                // `end` is 0, so a string is cut here.
                let units: Vec<u16> = s.as_str().encode_utf16().collect();
                let part = &units[*start as usize..=*end as usize];
                enc.write_string(&String::from_utf16_lossy(part));
            }
            ContentRef::Slice(c, start, end) => c.encode_slice(enc, *start, *end),
        }
    }
}

/// One struct to write.
pub enum Out {
    Gc(u32),
    Item {
        origin: Option<ID>,
        right: Option<ID>,
        /// Written only when neither origin is.
        parent: Option<ParentRef>,
        key: Option<Arc<str>>,
        content: ContentRef,
    },
}

/// Appends `len` GC units, joining a GC struct just before.
pub fn push_gc(structs: &mut Vec<Out>, len: u32) {
    if let Some(Out::Gc(n)) = structs.last_mut() {
        *n += len;
    } else {
        structs.push(Out::Gc(len));
    }
}

/// A v1 update: each client's section (its first clock, its structs), then
/// the delete set.
pub fn update(
    sections: BTreeMap<ClientID, (u32, Vec<Out>)>,
    deletes: &IdSet,
) -> Result<Vec<u8>, Refused> {
    let mut enc = EncoderV1::new();
    let mut clients: Vec<_> = sections
        .into_iter()
        .filter(|(_, (_, s))| !s.is_empty())
        .collect();
    clients.sort_by_key(|a| std::cmp::Reverse(a.0));
    enc.write_var(clients.len());
    for (client, (start, structs)) in clients {
        enc.write_var(structs.len());
        enc.write_client(client);
        enc.write_var(start);
        for out in structs {
            match out {
                Out::Gc(len) => {
                    enc.write_info(0);
                    enc.write_len(len);
                }
                Out::Item {
                    origin,
                    right,
                    parent,
                    key,
                    content,
                } => {
                    let explicit = origin.is_none() && right.is_none();
                    let info = if origin.is_some() { 0x80 } else { 0 }
                        | if right.is_some() { 0x40 } else { 0 }
                        | if explicit && key.is_some() { 0x20 } else { 0 }
                        | (content.ref_number() & 0x1f);
                    enc.write_info(info);
                    if let Some(o) = &origin {
                        enc.write_left_id(o);
                    }
                    if let Some(r) = &right {
                        enc.write_right_id(r);
                    }
                    if explicit {
                        match parent {
                            Some(ParentRef::Root(name)) => {
                                enc.write_parent_info(true);
                                enc.write_string(&name);
                            }
                            Some(ParentRef::Item(pid)) => {
                                enc.write_parent_info(false);
                                enc.write_left_id(&pid);
                            }
                            None => {
                                return Err(Refused::Shape(
                                    "an item without origins names no parent",
                                ));
                            }
                        }
                        if let Some(key) = &key {
                            enc.write_string(key);
                        }
                    }
                    content.encode(&mut enc);
                }
            }
        }
    }
    let mut out = enc.to_vec();
    out.extend_from_slice(&deletes.encode_v1());
    Ok(out)
}
