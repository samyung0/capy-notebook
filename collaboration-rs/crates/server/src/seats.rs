//! What one key may hold at once (Epo 2026-10-19, per-tenant fairness):
//! sockets per client address (`http.rs`), refused past the cap, and joined
//! channels per user and per user and document (`socket.rs`), where a join
//! past the cap closes the key's oldest joined channel instead. A [Seat] or
//! [Membership] is held while its socket or channel lives and gives its
//! place back when dropped. A socket whose sends move no bytes for the
//! silent window closes, giving its places back ([Traffic], [watched]).

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
use futures::{Stream, StreamExt};
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

/// What a connection's IO moved, either way.
/// - Out: when its kernel last took bytes to send (Epo 2026-10-20, rate-limit
///   review r7). A send has no total time limit, since a whole-state answer
///   is one frame that a slow link takes long to receive, but one that moves
///   no bytes for the silent window closes its socket ([watched]).
/// - In: when bytes last came and how many, and how many had come when its
///   socket last read a whole message (round 4, finding 9). A browser sends
///   a 2 MiB piece as one frame, its pongs waiting behind it, so a slow
///   uplink is heard by its bytes: a socket closes as silent only once no
///   byte came for the window (`socket.rs`), and a group of pieces lives on
///   while a message is arriving (`room.rs`), which pongs alone never are.
/// - The heartbeats its client's code sent ([crate::protocol::HEARTBEAT]):
///   a long send to the client (another room's whole state, a peer's large
///   update) holds back the server's pings and the acknowledgement its
///   group's rest waits for, so the tab's heartbeats keep it heard and renew
///   its group (`room.rs`), which a frozen tab whose browser only answers
///   pings never does.
#[derive(Debug)]
pub struct Traffic {
    born: Instant,
    /// Milliseconds after `born`.
    sent_at: AtomicU64,
    heard_at: AtomicU64,
    /// Bytes read in all.
    heard: AtomicU64,
    /// `heard` when the socket last read a whole message.
    whole: AtomicU64,
    /// Heartbeats read in all.
    beats: AtomicU64,
    /// When the last heartbeat came, and the longest wait between two, in
    /// milliseconds (the close log: a hidden tab's beats checked on UAT).
    beat_at: AtomicU64,
    beat_gap: AtomicU64,
}

impl Default for Traffic {
    fn default() -> Self {
        Traffic {
            born: Instant::now(),
            sent_at: AtomicU64::new(0),
            heard_at: AtomicU64::new(0),
            heard: AtomicU64::new(0),
            whole: AtomicU64::new(0),
            beats: AtomicU64::new(0),
            beat_at: AtomicU64::new(0),
            beat_gap: AtomicU64::new(0),
        }
    }
}

impl Traffic {
    fn now(&self) -> u64 {
        u64::try_from(self.born.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    fn sent(&self) {
        self.sent_at.store(self.now(), Ordering::Relaxed);
    }

    fn last_sent(&self) -> Instant {
        self.born + Duration::from_millis(self.sent_at.load(Ordering::Relaxed))
    }

    fn hear(&self, bytes: usize) {
        self.heard.fetch_add(bytes as u64, Ordering::Relaxed);
        self.heard_at.store(self.now(), Ordering::Relaxed);
    }

    /// When the connection last read a byte (its open, before any).
    pub fn last_heard(&self) -> Instant {
        self.born + Duration::from_millis(self.heard_at.load(Ordering::Relaxed))
    }

    /// The bytes it read in all.
    pub fn heard(&self) -> u64 {
        self.heard.load(Ordering::Relaxed)
    }

    /// Its socket read a whole message: every byte so far is in one.
    pub fn heard_whole(&self) {
        self.whole.store(self.heard(), Ordering::Relaxed);
    }

    /// Bytes came after the last whole message: one is arriving.
    pub fn arriving(&self) -> bool {
        self.heard() > self.whole.load(Ordering::Relaxed)
    }

    /// Its socket read a heartbeat.
    pub fn beat(&self) {
        let now = self.now();
        let last = self.beat_at.swap(now, Ordering::Relaxed);
        if self.beats.fetch_add(1, Ordering::Relaxed) > 0 {
            self.beat_gap
                .fetch_max(now.saturating_sub(last), Ordering::Relaxed);
        }
    }

    /// The heartbeats it read in all.
    pub fn beats(&self) -> u64 {
        self.beats.load(Ordering::Relaxed)
    }

    /// The longest wait between two of its heartbeats in milliseconds, once
    /// it read two.
    pub fn longest_beat_gap_ms(&self) -> Option<u64> {
        (self.beats() > 1).then(|| self.beat_gap.load(Ordering::Relaxed))
    }
}

/// A connection's IO, marking its [Traffic] whenever a write takes bytes or
/// a read gives some.
#[derive(Debug)]
pub struct Tracked<T> {
    io: T,
    traffic: Arc<Traffic>,
}

impl<T: AsyncRead + Unpin> AsyncRead for Tracked<T> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        let polled = Pin::new(&mut self.io).poll_read(cx, buf);
        let read = buf.filled().len() - before;
        if read > 0 {
            self.traffic.hear(read);
        }
        polled
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
            self.traffic.sent();
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
            self.traffic.sent();
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
        let traffic = Arc::default();
        (Tracked { io, traffic }, address)
    }

