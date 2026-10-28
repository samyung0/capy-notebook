//! The structural check of a blocks room and its repair on entry (D3).

use std::collections::{BTreeMap, BTreeSet, HashMap};

use yrs::block::ItemContent;
use yrs::types::text::YChange;
use yrs::{Any, Array, ID, Map as _, MapRef, Out, ReadTxn, Text, TransactionMut};

use crate::schema::{self, Kind, NOTE, PAGE, TABLE};
use crate::store::{child_array, child_ids, string, yblock};
use crate::{BLOCKS_ROOT, NOTE_ID, ROOT_ID};

/// Why a blocks room is not valid.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Violation {
    #[error("the room has no blocks map")]
    NoBlocks,
    #[error("hub {0:?} is missing or has the wrong flavour")]
    Hub(&'static str),
    #[error("block {0:?} is malformed")]
    Malformed(String),
    #[error("block {id:?} has unsupported flavour {flavour:?}")]
    Flavour { id: String, flavour: String },
    #[error("{parent:?} lists missing block {child:?}")]
    Dangling { parent: String, child: String },
    #[error("block {0:?} is listed more than once")]
    TwoParents(String),
    #[error("block {0:?} is not reachable from the root")]
    Unreachable(String),
    #[error("block {id:?} may not sit under {parent:?}")]
    Parent { id: String, parent: String },
    #[error("block {id:?}: prop {key:?} is unknown or has the wrong type")]
    Prop { id: String, key: String },
    #[error("block {id:?} lacks default prop {key:?}")]
    MissingDefault { id: String, key: String },
    #[error("block {id:?}: text {key:?} holds unsupported content")]
    Text { id: String, key: String },
}

/// Whether the room is valid: hubs in place, every block reachable from
/// `root` and listed exactly once, each under a parent its flavour allows,
/// and every prop known with its type.
pub fn check<T: ReadTxn>(txn: &T) -> Result<(), Violation> {
    let blocks = txn.get_map(BLOCKS_ROOT).ok_or(Violation::NoBlocks)?;
    let mut ids: Vec<String> = blocks.keys(txn).map(str::to_string).collect();
    ids.sort();
    // id → (flavour, children)
    let mut tree: BTreeMap<String, (String, Vec<String>)> = BTreeMap::new();
    for id in &ids {
        let malformed = || Violation::Malformed(id.clone());
        let map = yblock(txn, &blocks, id).ok_or_else(malformed)?;
        if string(txn, &map, "sys:id").as_deref() != Some(id) {
            return Err(malformed());
        }
        if !matches!(map.get(txn, "sys:version"), Some(Out::Any(Any::Number(_)))) {
            return Err(malformed());
        }
        let flavour = string(txn, &map, "sys:flavour").ok_or_else(malformed)?;
        let schema = schema::flavour(&flavour).ok_or_else(|| Violation::Flavour {
            id: id.clone(),
            flavour: flavour.clone(),
        })?;
        let children = child_ids(txn, &map).ok_or_else(malformed)?;
        props(txn, id, &map, schema)?;
        tree.insert(id.clone(), (flavour, children));
    }

    let flavour_of = |id: &str| tree.get(id).map(|(f, _)| f.as_str());
    if flavour_of(ROOT_ID) != Some(PAGE) {
        return Err(Violation::Hub("root"));
    }
    if flavour_of(NOTE_ID) != Some(NOTE) {
        return Err(Violation::Hub("note"));
    }
    let root_children = &tree[ROOT_ID].1;
    let notes: Vec<&String> = root_children
        .iter()
        .filter(|c| flavour_of(c) == Some(NOTE))
        .collect();
    if notes != [NOTE_ID] {
        return Err(Violation::Hub("note"));
    }

    let mut listed: HashMap<&str, usize> = HashMap::new();
    for (parent, (parent_flavour, children)) in &tree {
        for child in children {
            let Some(child_flavour) = flavour_of(child) else {
                return Err(Violation::Dangling {
                    parent: parent.clone(),
                    child: child.clone(),
                });
            };
            *listed.entry(child.as_str()).or_default() += 1;
            let allowed = schema::flavour(child_flavour)
                .is_some_and(|f| f.parents.contains(&parent_flavour.as_str()));
            if !allowed {
                return Err(Violation::Parent {
                    id: child.clone(),
                    parent: parent.clone(),
                });
            }
        }
    }
    for id in tree.keys() {
        let count = listed.get(id.as_str()).copied().unwrap_or(0);
        let expected = usize::from(id != ROOT_ID);
        if count > expected {
            return Err(Violation::TwoParents(id.clone()));
        }
    }
    let mut reached = BTreeSet::from([ROOT_ID.to_string()]);
    let mut stack = vec![ROOT_ID.to_string()];
    while let Some(id) = stack.pop() {
        for child in &tree[&id].1 {
            if reached.insert(child.clone()) {
                stack.push(child.clone());
            }
        }
    }
    if let Some(id) = tree.keys().find(|id| !reached.contains(*id)) {
        return Err(Violation::Unreachable(id.clone()));
    }
    Ok(())
}

