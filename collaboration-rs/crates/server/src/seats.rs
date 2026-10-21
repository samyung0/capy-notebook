//! What one key may hold at once (Epo 2026-10-19, per-tenant fairness):
//! sockets per client address (`http.rs`), refused past the cap, and joined
//! channels per user and per user and document (`socket.rs`), where a join
//! past the cap closes the key's oldest joined channel instead. A [Seat] or
//! [Membership] is held while its socket or channel lives and gives its
//! place back when dropped. A socket whose sends move no bytes for the
//! silent window closes, giving its places back ([Sent], [watched]).

use std::collections::{HashMap, VecDeque};
use std::io;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::task::{Context, Poll};
use std::time::Duration;

use axum::extract::connect_info::Connected;
use axum::serve::{IncomingStream, Listener};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio::time::Instant;

/// Sockets one client address may hold open (`COLLABORATION_SOCKETS_PER_ADDRESS`).
pub const SOCKETS_PER_ADDRESS: u64 = 500;
/// Documents one user may have joined at once over all their sockets, about
/// 7 per device on 3 devices (Epo 2026-10-19, `COLLABORATION_JOINED_PER_USER`).
pub const JOINED_PER_USER: u64 = 22;
/// Channels one user may have joined to any one document or embed at once
/// over all their sockets (Epo 2026-10-20,
/// `COLLABORATION_CONNECTIONS_PER_DOCUMENT`).
pub const CONNECTIONS_PER_DOCUMENT: u64 = 4;
/// Membership ids: a channel's places in every [Joined] share one.
static NEXT_MEMBERSHIP: AtomicU64 = AtomicU64::new(1);

/// A new channel's membership id, for its places in every [Joined].
pub fn membership_id() -> u64 {
    NEXT_MEMBERSHIP.fetch_add(1, Ordering::Relaxed)
}

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

    /// `user` (a key) joined `channel` as membership `id` on the socket that
    /// hears `socket`. `freed`, a membership another cap's close already
    /// ends, leaves the key's list if it is on it; past the cap their oldest
    /// joined channel's socket hears that it closes. Also gives the id of the
    /// one that left.
    pub fn join(
        &self,
        user: &str,
        id: u64,
        channel: u64,
        socket: &mpsc::UnboundedSender<Closing>,
        freed: Option<u64>,
    ) -> (Membership, Option<u64>) {
        let mut users = self.users.lock().unwrap_or_else(PoisonError::into_inner);
        let joined = users.by_user.entry(user.to_owned()).or_default();
        joined.push_back(Joiner {
            id,
            channel,
            socket: socket.clone(),
        });
        let mut left = None;
        if let Some(at) = freed.and_then(|freed| joined.iter().position(|j| j.id == freed)) {
            left = joined.remove(at).map(|joiner| joiner.id);
        }
        while joined.len() > self.cap {
            if let Some(oldest) = joined.pop_front() {
                let _ = oldest.socket.send((oldest.channel, oldest.id));
                left = Some(oldest.id);
            }
        }
        let membership = Membership {
            id,
            user: user.to_owned(),
            users: self.users.clone(),
        };
        (membership, left)
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

/// When a connection's kernel last took bytes to send (Epo 2026-10-20,
/// rate-limit review r7): a send has no total time limit, since a whole-state
/// answer is one frame that a slow link takes long to receive, but one that
/// moves no bytes for the silent window closes its socket ([watched]).
#[derive(Debug)]
pub struct Sent {
    born: Instant,
    /// Milliseconds after `born`.
    at: AtomicU64,
}

impl Default for Sent {
    fn default() -> Self {
        Sent {
            born: Instant::now(),
            at: AtomicU64::new(0),
        }
    }
}

impl Sent {
    fn mark(&self) {
        let at = u64::try_from(self.born.elapsed().as_millis()).unwrap_or(u64::MAX);
        self.at.store(at, Ordering::Relaxed);
    }

    fn last(&self) -> Instant {
        self.born + Duration::from_millis(self.at.load(Ordering::Relaxed))
    }
}

/// A connection's IO, marking its [Sent] whenever a write takes bytes.
#[derive(Debug)]
pub struct Tracked<T> {
    io: T,
    sent: Arc<Sent>,
}

impl<T: AsyncRead + Unpin> AsyncRead for Tracked<T> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.io).poll_read(cx, buf)
    }
}

impl<T: AsyncWrite + Unpin> AsyncWrite for Tracked<T> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let polled = Pin::new(&mut self.io).poll_write(cx, buf);
        if let Poll::Ready(Ok(1..)) = &polled {
            self.sent.mark();
        }
        polled
    }

    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        let polled = Pin::new(&mut self.io).poll_write_vectored(cx, bufs);
        if let Poll::Ready(Ok(1..)) = &polled {
            self.sent.mark();
        }
        polled
    }

    fn is_write_vectored(&self) -> bool {
        self.io.is_write_vectored()
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.io).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.io).poll_shutdown(cx)
    }
}

/// The server's TCP listener, its connections [Tracked].
pub struct TrackedListener(pub TcpListener);

