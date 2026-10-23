//! Stable left: the unsent edits placed onto the current document.
//!
//! A new list unit goes to the gap of its origin chain's root, the nearest
//! unit on its left that the room had: right after it when the current
//! document holds it, else right after the nearest held unit left of it (the
//! view's redirect). Inside a gap the new units keep the sender's order (its
//! own-left map). Each live new run is then anchored to its nearest
//! neighbours of lower rank, so it lands exactly. A map value keeps a held
//! origin; one the current document dropped moves to the key's current value.

use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet, BinaryHeap, HashMap, HashSet, VecDeque};
use std::ops::Range;
use std::sync::Arc;

use yrs::block::{ClientID, Item, ItemContent, UpdateParent};
use yrs::branch::BranchID;
use yrs::updates::decoder::Decode;
use yrs::{Doc, ID, IdSet, ReadTxn, Transact, Update, UpdateBlock};

use crate::write::{self, ContentRef, Out};
use crate::{Merged, Own, ParentRef, Refused, View, parent_ref};

#[derive(Clone, PartialEq, Eq, Hash, Debug)]
enum Anchor {
    Start,
    After(ID),
}

#[derive(Clone, Debug)]
enum Res {
    List {
        list: ParentRef,
        anchor: Anchor,
    },
    Map {
        origin: Option<ID>,
        parent: Option<ParentRef>,
        key: Option<Arc<str>>,
    },
    Drop,
}

/// A run of one update struct's units that is contiguous in the sender's
/// document order (a merged update may hold a struct whose units another
/// struct splits, as "XZ" with Y typed between later).
#[derive(Clone, Copy)]
struct Piece<'a> {
    item: &'a Item,
    start: u32,
    end: u32,
}

impl Piece<'_> {
    fn id(&self) -> ID {
        ID::new(self.item.id().client, self.item.id().clock + self.start)
    }
    fn len(&self) -> u32 {
        self.end - self.start + 1
    }
    fn origin(&self) -> Option<ID> {
        if self.start == 0 {
            self.item.origin().copied()
        } else {
            Some(ID::new(
                self.item.id().client,
                self.item.id().clock + self.start - 1,
            ))
        }
    }
}

/// A delete set's ranges per client, sorted and joined.
struct Ranges(HashMap<ClientID, Vec<Range<u32>>>);

impl Ranges {
    fn of(set: &IdSet) -> Ranges {
        let mut out: HashMap<ClientID, Vec<Range<u32>>> = HashMap::new();
        for (client, ranges) in set.iter() {
            out.entry(*client)
                .or_default()
                .extend(ranges.iter().cloned());
        }
        for v in out.values_mut() {
            v.sort_by_key(|r| r.start);
            let mut joined: Vec<Range<u32>> = Vec::with_capacity(v.len());
            for r in v.drain(..) {
                match joined.last_mut() {
                    Some(last) if r.start <= last.end => last.end = last.end.max(r.end),
                    _ => joined.push(r),
                }
            }
            *v = joined;
        }
        Ranges(out)
    }

    /// The parts of `clocks` of `client` the set holds, in order.
    fn within(
        &self,
        client: &ClientID,
        clocks: Range<u32>,
    ) -> impl Iterator<Item = Range<u32>> + '_ {
        let v = self.0.get(client).map(Vec::as_slice).unwrap_or(&[]);
        let first = v.partition_point(|r| r.end <= clocks.start);
        v[first..]
            .iter()
            .take_while(move |r| r.start < clocks.end)
            .map(move |r| r.start.max(clocks.start)..r.end.min(clocks.end))
    }

    fn count(&self, client: &ClientID, clocks: Range<u32>) -> u32 {
        self.within(client, clocks).map(|r| r.end - r.start).sum()
    }
}

