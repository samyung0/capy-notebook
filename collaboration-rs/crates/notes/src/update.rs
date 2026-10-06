//! A v1 update's structs and delete set as Yjs's `decodeUpdate` gives them,
//! read without integrating anything, and `inspectUpdate`
//! (`collaboration/src/officeRoots.ts`): where each new struct lands and
//! whether the room can place the update at all.

use std::collections::HashMap;
use std::sync::Arc;

use yrs::block::{
    BLOCK_GC_REF_NUMBER, BLOCK_SKIP_REF_NUMBER, ClientID, HAS_ORIGIN, HAS_PARENT_SUB,
    HAS_RIGHT_ORIGIN, ItemContent,
};
use yrs::encoding::read::{Error, Read};
use yrs::updates::decoder::{Decode, Decoder, DecoderV1};
use yrs::{ID, IdSet, OffsetKind, ReadTxn, StateVector};

/// An item's parent as the update writes it.
#[derive(Debug, Clone, PartialEq)]
pub enum Parent {
    /// Copied from its origin on integration (it has one).
    Origin,
    Root(Arc<str>),
    Item(ID),
}

#[derive(Debug)]
pub struct Item {
    pub id: ID,
    pub len: u32,
    pub origin: Option<ID>,
    pub right_origin: Option<ID>,
    pub parent: Parent,
    pub parent_sub: Option<Arc<str>>,
    pub content: ItemContent,
}

#[derive(Debug)]
pub enum Struct {
    Item(Item),
    Gc { id: ID, len: u32 },
    Skip { id: ID, len: u32 },
}

impl Struct {
    pub fn id(&self) -> ID {
        match self {
            Struct::Item(item) => item.id,
            Struct::Gc { id, .. } | Struct::Skip { id, .. } => *id,
        }
    }

    pub fn len(&self) -> u32 {
        match self {
            Struct::Item(item) => item.len,
            Struct::Gc { len, .. } | Struct::Skip { len, .. } => *len,
        }
    }
}

/// A decoded update: each client's structs in clock order (clients in the
/// order the update writes them), and the deleted ranges per client, sorted
/// and merged.
#[derive(Debug, Default)]
pub struct Decoded {
    pub clients: Vec<(ClientID, Vec<Struct>)>,
    pub deletes: HashMap<ClientID, Vec<(u32, u32)>>,
}

impl Decoded {
    pub fn decode(update: &[u8]) -> Result<Self, Error> {
        let mut decoder = DecoderV1::from(update);
        let count: u32 = decoder.read_var()?;
        let mut clients = Vec::new();
        for _ in 0..count {
            let structs_len: u32 = decoder.read_var()?;
            let client = decoder.read_client()?;
            let mut clock: u32 = decoder.read_var()?;
            let mut structs = Vec::new();
            for _ in 0..structs_len {
                let id = ID::new(client, clock);
                let info = decoder.read_info()?;
                let decoded = match info {
                    BLOCK_SKIP_REF_NUMBER => Struct::Skip {
                        id,
                        len: decoder.read_var()?,
                    },
                    BLOCK_GC_REF_NUMBER => Struct::Gc {
                        id,
                        len: decoder.read_len()?,
                    },
                    info => {
                        let copies_parent = info & (HAS_ORIGIN | HAS_RIGHT_ORIGIN) != 0;
                        let origin = if info & HAS_ORIGIN != 0 {
                            Some(decoder.read_left_id()?)
                        } else {
                            None
                        };
                        let right_origin = if info & HAS_RIGHT_ORIGIN != 0 {
                            Some(decoder.read_right_id()?)
                        } else {
                            None
                        };
                        let parent = if copies_parent {
                            Parent::Origin
                        } else if decoder.read_parent_info()? {
                            Parent::Root(decoder.read_string()?.into())
                        } else {
                            Parent::Item(decoder.read_left_id()?)
                        };
                        let parent_sub = if !copies_parent && info & HAS_PARENT_SUB != 0 {
                            Some(decoder.read_string()?.into())
                        } else {
                            None
                        };
                        let content = ItemContent::decode(&mut decoder, info)?;
                        let len = content.len(OffsetKind::Utf16);
                        if len == 0 {
                            // Yjs never writes an empty struct; old encoders did.
                            continue;
                        }
                        Struct::Item(Item {
                            id,
                            len,
                            origin,
                            right_origin,
                            parent,
                            parent_sub,
                            content,
                        })
                    }
                };
                clock += decoded.len();
                structs.push(decoded);
            }
            clients.push((client, structs));
        }
        let delete_set = IdSet::decode(&mut decoder)?;
        let mut deletes = HashMap::new();
        for (client, range) in delete_set.iter() {
            let mut ranges: Vec<(u32, u32)> = range.iter().map(|r| (r.start, r.end)).collect();
            ranges.sort_unstable();
            let mut merged: Vec<(u32, u32)> = Vec::with_capacity(ranges.len());
            for (start, end) in ranges {
                match merged.last_mut() {
                    Some(last) if start <= last.1 => last.1 = last.1.max(end),
                    _ => merged.push((start, end)),
                }
            }
            deletes.insert(*client, merged);
        }
        Ok(Decoded { clients, deletes })
    }

