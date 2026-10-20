//! What one key may hold at once (Epo 2026-10-19, per-tenant fairness):
//! sockets per client address (`http.rs`), refused past the cap, and joined
//! channels per user and per user and document (`socket.rs`), where a join
//! past the cap closes the key's oldest joined channel instead. A [Seat] or
//! [Membership] is held while its socket or channel lives and gives its
//! place back when dropped.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use tokio::sync::mpsc;

/// Sockets one client address may hold open (`COLLABORATION_SOCKETS_PER_ADDRESS`).
pub const SOCKETS_PER_ADDRESS: u64 = 500;
/// Documents one user may have joined at once over all their sockets, about
/// 7 per device on 3 devices (Epo 2026-10-19, `COLLABORATION_JOINED_PER_USER`).
pub const JOINED_PER_USER: u64 = 22;
/// Channels one user may have joined to any one document or embed at once
/// over all their sockets (Epo 2026-10-20,
/// `COLLABORATION_CONNECTIONS_PER_DOCUMENT`).
pub const CONNECTIONS_PER_DOCUMENT: u64 = 4;
/// Membership ids, unique over every [Joined], so a channel's places in two
/// of them are told apart.
static NEXT_MEMBERSHIP: AtomicU64 = AtomicU64::new(1);

type Held = Arc<Mutex<HashMap<String, u64>>>;

/// Up to `cap` seats per key.
#[derive(Debug)]
pub struct Seats {
    cap: u64,
    held: Held,
}

/// One place of a key, given back on drop.
#[derive(Debug)]
pub struct Seat {
    key: String,
    held: Held,
}

impl Seats {
    pub fn new(cap: u64) -> Self {
        Seats {
            cap,
            held: Held::default(),
        }
    }

    /// A seat for `key`, unless it holds `cap` already.
    pub fn take(&self, key: &str) -> Option<Seat> {
        let mut held = self.held.lock().unwrap_or_else(PoisonError::into_inner);
        let count = held.entry(key.to_owned()).or_default();
        if *count >= self.cap {
            return None;
        }
        *count += 1;
        Some(Seat {
            key: key.to_owned(),
            held: self.held.clone(),
        })
    }
}

impl Drop for Seat {
    fn drop(&mut self) {
        let mut held = self.held.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(count) = held.get_mut(&self.key) {
            *count -= 1;
            if *count == 0 {
                held.remove(&self.key);
            }
        }
    }
}

/// What a socket hears when one of its channels is a user's oldest past the
/// cap: the channel and its membership's id (a channel joined again since
/// has another).
pub type Closing = (u64, u64);

#[derive(Debug)]
struct Joiner {
    id: u64,
    channel: u64,
    socket: mpsc::UnboundedSender<Closing>,
}

#[derive(Debug, Default)]
struct Users {
    by_user: HashMap<String, VecDeque<Joiner>>,
}

/// Each key's joined channels (a user's, or a user's in one document),
/// oldest first, up to `cap`.
#[derive(Debug)]
pub struct Joined {
    cap: usize,
    users: Arc<Mutex<Users>>,
}

/// A joined channel's place among its user's, given back on drop.
#[derive(Debug)]
pub struct Membership {
    pub id: u64,
    user: String,
    users: Arc<Mutex<Users>>,
}

impl Joined {
    pub fn new(cap: u64) -> Self {
        Joined {
            cap: usize::try_from(cap).unwrap_or(usize::MAX),
            users: Arc::default(),
        }
    }

    /// `user` joined `channel` on the socket that hears `socket`: past the
    /// cap their oldest joined channel's socket hears that it closes.
    pub fn join(
        &self,
        user: &str,
        channel: u64,
        socket: &mpsc::UnboundedSender<Closing>,
    ) -> Membership {
        let mut users = self.users.lock().unwrap_or_else(PoisonError::into_inner);
        let id = NEXT_MEMBERSHIP.fetch_add(1, Ordering::Relaxed);
        let joined = users.by_user.entry(user.to_owned()).or_default();
        joined.push_back(Joiner {
            id,
            channel,
            socket: socket.clone(),
        });
        while joined.len() > self.cap {
            if let Some(oldest) = joined.pop_front() {
                let _ = oldest.socket.send((oldest.channel, oldest.id));
            }
        }
        Membership {
            id,
            user: user.to_owned(),
            users: self.users.clone(),
        }
    }
}

impl Drop for Membership {
    fn drop(&mut self) {
        let mut users = self.users.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(joined) = users.by_user.get_mut(&self.user) {
            joined.retain(|joiner| joiner.id != self.id);
            if joined.is_empty() {
                users.by_user.remove(&self.user);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_holds_up_to_its_cap_and_a_dropped_seat_frees_one() {
        let seats = Seats::new(2);
        let first = seats.take("a").expect("a first seat");
        let _second = seats.take("a").expect("a second seat");
        assert!(seats.take("a").is_none());
        assert!(seats.take("b").is_some());
        drop(first);
        assert!(seats.take("a").is_some());
    }

    #[test]
    fn a_join_past_the_cap_closes_the_users_oldest_channel() {
        let joined = Joined::new(2);
        let (socket, mut heard) = mpsc::unbounded_channel();
        let first = joined.join("a", 1, &socket);
        let second = joined.join("a", 2, &socket);
        let _other = joined.join("b", 9, &socket);
        assert!(heard.try_recv().is_err());
        let _third = joined.join("a", 3, &socket);
        assert_eq!(heard.try_recv().ok(), Some((1, first.id)));
        // A channel that left gives its place back.
        drop(second);
        let _fourth = joined.join("a", 4, &socket);
        assert!(heard.try_recv().is_err());
    }
}
