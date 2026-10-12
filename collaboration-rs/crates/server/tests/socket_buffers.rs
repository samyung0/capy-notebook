#![allow(clippy::unwrap_used)] // Tests panic on a broken socket.
//! The vendored tungstenite's buffers (`third_party/tungstenite`, Epo
//! 2026-10-11 and 2026-10-12): once a socket has written or read a large
//! frame, it keeps no buffer that size. A live View viewer joining a 2 MB
//! note is sent the whole note; upstream tungstenite kept that capacity for
//! as long as the socket stayed open (about 2.3 MiB per viewer).
use std::io::Cursor;

use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::{Role, WebSocket, WebSocketConfig};

/// The most a socket keeps of a buffer a large frame grew (the patch's
/// `BUFFER_KEEP`).
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

/// The read side (REVIEW5 final S3): a socket that received a large frame
/// kept a buffer its size, reclaimed whole by the frames after it, so any
/// joined peer could pin up to the frame cap (about 100 MiB) per socket. After
/// a 2 MiB frame and enough small ones to use up any spare room, the socket's
/// read buffer is back under the cap.
#[test]
fn a_socket_keeps_no_large_read_buffer_after_a_large_frame() {
    // A peer's frames, masked as a client masks them.
    let mut peer = WebSocket::from_raw_socket(Cursor::new(Vec::new()), Role::Client, None);
    peer.send(Message::binary(vec![0u8; 2 << 20])).unwrap();
    for _ in 0..300 {
        peer.send(Message::binary(vec![1u8; 100])).unwrap();
    }
    let frames = peer.get_ref().get_ref().clone();
    let config = WebSocketConfig::default().read_buffer_size(8 * 1024);
    let mut socket = WebSocket::from_raw_socket(Cursor::new(frames), Role::Server, Some(config));
    assert_eq!(socket.read().unwrap().len(), 2 << 20);
    for _ in 0..300 {
        assert_eq!(socket.read().unwrap().len(), 100);
    }
    let capacity = socket.read_buffer_capacity();
    assert!(capacity <= KEEP, "{capacity} bytes kept");
}