    /// The new item holding `id`, if the update has one.
    pub fn item_at(&self, id: &ID) -> Option<&Item> {
        let (_, structs) = self
            .clients
            .iter()
            .find(|(client, _)| *client == id.client)?;
        let index = structs.partition_point(|s| s.id().clock + s.len() <= id.clock);
        match structs.get(index)? {
            Struct::Item(item) if item.id.clock <= id.clock => Some(item),
            _ => None,
        }
    }

    /// Whether the update deletes every unit of `[from, to)` of a client.
    pub fn deletes(&self, client: &ClientID, from: u32, to: u32) -> bool {
        if from >= to {
            return true;
        }
        let Some(ranges) = self.deletes.get(client) else {
            return false;
        };
        let index = ranges.partition_point(|(_, end)| *end <= from);
        ranges
            .get(index)
            .is_some_and(|(start, end)| *start <= from && *end >= to)
    }

    pub fn items(&self) -> impl Iterator<Item = &Item> {
        self.clients.iter().flat_map(|(_, structs)| {
            structs.iter().filter_map(|s| match s {
                Struct::Item(item) => Some(item),
                _ => None,
            })
        })
    }
}

/// Where a new struct sits: its top-level root and, in a map root, its key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Container {
    pub root: Arc<str>,
    pub key: Option<Arc<str>>,
}

/// What a client update holds that the room does not (`inspectUpdate`).
#[derive(Debug, Default)]
pub struct Inspection {
    pub containers: Vec<Container>,
    /// The room cannot integrate it yet: the caller drops it and resyncs.
    pub unheld: bool,
}

#[derive(Clone)]
enum Found {
    Container(Container),
    Gone,
    Unknown,
}

/// `inspectUpdate`: O(update), read against the room, never a copy of it.
pub fn inspect<T: ReadTxn>(txn: &T, decoded: &Decoded) -> Inspection {
    let state = txn.state_vector();
    let held = |client: &ClientID| state.get(client);
    let store = txn.store();
    let held_at = |id: &ID| -> Found {
        let Some(mut top) = store.get_item(id) else {
            return Found::Gone;
        };
        loop {
            let Some(parent) = top.parent_branch() else {
                return Found::Unknown;
            };
            match parent.item() {
                Some(item) => top = item,
                None => {
                    return match parent.id() {
                        yrs::branch::BranchID::Root(name) => Found::Container(Container {
                            root: name,
                            key: top.parent_sub().cloned(),
                        }),
                        _ => Found::Unknown,
                    };
                }
            }
        }
    };
    let mut resolved: HashMap<ID, Found> = HashMap::new();
    let mut container_of = |start: &Item| -> Found {
        let mut chain = Vec::new();
        let mut item = start;
        let found = loop {
            if let Some(known) = resolved.get(&item.id) {
                break known.clone();
            }
            resolved.insert(item.id, Found::Unknown);
            chain.push(item.id);
            let reference = match &item.parent {
                Parent::Root(name) => {
                    break Found::Container(Container {
                        root: name.clone(),
                        key: item.parent_sub.clone(),
                    });
                }
                Parent::Item(id) => Some(*id),
                Parent::Origin => item.origin.or(item.right_origin),
            };
            let Some(reference) = reference else {
                break Found::Unknown;
            };
            if reference.clock < held(&reference.client) {
                break held_at(&reference);
            }
            match decoded.item_at(&reference) {
                Some(next) => item = next,
                None => break Found::Unknown,
            }
        };
        for id in chain {
            resolved.insert(id, found.clone());
        }
        found
    };
    let mut unheld = false;
    let mut reach: HashMap<ClientID, u32> = HashMap::new();
    for (client, structs) in &decoded.clients {
        for s in structs {
            let from = reach.get(client).copied().unwrap_or_else(|| held(client));
            if matches!(s, Struct::Skip { .. }) || s.id().clock > from {
                unheld = true;
            }
            reach.insert(*client, from.max(s.id().clock + s.len()));
        }
    }
    for (client, ranges) in &decoded.deletes {
        let until = reach.get(client).copied().unwrap_or_else(|| held(client));
        if ranges.iter().any(|(_, end)| *end > until) {
            unheld = true;
        }
    }
    let mut containers = Vec::new();
    for item in decoded.items() {
        if item.id.clock + item.len <= held(&item.id.client) {
            continue;
        }
        match container_of(item) {
            Found::Gone => {}
            Found::Unknown => unheld = true,
            Found::Container(container) => containers.push(container),
        }
    }
    Inspection { containers, unheld }
}

/// A state vector of the room, for `held` checks.
pub fn held(state: &StateVector, id: &ID) -> bool {
    id.clock < state.get(&id.client)
}