impl Listener for TrackedListener {
    type Io = Tracked<TcpStream>;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        let (io, address) = Listener::accept(&mut self.0).await;
        let sent = Arc::default();
        (Tracked { io, sent }, address)
    }

    fn local_addr(&self) -> io::Result<Self::Addr> {
        Listener::local_addr(&self.0)
    }
}

/// A connection's client address and its [Sent] (axum's connect info).
#[derive(Clone, Debug)]
pub struct Peer {
    pub address: SocketAddr,
    pub sent: Arc<Sent>,
}

impl Connected<IncomingStream<'_, TrackedListener>> for Peer {
    fn connect_info(stream: IncomingStream<'_, TrackedListener>) -> Self {
        Peer {
            address: *stream.remote_addr(),
            sent: stream.io().sent.clone(),
        }
    }
}

/// How a [watched] send ended.
#[derive(Debug, PartialEq)]
pub enum Sending {
    Sent,
    Failed,
    /// No bytes moved for the stall window.
    Stalled,
}

/// Waits for `sending`, a send on the connection whose writes mark `sent`:
/// it stalls once the connection's kernel took no bytes for `stall` since the
/// send began, however long a send that keeps moving takes.
pub async fn watched<E>(
    sending: impl Future<Output = Result<(), E>>,
    sent: &Sent,
    stall: Duration,
) -> Sending {
    let began = Instant::now();
    tokio::pin!(sending);
    loop {
        let deadline = sent.last().max(began) + stall;
        if deadline <= Instant::now() {
            return Sending::Stalled;
        }
        tokio::select! {
            biased;
            result = &mut sending => {
                return if result.is_ok() { Sending::Sent } else { Sending::Failed };
            }
            () = tokio::time::sleep_until(deadline) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::SinkExt;
    use tokio::io::{AsyncReadExt, DuplexStream};
    use tokio_tungstenite::WebSocketStream;
    use tokio_tungstenite::tungstenite::Message;
    use tokio_tungstenite::tungstenite::protocol::Role;

    /// A server socket over a pipe holding 64 KiB, its [Sent], and the
    /// peer's end.
    async fn piped() -> (
        WebSocketStream<Tracked<DuplexStream>>,
        Arc<Sent>,
        DuplexStream,
    ) {
        let (ours, peer) = tokio::io::duplex(64 * 1024);
        let sent = Arc::new(Sent::default());
        let io = Tracked {
            io: ours,
            sent: sent.clone(),
        };
        let socket = WebSocketStream::from_raw_socket(io, Role::Server, None).await;
        (socket, sent, peer)
    }

    /// Security regression (Epo 2026-10-20, rate-limit review r7): a 1 MiB
    /// send to a peer that reads nothing stalls after the window (60 s), and
    /// the same send to a peer reading 16 KiB every 10 s goes out though it
    /// takes over ten minutes. Fails without the stall (the first send never
    /// ends), or with a bound on the whole send (the slow one stalls).
    #[tokio::test(start_paused = true)]
    async fn a_send_moving_no_bytes_stalls_while_a_slow_one_goes_out() {
        let stall = Duration::from_secs(60);
        let frame = Message::binary(vec![0u8; 1 << 20]);
        let (mut socket, sent, _reads_nothing) = piped().await;
        let stalled =
            tokio::time::timeout(stall * 2, watched(socket.send(frame.clone()), &sent, stall))
                .await;
        assert_eq!(stalled.ok(), Some(Sending::Stalled));

        let (mut socket, sent, mut peer) = piped().await;
        let reader = tokio::spawn(async move {
            let mut chunk = vec![0u8; 16 * 1024];
            let mut read = 0;
            while read < 1 << 20 {
                tokio::time::sleep(Duration::from_secs(10)).await;
                read += peer.read(&mut chunk).await.unwrap_or(0);
            }
        });
        let began = Instant::now();
        assert_eq!(
            watched(socket.send(frame), &sent, stall).await,
            Sending::Sent
        );
        assert!(began.elapsed() > Duration::from_secs(600));
        reader.abort();
    }

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
        let join = |user: &str, channel: u64, freed: Option<u64>| {
            joined.join(user, membership_id(), channel, &socket, freed)
        };
        let (first, _) = join("a", 1, None);
        let (second, _) = join("a", 2, None);
        let _other = join("b", 9, None);
        assert!(heard.try_recv().is_err());
        let (third, left) = join("a", 3, None);
        assert_eq!(left, Some(first.id));
        assert_eq!(heard.try_recv().ok(), Some((1, first.id)));
        // A channel that left gives its place back.
        drop(second);
        let (fourth, left) = join("a", 4, None);
        assert_eq!(left, None);
        assert!(heard.try_recv().is_err());
        // A place another cap's close already frees leaves instead of the
        // oldest (rate-limit review r6 S-3) ...
        let (_fifth, left) = join("a", 5, Some(fourth.id));
        assert_eq!(left, Some(fourth.id));
        assert!(heard.try_recv().is_err());
        // ... but a membership off the list frees nothing: an embed's, or
        // one closed already (review r7 B-1).
        let (_sixth, left) = join("a", 6, Some(first.id));
        assert_eq!(left, Some(third.id));
        assert_eq!(heard.try_recv().ok(), Some((3, third.id)));
    }
}