/// A prop key's expected type, for a flavour's own props and a table's flat
/// keys (`rows.<id>.<field>`, `columns.<id>.<field>`, `cells.<row>:<col>.text`).
fn kind_of(schema: &schema::Flavour, key: &str) -> Option<Kind> {
    if let Some((_, kind)) = schema.props.iter().find(|(name, _)| *name == key) {
        return Some(*kind);
    }
    if schema.name != TABLE {
        return None;
    }
    match key.split('.').collect::<Vec<_>>().as_slice() {
        ["rows", _, "rowId" | "order" | "backgroundColor"] => Some(Kind::Str),
        ["rows", _, "header"] => Some(Kind::Bool),
        ["columns", _, "columnId" | "order" | "backgroundColor"] => Some(Kind::Str),
        ["columns", _, "width"] => Some(Kind::Num),
        ["cells", _, "text"] => Some(Kind::Text),
        _ => None,
    }
}

fn props<T: ReadTxn>(
    txn: &T,
    id: &str,
    map: &MapRef,
    schema: &schema::Flavour,
) -> Result<(), Violation> {
    for (key, value) in map.iter(txn) {
        if matches!(
            key,
            "sys:id" | "sys:flavour" | "sys:version" | "sys:children"
        ) {
            continue;
        }
        let bad = || Violation::Prop {
            id: id.into(),
            key: key.into(),
        };
        let name = key.strip_prefix("prop:").ok_or_else(bad)?;
        let kind = kind_of(schema, name).ok_or_else(bad)?;
        let fits = match (kind, &value) {
            (Kind::Text, Out::YText(text)) => {
                let fine = text.diff(txn, YChange::identity).iter().all(|diff| {
                    matches!(diff.insert, Out::Any(Any::String(_)))
                        && diff.attributes.as_ref().is_none_or(|attrs| {
                            attrs
                                .keys()
                                .all(|a| schema::TEXT_ATTRIBUTES.contains(&a.as_ref()))
                        })
                });
                if !fine {
                    return Err(Violation::Text {
                        id: id.into(),
                        key: name.into(),
                    });
                }
                true
            }
            (Kind::Str | Kind::StrOrNull | Kind::StrOrMap, Out::Any(Any::String(_))) => true,
            (Kind::Num | Kind::NumOrNull, Out::Any(Any::Number(_) | Any::BigInt(_))) => true,
            (Kind::Bool, Out::Any(Any::Bool(_))) => true,
            (Kind::StrOrNull | Kind::NumOrNull, Out::Any(Any::Null)) => true,
            (Kind::Map | Kind::StrOrMap, Out::YMap(_)) => true,
            _ => false,
        };
        if !fits {
            return Err(bad());
        }
    }
    let defaults = schema::defaults(schema.name).into_iter().map(|(k, _)| k);
    for key in defaults.chain(schema::text_props(schema.name).iter().copied()) {
        if !map.contains_key(txn, &format!("prop:{key}")) {
            return Err(Violation::MissingDefault {
                id: id.into(),
                key: key.into(),
            });
        }
    }
    Ok(())
}

/// One change [repair] made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Repair {
    /// A child id with no block, dropped from its parent.
    Dangling { parent: String, child: String },
    /// A second listing of a block, dropped (the higher client id's stays).
    Duplicate { parent: String, child: String },
    /// The root listed as a child, dropped.
    RootListed { parent: String },
    /// A listing that closed a cycle, dropped.
    Cycle { parent: String, child: String },
    /// A block no parent lists, appended to the note (the note to the root).
    Orphan { id: String },
}

/// One listing of a child: its parent and the array item that wrote it.
#[derive(Clone)]
struct Listing {
    parent: String,
    child: String,
    item: ID,
}

