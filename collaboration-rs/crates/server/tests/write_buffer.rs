#![allow(clippy::unwrap_used)] // Tests panic on a broken socket.
//! The vendored tungstenite's write buffer (`third_party/tungstenite`, Epo
//! 2026-10-11): once a socket has written a large message, it keeps no
//! buffer that size. A live View viewer joining a 2 MB note is sent the whole
//! note; upstream tungstenite kept that capacity for as long as the socket
//! stayed open (about 2.3 MiB per viewer).
use std::io::Cursor;

use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::{Role, WebSocket};

/// The most a socket keeps once its write buffer is written (the patch's
/// `OUT_BUFFER_KEEP`).
const KEEP: usize = 64 * 1024;

#[test]
fn a_socket_keeps_no_large_write_buffer_after_a_large_message() {
    let mut socket = WebSocket::from_raw_socket(Cursor::new(Vec::new()), Role::Server, None);
    // `send` writes the frame and flushes it.
    socket.send(Message::binary(vec![0u8; 2 << 20])).unwrap();
    let capacity = socket.write_buffer_capacity();
    assert!(capacity <= KEEP, "{capacity} bytes kept");
    // The socket still writes, and a small message keeps its buffer.
    socket.send(Message::binary(vec![1u8; 100])).unwrap();
    assert!(socket.write_buffer_capacity() > 0);
    assert!(socket.get_ref().get_ref().len() > 2 << 20);
}