pub fn stable_left(
    update: &[u8],
    current: &Doc,
    view: &View,
    own: &Own,
    author: Option<ClientID>,
) -> Result<Merged, Refused> {
    let txn = current.transact();
    let store = txn.store();
    let held = txn.state_vector();
    // Each client's first unit the room lacked.
    let new_from = |c: &ClientID| held.get(c);
    let kept = |id: &ID| id.clock < held.get(&id.client) && !view.is_removed(id);
    let decoded = Update::decode_v1(update).map_err(|error| Refused::Decode(error.to_string()))?;
    let ds = decoded.delete_set();
    let deleted = Ranges::of(ds);

    // The update's new structs, cut where the sender's order breaks a run.
    let mut news: Vec<Piece> = Vec::new();
    for block in decoded.blocks() {
        if let UpdateBlock::Item(item) = block {
            let (c, k, n) = (item.id().client, item.id().clock, item.len());
            let from = new_from(&c);
            if k + n <= from {
                continue;
            }
            if k < from {
                return Err(Refused::Unheld);
            }
            let mut start = 0;
            for cut in own.breaks(c, k + 1..k + n) {
                news.push(Piece {
                    item,
                    start,
                    end: cut - k - 1,
                });
                start = cut - k;
            }
            news.push(Piece {
                item,
                start,
                end: n - 1,
            });
        }
    }
    let mut index: HashMap<ClientID, Vec<(u32, u32, usize)>> = HashMap::new();
    for (i, p) in news.iter().enumerate() {
        index
            .entry(p.id().client)
            .or_default()
            .push((p.id().clock, p.len(), i));
    }
    for v in index.values_mut() {
        v.sort_unstable();
    }
    let struct_of = |id: &ID| -> Option<usize> {
        let v = index.get(&id.client)?;
        let p = v.partition_point(|&(k, _, _)| k <= id.clock);
        if p == 0 {
            return None;
        }
        let (k, n, i) = v[p - 1];
        (id.clock < k + n).then_some(i)
    };
    // A unit the room lacked that the update carries as GC: Yjs drops items
    // next to it.
    let new_gc = |id: &ID| id.clock >= new_from(&id.client) && struct_of(id).is_none();

    // A piece's units the tab still shows.
    let shown = |p: &Piece| {
        if matches!(p.item.content(), ItemContent::Deleted(_)) {
            0
        } else {
            let at = p.id().clock;
            p.len() - deleted.count(&p.id().client, at..at + p.len())
        }
    };
    let dead: Vec<bool> = news.iter().map(|p| shown(p) == 0).collect();
    // Every piece names its origins and its explicit parent; it is resolved
    // once the new pieces among them are (a worklist, not passes).
    let explicit_of = |piece: &Piece| -> Option<ParentRef> {
        if piece.start > 0 {
            return None;
        }
        match piece.item.update_parent() {
            UpdateParent::Root(n) => Some(ParentRef::Root(n.clone())),
            UpdateParent::Item(p) => Some(ParentRef::Item(*p)),
            _ => None,
        }
    };
    let mut waiting: Vec<usize> = vec![0; news.len()];
    let mut users: Vec<Vec<usize>> = vec![Vec::new(); news.len()];
    for (i, piece) in news.iter().enumerate() {
        let mut on: Vec<usize> = [piece.origin(), piece.item.right_origin().copied()]
            .into_iter()
            .flatten()
            .chain(match explicit_of(piece) {
                Some(ParentRef::Item(p)) => Some(p),
                _ => None,
            })
            .filter_map(|id| struct_of(&id))
            .filter(|&d| d != i)
            .collect();
        on.sort_unstable();
        on.dedup();
        waiting[i] = on.len();
        for d in on {
            users[d].push(i);
        }
    }
    let mut ready: VecDeque<usize> = (0..news.len()).filter(|&i| waiting[i] == 0).collect();
    let mut res: Vec<Option<Res>> = vec![None; news.len()];
    while let Some(i) = ready.pop_front() {
        {
            let piece = news[i];
            let it = piece.item;
            let explicit = explicit_of(&piece);
            let origin = piece.origin();
            let right = it.right_origin().copied();
            let refs: Vec<ID> = [origin, right]
                .into_iter()
                .flatten()
                .chain(match &explicit {
                    Some(ParentRef::Item(p)) => Some(*p),
                    _ => None,
                })
                .collect();
            let of = |id: &ID| struct_of(id).and_then(|d| res[d].clone());
            let dropped = |id: &ID| new_gc(id) || matches!(of(id), Some(Res::Drop));
            let resolved = (|| -> Result<Res, Refused> {
                if refs.iter().any(&dropped) {
                    return Ok(Res::Drop);
                }
                if let Some(ParentRef::Item(p)) = &explicit
                    && view.is_removed(p)
                {
                    return Ok(Res::Drop);
                }
                if let Some(q) = right
                    && view.is_removed(&q)
                    && view.redirect(&q).is_none()
                {
                    return Ok(Res::Drop);
                }
                let is_map = it.parent_sub().is_some()
                    || match origin {
                        Some(o) if struct_of(&o).is_some() => {
                            matches!(of(&o), Some(Res::Map { .. }))
                        }
                        Some(o) if kept(&o) => {
                            store.get_item(&o).is_some_and(|x| x.parent_sub().is_some())
                        }
                        Some(o) if view.is_removed(&o) => {
                            view.redirect(&o).is_some_and(|r| r.key.is_some())
                        }
                        _ => false,
                    };
                if is_map {
                    return Ok(match origin {
                        None => Res::Map {
                            origin: None,
                            parent: explicit.clone(),
                            key: it.parent_sub().cloned(),
                        },
                        // A dead new value becomes GC: take its own placed origin.
                        Some(o) if struct_of(&o).is_some_and(|d| dead[d]) => match of(&o) {
                            Some(m @ Res::Map { .. }) => m,
                            _ => Res::Drop,
                        },
                        Some(o) if struct_of(&o).is_some() || kept(&o) => Res::Map {
                            origin: Some(o),
                            parent: None,
                            key: None,
                        },
                        Some(o) if view.is_removed(&o) => match view.redirect(&o) {
                            Some(r) => Res::Map {
                                origin: r.left,
                                parent: Some(r.parent.clone()),
                                key: r.key.clone(),
                            },
                            None => Res::Drop,
                        },
                        Some(_) => return Err(Refused::Unheld),
                    });
                }
                let (list, anchor) = match origin {
                    Some(o) if struct_of(&o).is_some() => match of(&o) {
                        Some(Res::List { list, anchor }) => (list, anchor),
                        _ => return Ok(Res::Drop),
                    },
                    Some(o) if kept(&o) => {
                        let item = store.get_item(&o).ok_or(Refused::Unheld)?;
                        let branch = item.parent_branch().ok_or(Refused::Unheld)?;
                        (parent_ref(branch), Anchor::After(o))
                    }
                    Some(o) if view.is_removed(&o) => match view.redirect(&o) {
                        Some(r) => (
                            r.parent.clone(),
                            r.left.map(Anchor::After).unwrap_or(Anchor::Start),
                        ),
                        None => return Ok(Res::Drop),
                    },
                    Some(_) => return Err(Refused::Unheld),
                    None => {
                        let list = match (explicit.clone(), right) {
                            (Some(p), _) => p,
                            (None, Some(q)) if struct_of(&q).is_some() => match of(&q) {
                                Some(Res::List { list, .. }) => list,
                                _ => return Ok(Res::Drop),
                            },
                            (None, Some(q)) if kept(&q) => {
                                let item = store.get_item(&q).ok_or(Refused::Unheld)?;
                                parent_ref(item.parent_branch().ok_or(Refused::Unheld)?)
                            }
                            (None, Some(q)) if view.is_removed(&q) => match view.redirect(&q) {
                                Some(r) => r.parent.clone(),
                                None => return Ok(Res::Drop),
                            },
                            _ => return Err(Refused::Unheld),
                        };
                        (list, Anchor::Start)
                    }
                };
                Ok(Res::List { list, anchor })
            })()?;
            res[i] = Some(resolved);
        }
        for &u in &users[i] {
            waiting[u] -= 1;
            if waiting[u] == 0 {
                ready.push_back(u);
            }
        }
    }
    // A piece left over names itself through others.
    if res.iter().any(Option::is_none) {
        return Err(Refused::Unheld);
    }
    let res: Vec<Res> = res.into_iter().flatten().collect();
    let live = |i: usize| !dead[i] && !matches!(res[i], Res::Drop);

    // Typing's rule for merged runs: a gap after a tombstone moves to the end
    // of its deleted run. A run landing inside a deleted run would turn its
    // interior into edges on tabs that still hold units the room discarded,
    // and their next insert would name one.
    let snap = |a: &Anchor| -> Anchor {
        let Anchor::After(u) = a else {
            return a.clone();
        };
        let Some(mut item) = store.get_item(u) else {
            return a.clone();
        };
        if !item.is_deleted() {
            return a.clone();
        }
        let mut last = item.last_id();
        while let Some(r) = item.right() {
            if !r.is_deleted() {
                break;
            }
            last = r.last_id();
            item = r;
        }
        Anchor::After(last)
    };
    let mut groups: HashMap<(ParentRef, Anchor), Vec<usize>> = HashMap::new();
    for i in 0..news.len() {
        if let (true, Res::List { list, anchor }) = (live(i), &res[i]) {
            if own.order(&news[i].id()).is_none() {
                return Err(Refused::Shape("the own order lacks a unit"));
            }
            groups
                .entry((list.clone(), snap(anchor)))
                .or_default()
                .push(i);
        }
    }
    for g in groups.values_mut() {
        g.sort_by_key(|&i| own.order(&news[i].id()));
    }

    // Rank the live new pieces: same-client clock order, a new parent first.
    let live_ix: Vec<usize> = (0..news.len()).filter(|&i| live(i)).collect();
    let mut indegree: HashMap<usize, u32> = live_ix.iter().map(|&i| (i, 0)).collect();
    let mut next_same: HashMap<usize, usize> = HashMap::new();
    let mut children: HashMap<usize, Vec<usize>> = HashMap::new();
    let mut by_client: BTreeMap<ClientID, Vec<usize>> = BTreeMap::new();
    for &i in &live_ix {
        by_client.entry(news[i].id().client).or_default().push(i);
    }
    for v in by_client.values_mut() {
        v.sort_by_key(|&i| news[i].id().clock);
        for pair in v.windows(2) {
            next_same.insert(pair[0], pair[1]);
            *indegree.entry(pair[1]).or_default() += 1;
        }
    }
    for &i in &live_ix {
        let parent = match &res[i] {
            Res::List {
                list: ParentRef::Item(p),
                ..
            } => Some(*p),
            Res::Map {
                parent: Some(ParentRef::Item(p)),
                ..
            } => Some(*p),
            _ => None,
        };
        if let Some(p) = parent.and_then(|p| struct_of(&p))
            && live(p)
        {
            children.entry(p).or_default().push(i);
            *indegree.entry(i).or_default() += 1;
        }
    }
    let key_of = |i: usize| Reverse((news[i].id().clock, news[i].id().client.get(), i));
    let mut heap: BinaryHeap<Reverse<(u32, u64, usize)>> = indegree
        .iter()
        .filter(|(_, d)| **d == 0)
        .map(|(&i, _)| key_of(i))
        .collect();
    let mut rank: HashMap<usize, usize> = HashMap::new();
    while let Some(Reverse((_, _, i))) = heap.pop() {
        rank.insert(i, rank.len());
        let mut release = |n: usize, heap: &mut BinaryHeap<Reverse<(u32, u64, usize)>>| {
            let d = indegree.entry(n).or_default();
            *d -= 1;
            if *d == 0 {
                heap.push(key_of(n));
            }
        };
        if let Some(n) = next_same.get(&i).copied() {
            release(n, &mut heap);
        }
        if let Some(kids) = children.get(&i).cloned() {
            for k in kids {
                release(k, &mut heap);
            }
        }
    }
    if rank.len() != live_ix.len() {
        return Err(Refused::Shape("the new structs form a cycle"));
    }

    // Origins per list, over the held units and the groups.
    let mut origin_of: HashMap<usize, ID> = HashMap::new();
    let mut right_of: HashMap<usize, ID> = HashMap::new();
    let mut lists: Vec<ParentRef> = groups.keys().map(|(l, _)| l.clone()).collect();
    lists.sort_by_key(|l| format!("{l:?}"));
    lists.dedup();
    let mut placed_groups = 0usize;
    for list in lists {
        let anchors: BTreeSet<(u64, u32)> = groups
            .keys()
            .filter(|(l, _)| *l == list)
            .filter_map(|(_, a)| match a {
                Anchor::After(u) => Some((u.client.get(), u.clock)),
                Anchor::Start => None,
            })
            .collect();
        // (first unit, last unit, Some(piece) for a new piece)
        let mut marks: Vec<(ID, ID, Option<usize>)> = Vec::new();
        let mut push_group = |a: Anchor, marks: &mut Vec<(ID, ID, Option<usize>)>| {
            if let Some(g) = groups.get(&(list.clone(), a)) {
                placed_groups += 1;
                for &i in g {
                    let id = news[i].id();
                    marks.push((
                        id,
                        ID::new(id.client, id.clock + news[i].len() - 1),
                        Some(i),
                    ));
                }
            }
        };
        push_group(Anchor::Start, &mut marks);
        let branch = match &list {
            ParentRef::Root(n) => BranchID::get_root(&txn, n.as_ref()),
            ParentRef::Item(id) if struct_of(id).is_none() => BranchID::get_nested(&txn, id),
            ParentRef::Item(_) => None,
        };
        if let Some(b) = branch {
            let mut next = b.start();
            while let Some(item) = next {
                next = item.right();
                // Tombstones count: a placed run sits between units adjacent
                // in the document it lands in, and after a collection an
                // anchor may be a tombstone.
                let (c, k, n) = (item.id().client, item.id().clock, item.len());
                let mut start = k;
                let hits: Vec<u32> = anchors
                    .range((c.get(), k)..(c.get(), k + n))
                    .map(|&(_, clock)| clock)
                    .collect();
                for clock in hits {
                    let u = ID::new(c, clock);
                    marks.push((ID::new(c, start), u, None));
                    push_group(Anchor::After(u), &mut marks);
                    start = clock + 1;
                }
                if start < k + n {
                    marks.push((ID::new(c, start), ID::new(c, k + n - 1), None));
                }
            }
        }
        let mut placed: BTreeSet<usize> =
            (0..marks.len()).filter(|&m| marks[m].2.is_none()).collect();
        let mut order: Vec<(usize, usize)> = marks
            .iter()
            .enumerate()
            .filter_map(|(m, mark)| mark.2.map(|i| (m, i)))
            .collect();
        order.sort_by_key(|&(_, i)| rank.get(&i).copied());
        for (m, i) in order {
            if let Some(&p) = placed.range(..m).next_back() {
                origin_of.insert(i, marks[p].1);
            }
            if let Some(&q) = placed.range(m + 1..).next() {
                right_of.insert(i, marks[q].0);
            }
            placed.insert(m);
        }
    }
    if placed_groups != groups.len() {
        return Err(Refused::Shape("an anchor is missing from its list"));
    }

    // The tab's deletions of held units the room did not collect.
    let mut deletes = IdSet::new();
    for (client, ranges) in &deleted.0 {
        for r in ranges {
            let to = r.end.min(new_from(client));
            if r.start < to {
                deletes.insert(ID::new(*client, r.start), to - r.start);
            }
        }
    }
    deletes.diff_with(&view.removed);
    // What the tab shows that no update holds: pieces dropped for a block the
    // current document lacks.
    let mut dropped: u32 = 0;
    for (i, piece) in news.iter().enumerate() {
        if !dead[i] && matches!(res[i], Res::Drop) {
            dropped = dropped.saturating_add(shown(piece));
        }
    }

    if let Some(author) = author {
        return reauthored(Placed {
            author,
            from: held.get(&author),
            news: &news,
            res: &res,
            live: &live,
            shown: &shown,
            rank: &rank,
            origin_of: &origin_of,
            right_of: &right_of,
            struct_of: &struct_of,
            deletes,
            dropped,
        });
    }

    // Write, client by client over the update's new ranges.
    let mut sections: BTreeMap<ClientID, (u32, Vec<Out>)> = BTreeMap::new();
    let emit = |client: ClientID,
                out: Out,
                len: u32,
                sections: &mut BTreeMap<ClientID, (u32, Vec<Out>)>| {
        let section = sections
            .entry(client)
            .or_insert_with(|| (new_from(&client), Vec::new()));
        match out {
            Out::Gc(_) => write::push_gc(&mut section.1, len),
            item => section.1.push(item),
        }
    };
    for block in decoded.blocks() {
        let (client, clock, len) = match &block {
            UpdateBlock::Item(item) => (item.id().client, item.id().clock, item.len()),
            UpdateBlock::Gc(r) | UpdateBlock::Skip(r) => (r.client, r.clock, r.len),
        };
        if clock + len <= new_from(&client) {
            continue;
        }
        if !matches!(block, UpdateBlock::Item(_)) {
            emit(client, Out::Gc(len), len, &mut sections);
            continue;
        }
        // The struct's pieces, in clock order.
        let mut i = struct_of(&ID::new(client, clock)).ok_or(Refused::Unheld)?;
        loop {
            let p = news[i];
            if live(i) {
                let (origin, right, parent, key) = match &res[i] {
                    Res::List { list, .. } => (
                        origin_of.get(&i).copied(),
                        right_of.get(&i).copied(),
                        Some(list.clone()),
                        None,
                    ),
                    Res::Map {
                        origin,
                        parent,
                        key,
                    } => (*origin, None, parent.clone(), key.clone()),
                    Res::Drop => (None, None, None, None),
                };
                let content = if p.start == 0 && p.end + 1 == p.item.len() {
                    ContentRef::Owned(p.item.content().clone())
                } else {
                    ContentRef::Slice(p.item.content().clone(), p.start, p.end)
                };
                let out = Out::Item {
                    origin,
                    right,
                    parent,
                    key,
                    content,
                };
                emit(client, out, p.len(), &mut sections);
            } else {
                emit(client, Out::Gc(p.len()), p.len(), &mut sections);
            }
            if p.end + 1 == p.item.len() {
                break;
            }
            i = struct_of(&ID::new(client, p.id().clock + p.len())).ok_or(Refused::Unheld)?;
        }
    }
    // And its deletions of its own written units.
    for (client, pieces) in &index {
        for &(start, len, i) in pieces {
            if live(i) {
                for r in deleted.within(client, start..start + len) {
                    deletes.insert(ID::new(*client, r.start), r.end - r.start);
                }
            }
        }
    }
    Ok(Merged {
        update: write::update(sections, &deletes)?,
        dropped,
    })
}