/// Puts the tree back in shape after concurrent moves and deletes (D3): a
/// block listed by two parents keeps the listing the higher client id wrote
/// (as a map key would), dangling ids are dropped, cycles are broken at the
/// listing the lowest client id wrote, and orphans go back under the note.
/// Deterministic in the room's state, so every replica writes the same repair.
pub fn repair(txn: &mut TransactionMut) -> Vec<Repair> {
    let Some(blocks) = txn.get_map(BLOCKS_ROOT) else {
        return Vec::new();
    };
    let mut ids: Vec<String> = blocks.keys(txn).map(str::to_string).collect();
    ids.sort();
    let listings: Vec<Listing> = ids
        .iter()
        .flat_map(|parent| listings(txn, &blocks, parent))
        .collect();

    let mut repairs = Vec::new();
    let mut drop: Vec<Listing> = Vec::new();
    let mut by_child: BTreeMap<&str, Vec<&Listing>> = BTreeMap::new();
    for listing in &listings {
        if listing.child == ROOT_ID {
            repairs.push(Repair::RootListed {
                parent: listing.parent.clone(),
            });
            drop.push(listing.clone());
        } else if yblock(txn, &blocks, &listing.child).is_none() {
            repairs.push(Repair::Dangling {
                parent: listing.parent.clone(),
                child: listing.child.clone(),
            });
            drop.push(listing.clone());
        } else {
            by_child.entry(&listing.child).or_default().push(listing);
        }
    }
    // child → its kept listing.
    let mut parent_of: BTreeMap<String, Listing> = BTreeMap::new();
    for (child, mut found) in by_child {
        found.sort_by_key(|l| (l.item.client, l.item.clock));
        let Some(kept) = found.pop() else {
            continue;
        };
        for other in found {
            repairs.push(Repair::Duplicate {
                parent: other.parent.clone(),
                child: child.into(),
            });
            drop.push(other.clone());
        }
        parent_of.insert(child.into(), kept.clone());
    }

    // Break cycles: walk up from each unreachable block in id order.
    loop {
        let reached = reachable(&parent_of);
        let mut cut = None;
        for id in &ids {
            if reached.contains(id) || !parent_of.contains_key(id) {
                continue;
            }
            let mut path: Vec<&str> = Vec::new();
            let mut at = id.as_str();
            while let Some(listing) = parent_of.get(at) {
                if let Some(start) = path.iter().position(|p| *p == at) {
                    // The cycle is path[start..]; cut its lowest listing.
                    cut = path[start..]
                        .iter()
                        .filter_map(|c| parent_of.get(*c))
                        .min_by_key(|l| (l.item.client, l.item.clock))
                        .cloned();
                    break;
                }
                path.push(at);
                at = &listing.parent;
            }
            if cut.is_some() {
                break;
            }
        }
        let Some(listing) = cut else {
            break;
        };
        repairs.push(Repair::Cycle {
            parent: listing.parent.clone(),
            child: listing.child.clone(),
        });
        parent_of.remove(&listing.child);
        drop.push(listing);
    }

    let orphans: Vec<String> = ids
        .iter()
        .filter(|id| *id != ROOT_ID && !parent_of.contains_key(*id))
        .cloned()
        .collect();

    // Writes: drops per parent from the back, then the orphans.
    let mut per_parent: BTreeMap<&str, Vec<ID>> = BTreeMap::new();
    for listing in &drop {
        per_parent
            .entry(&listing.parent)
            .or_default()
            .push(listing.item);
    }
    for (parent, items) in per_parent {
        let Some(map) = yblock(txn, &blocks, parent) else {
            continue;
        };
        let Some(array) = child_array(txn, &map) else {
            continue;
        };
        let mut indices: Vec<u32> = positions(&array)
            .into_iter()
            .filter(|(_, id)| items.contains(id))
            .map(|(index, _)| index)
            .collect();
        indices.sort_unstable();
        for index in indices.into_iter().rev() {
            array.remove(txn, index);
        }
    }
    for orphan in orphans {
        let target = if orphan == NOTE_ID { ROOT_ID } else { NOTE_ID };
        let Some(array) = yblock(txn, &blocks, target).and_then(|m| child_array(txn, &m)) else {
            continue;
        };
        array.push_back(txn, Any::from(orphan.as_str()));
        repairs.push(Repair::Orphan { id: orphan });
    }
    repairs
}

/// Blocks reachable from the root through `parent_of`.
fn reachable(parent_of: &BTreeMap<String, Listing>) -> BTreeSet<String> {
    let mut children: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for (child, listing) in parent_of {
        children.entry(&listing.parent).or_default().push(child);
    }
    let mut reached = BTreeSet::from([ROOT_ID.to_string()]);
    let mut stack = vec![ROOT_ID];
    while let Some(id) = stack.pop() {
        for child in children.get(id).into_iter().flatten() {
            if reached.insert((*child).to_string()) {
                stack.push(child);
            }
        }
    }
    reached
}

/// The live elements of a children array: their index and item id.
fn positions(array: &yrs::ArrayRef) -> Vec<(u32, ID)> {
    let branch: &yrs::branch::Branch = array.as_ref();
    let mut out = Vec::new();
    let mut index = 0u32;
    let mut next = branch.start();
    while let Some(item) = next {
        next = item.right();
        if item.is_deleted() {
            continue;
        }
        if let ItemContent::Any(values) = item.content() {
            for k in 0..values.len() as u32 {
                out.push((index, ID::new(item.id().client, item.id().clock + k)));
                index += 1;
            }
        }
    }
    out
}

/// Every listing in `parent`'s children array.
fn listings<T: ReadTxn>(txn: &T, blocks: &MapRef, parent: &str) -> Vec<Listing> {
    let Some(map) = yblock(txn, blocks, parent) else {
        return Vec::new();
    };
    let Some(array) = child_array(txn, &map) else {
        return Vec::new();
    };
    let ids: Vec<Option<String>> = array
        .iter(txn)
        .map(|v| match v {
            Out::Any(Any::String(s)) => Some(s.to_string()),
            _ => None,
        })
        .collect();
    positions(&array)
        .into_iter()
        .filter_map(|(index, item)| {
            Some(Listing {
                parent: parent.into(),
                child: ids.get(index as usize)?.clone()?,
                item,
            })
        })
        .collect()
}