    fn local_addr(&self) -> io::Result<Self::Addr> {
        Listener::local_addr(&self.0)
    }
}

/// A connection's client address and its [Traffic] (axum's connect info).
#[derive(Clone, Debug)]
pub struct Peer {
    pub address: SocketAddr,
    pub traffic: Arc<Traffic>,
}

impl Connected<IncomingStream<'_, TrackedListener>> for Peer {
    fn connect_info(stream: IncomingStream<'_, TrackedListener>) -> Self {
        Peer {
            address: *stream.remote_addr(),
            traffic: stream.io().traffic.clone(),
        }
    }
}

/// How a [watched] or [send_reading] send ended.
#[derive(Debug, PartialEq)]
pub enum Sending {
    Sent,
    Failed,
    /// No bytes moved for the stall window.
    Stalled,
    /// The peer sent no byte for the silent window ([send_reading]).
    Silent,
}

/// What a [send_reading] step came to.
#[derive(Debug, PartialEq)]
pub enum Step<T> {
    /// The send ended.
    Sent(Sending),
    /// The peer sent this while the send goes on (none: its stream ended).
    Heard(Option<T>),
}

/// Waits for `sending`, a send on the connection whose writes mark
/// `traffic`: it stalls once the connection's kernel took no bytes for
/// `stall` since the send began, however long a send that keeps moving takes.
pub async fn watched<E>(
    sending: impl Future<Output = Result<(), E>>,
    traffic: &Traffic,
    stall: Duration,
) -> Sending {
    let began = Instant::now();
    tokio::pin!(sending);
    loop {
        let deadline = traffic.last_sent().max(began) + stall;
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

/// One step of a [watched] send (`sending`) that reads the peer meanwhile,
/// as a send to a slow downlink may take minutes and the tab's heartbeats
/// must not wait behind it: the send's end, what the peer sent next (the
/// caller takes it and steps again with the same send), or
/// [Sending::Silent] once the peer sent no byte for `silent`, the
/// connection's silent window (its stall window too).
pub async fn send_reading<R: Stream + Unpin>(
    mut sending: Pin<&mut impl Future<Output = Sending>>,
    incoming: &mut R,
    traffic: &Traffic,
    silent: Duration,
) -> Step<R::Item> {
    loop {
        let quiet = traffic.last_heard() + silent;
        tokio::select! {
            biased;
            sent = &mut sending => return Step::Sent(sent),
            item = incoming.next() => {
                traffic.heard_whole();
                return Step::Heard(item);
            }
            () = tokio::time::sleep_until(quiet) => {
                if traffic.last_heard() + silent <= Instant::now() {
                    return Step::Sent(Sending::Silent);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::SinkExt;
    use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
    use tokio_tungstenite::WebSocketStream;
    use tokio_tungstenite::tungstenite::Message;
    use tokio_tungstenite::tungstenite::protocol::Role;

    /// A server socket over a pipe holding 64 KiB, its [Traffic], and the
    /// peer's end.
    async fn piped() -> (
        WebSocketStream<Tracked<DuplexStream>>,
        Arc<Traffic>,
        DuplexStream,
    ) {
        let (ours, peer) = tokio::io::duplex(64 * 1024);
        let traffic = Arc::new(Traffic::default());
        let io = Tracked {
            io: ours,
            traffic: traffic.clone(),
        };
        let socket = WebSocketStream::from_raw_socket(io, Role::Server, None).await;
        (socket, traffic, peer)
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
        let (mut socket, traffic, _reads_nothing) = piped().await;
        let stalled = tokio::time::timeout(
            stall * 2,
            watched(socket.send(frame.clone()), &traffic, stall),
        )
        .await;
        assert_eq!(stalled.ok(), Some(Sending::Stalled));

        let (mut socket, traffic, mut peer) = piped().await;
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
            watched(socket.send(frame), &traffic, stall).await,
            Sending::Sent
        );
        assert!(began.elapsed() > Duration::from_secs(600));
        reader.abort();
    }

    /// The peer's end of [piped] reading 16 KiB a second, so a 1 MiB send
    /// to it takes about 64 s, and, when it `beats`, sending its heartbeat
    /// every 10 s, as a browser's text frame (masked with a zero key).
    fn slow_peer(peer: DuplexStream, beats: bool) -> tokio::task::JoinHandle<()> {
        let (mut reads, mut writes) = tokio::io::split(peer);
        tokio::spawn(async move {
            let heartbeat = crate::protocol::HEARTBEAT.as_bytes();
            let mut beat = vec![0x81, 0x80 | heartbeat.len() as u8, 0, 0, 0, 0];
            beat.extend_from_slice(heartbeat);
            let mut chunk = vec![0u8; 16 * 1024];
            for second in 1u64.. {
                tokio::time::sleep(Duration::from_secs(1)).await;
                if reads.read(&mut chunk).await.unwrap_or(0) == 0 {
                    return;
                }
                if beats && second % 10 == 0 {
                    writes.write_all(&beat).await.expect("a heartbeat");
                }
            }
        })
    }

    /// A 1 MiB frame sent to `socket` in [send_reading] steps, its peer's
    /// heartbeats counted as `socket.rs` counts them, and the time it took.
    async fn sent_reading(
        socket: WebSocketStream<Tracked<DuplexStream>>,
        traffic: &Traffic,
        silent: Duration,
    ) -> (Sending, Duration) {
        let (mut sink, mut stream) = socket.split();
        let began = Instant::now();
        let frame = Message::binary(vec![0u8; 1 << 20]);
        let sending = watched(sink.send(frame), traffic, silent);
        tokio::pin!(sending);
        loop {
            match send_reading(sending.as_mut(), &mut stream, traffic, silent).await {
                Step::Sent(sent) => return (sent, began.elapsed()),
                Step::Heard(Some(Ok(Message::Text(text))))
                    if text.as_str() == crate::protocol::HEARTBEAT =>
                {
                    traffic.beat();
                }
                Step::Heard(Some(Ok(_))) => {}
                Step::Heard(other) => panic!("the peer closed: {other:?}"),
            }
        }
    }

    /// A peer whose 1 MiB frame takes about 64 s to read, past the 30 s
    /// silent window, while its heartbeats come every 10 s: the send reads
    /// them as it goes, so they count and the send ends, not as silent
    /// (paused time; the 2026-11-23 CI rerun: Linux's buffers and proxies end
    /// a send at once, but one that waits must not hide the tab's beats).
    /// Fails if the socket reads nothing while it sends (no beat counted).
    #[tokio::test(start_paused = true)]
    async fn a_beating_peer_is_heard_through_a_long_send() {
        let silent = Duration::from_secs(30);
        let (socket, traffic, peer) = piped().await;
        let peer = slow_peer(peer, true);
        let (sent, took) = sent_reading(socket, &traffic, silent).await;
        assert_eq!(sent, Sending::Sent);
        assert!(took > silent, "{took:?}");
        assert!(traffic.beats() >= 5, "{} beats", traffic.beats());
        peer.abort();
    }

    /// The close log's longest wait between two heartbeats, the check of a
    /// hidden tab's beats on UAT (paused time): none before a second beat,
    /// then the longest of the waits. Fails if a wait goes unmeasured or a
    /// shorter one replaces it.
    #[tokio::test(start_paused = true)]
    async fn the_longest_wait_between_heartbeats_is_kept() {
        let traffic = Traffic::default();
        traffic.beat();
        assert_eq!(traffic.longest_beat_gap_ms(), None);
        for wait in [20, 61, 20] {
            tokio::time::advance(Duration::from_secs(wait)).await;
            traffic.beat();
        }
        assert_eq!(traffic.longest_beat_gap_ms(), Some(61_000));
    }

    /// The same send to a peer that reads it but sends nothing: it ends as
    /// silent at the 30 s window, long before it would be through (paused
    /// time). Fails if silence is not watched while a send is under way
    /// (the send goes on for its 64 s).
    #[tokio::test(start_paused = true)]
    async fn a_silent_peer_closes_at_the_window_during_a_long_send() {
        let silent = Duration::from_secs(30);
        let (socket, traffic, peer) = piped().await;
        let peer = slow_peer(peer, false);
        let (sent, took) = sent_reading(socket, &traffic, silent).await;
        assert_eq!(sent, Sending::Silent);
        assert!(took < silent + Duration::from_secs(2), "{took:?}");
        peer.abort();
    }

    /// Round 4, finding 9: a read marks its bytes heard, and a message part
    /// of which came is arriving until the socket reads it whole. Fails if
    /// reads go unmarked.
    #[tokio::test]
    async fn a_read_is_heard_and_a_message_arrives_until_whole() {
        let (mut socket, traffic, mut peer) = piped().await;
        // A binary frame of 4 bytes, masked with a zero key, as a browser
        // sends it: its header and half its payload first.
        let wire = [0x82, 0x84, 0, 0, 0, 0, 1, 2, 3, 4];
        peer.write_all(&wire[..8]).await.expect("half");
        let read = tokio::time::timeout(Duration::from_millis(50), socket.next()).await;
        assert!(read.is_err(), "a whole message before its end");
        assert_eq!(traffic.heard(), 8);
        assert!(traffic.arriving());
        peer.write_all(&wire[8..]).await.expect("rest");
        let message = socket.next().await.expect("a message").expect("read");
        assert_eq!(message, Message::binary(vec![1, 2, 3, 4]));
        traffic.heard_whole();
        assert_eq!(traffic.heard(), 10);
        assert!(!traffic.arriving());
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