/// What `stable_left` worked out, for writing it under a new client id.
struct Placed<'a, 'p> {
    author: ClientID,
    /// The first clock the current document lacks for `author`.
    from: u32,
    news: &'a [Piece<'p>],
    res: &'a [Res],
    live: &'a dyn Fn(usize) -> bool,
    shown: &'a dyn Fn(&Piece) -> u32,
    rank: &'a HashMap<usize, usize>,
    origin_of: &'a HashMap<usize, ID>,
    right_of: &'a HashMap<usize, ID>,
    struct_of: &'a dyn Fn(&ID) -> Option<usize>,
    /// The tab's deletions of held units (no new unit needs one: loading the
    /// old document split its items at every deletion, so a new unit it
    /// deleted is in a dead piece, which is not written).
    deletes: IdSet,
    /// What the placement dropped already.
    dropped: u32,
}

/// The placed live pieces as new units of `author`, each after every new
/// piece it names (its origins, its parent, a map value's origin). A piece
/// naming one that is not written (deleted in the tab, or dropped) is not
/// written either, and what of it the tab shows counts as dropped.
fn reauthored(p: Placed) -> Result<Merged, Refused> {
    let named = |i: usize| -> Vec<ID> {
        let mut ids: Vec<ID> = Vec::new();
        ids.extend(p.origin_of.get(&i));
        ids.extend(p.right_of.get(&i));
        match &p.res[i] {
            Res::List {
                list: ParentRef::Item(parent),
                ..
            } => ids.push(*parent),
            Res::Map { origin, parent, .. } => {
                ids.extend(origin);
                if let Some(ParentRef::Item(parent)) = parent {
                    ids.push(*parent);
                }
            }
            _ => {}
        }
        ids
    };
    let live_ix: Vec<usize> = (0..p.news.len()).filter(|&i| (p.live)(i)).collect();
    let mut deps: HashMap<usize, Vec<usize>> = HashMap::new();
    let mut users: HashMap<usize, Vec<usize>> = HashMap::new();
    let mut unwritten: HashSet<usize> = HashSet::new();
    for &i in &live_ix {
        let mut on: Vec<usize> = named(i)
            .iter()
            .filter_map(|id| (p.struct_of)(id))
            .filter(|&d| d != i)
            .collect();
        on.sort_unstable();
        on.dedup();
        if on.iter().any(|&d| !(p.live)(d)) {
            unwritten.insert(i);
        }
        on.retain(|&d| (p.live)(d));
        for &d in &on {
            users.entry(d).or_default().push(i);
        }
        deps.insert(i, on);
    }
    let mut waiting: HashMap<usize, usize> = deps.iter().map(|(&i, on)| (i, on.len())).collect();
    let mut ready: BinaryHeap<Reverse<(usize, usize)>> = waiting
        .iter()
        .filter(|(_, n)| **n == 0)
        .map(|(&i, _)| Reverse((p.rank[&i], i)))
        .collect();
    // Each written piece's first new clock.
    let mut at: HashMap<usize, u32> = HashMap::new();
    let mut order: Vec<usize> = Vec::new();
    let mut next = p.from;
    let mut seen = 0usize;
    let mut dropped = p.dropped;
    while let Some(Reverse((_, i))) = ready.pop() {
        seen += 1;
        if unwritten.contains(&i) || deps[&i].iter().any(|d| unwritten.contains(d)) {
            unwritten.insert(i);
            dropped = dropped.saturating_add((p.shown)(&p.news[i]));
        } else {
            at.insert(i, next);
            next += p.news[i].len();
            order.push(i);
        }
        for &u in users.get(&i).into_iter().flatten() {
            let n = waiting.entry(u).or_default();
            *n -= 1;
            if *n == 0 {
                ready.push(Reverse((p.rank[&u], u)));
            }
        }
    }
    if seen != live_ix.len() {
        return Err(Refused::Shape("the new structs form a cycle"));
    }
    // A unit of a written piece under its new id; a held unit as it is.
    let new_id = |id: ID| -> Result<ID, Refused> {
        match (p.struct_of)(&id) {
            None => Ok(id),
            Some(d) => at
                .get(&d)
                .map(|&start| ID::new(p.author, start + id.clock - p.news[d].id().clock))
                .ok_or(Refused::Shape("a written struct names one not written")),
        }
    };
    let new_parent = |parent: &Option<ParentRef>| -> Result<Option<ParentRef>, Refused> {
        Ok(match parent {
            Some(ParentRef::Item(id)) => Some(ParentRef::Item(new_id(*id)?)),
            other => other.clone(),
        })
    };
    let mut structs: Vec<Out> = Vec::new();
    for &i in &order {
        let piece = p.news[i];
        let (origin, right, parent, key) = match &p.res[i] {
            Res::List { list, .. } => (
                p.origin_of.get(&i).copied(),
                p.right_of.get(&i).copied(),
                Some(list.clone()),
                None,
            ),
            Res::Map {
                origin,
                parent,
                key,
            } => (*origin, None, parent.clone(), key.clone()),
            Res::Drop => continue,
        };
        let content = if piece.start == 0 && piece.end + 1 == piece.item.len() {
            ContentRef::Owned(piece.item.content().clone())
        } else {
            ContentRef::Slice(piece.item.content().clone(), piece.start, piece.end)
        };
        structs.push(Out::Item {
            origin: origin.map(new_id).transpose()?,
            right: right.map(new_id).transpose()?,
            parent: new_parent(&parent)?,
            key,
            content,
        });
    }
    let mut sections = BTreeMap::new();
    sections.insert(p.author, (p.from, structs));
    Ok(Merged {
        update: write::update(sections, &p.deletes)?,
        dropped,
    })
}
