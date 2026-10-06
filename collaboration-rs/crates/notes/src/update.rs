//! A decoded update's new items and deletes, indexed once for the checks
//! that read them against the room: items per client in clock order (binary
//! search by id), deleted ranges per client sorted and merged (one range
//! holds any span the update deletes whole).

use std::collections::HashMap;

use yrs::block::{ClientID, Item};
use yrs::{ID, Update, UpdateBlock};

pub struct Incoming<'a> {
    items: HashMap<ClientID, Vec<&'a Item>>,
    deletes: HashMap<ClientID, Vec<(u32, u32)>>,
}

impl<'a> Incoming<'a> {
    pub fn new(update: &'a Update) -> Self {
        let mut items: HashMap<ClientID, Vec<&Item>> = HashMap::new();
        for block in update.blocks() {
            if let UpdateBlock::Item(item) = block {
                items.entry(item.id().client).or_default().push(item);
            }
        }
        let mut deletes = HashMap::new();
        for (client, range) in update.delete_set().iter() {
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
        Incoming { items, deletes }
    }

    /// The new item holding `id`, if the update has one.
    pub fn item_at(&self, id: &ID) -> Option<&'a Item> {
        let items = self.items.get(&id.client)?;
        let index = items.partition_point(|item| item.id().clock + item.len() <= id.clock);
        items
            .get(index)
            .copied()
            .filter(|item| item.id().clock <= id.clock)
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

    pub fn items(&self) -> impl Iterator<Item = &'a Item> + '_ {
        self.items.values().flatten().copied()
    }

    pub fn delete_ranges(&self) -> impl Iterator<Item = (&ClientID, &[(u32, u32)])> {
        self.deletes
            .iter()
            .map(|(client, ranges)| (client, ranges.as_slice()))
    }
}
