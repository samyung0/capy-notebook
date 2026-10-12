# Third-party notices

This file records third-party software vendored into this repository, with
its license. Add an entry when another one is vendored.

---

## tungstenite (vendored copy)

`collaboration-rs/third_party/tungstenite` is the `tungstenite` 0.29.0 crate
from crates.io (upstream https://github.com/snapview/tungstenite-rs). Its
sources are byte-identical to the published package apart from the changes
below, each marked "Patched for Capy" in the code (Epo 2026-10-11 and
2026-10-12):

- `FrameCodec::write_out_buffer` (`src/protocol/frame/mod.rs`) gives back a
  write buffer grown past 64 KiB (`BUFFER_KEEP`) once it is written, so a
  socket does not keep a buffer the size of the largest message it was sent;
- `FrameCodec::read_frame` moves the bytes after a frame past 64 KiB to a
  fresh read buffer, so a socket does not keep (and reclaim) a buffer the
  size of the largest frame it received;
- `FrameCodec::out_buffer_capacity`, `FrameCodec::in_buffer_capacity`,
  `WebSocket::write_buffer_capacity` and `WebSocket::read_buffer_capacity`
  (`src/protocol/mod.rs`) read those buffers' capacity, for
  `collaboration-rs/crates/server/tests/socket_buffers.rs`.

Copyright (c) 2017 Alexey Galakhov; Copyright (c) 2016 Jason Housley.

License: MIT or Apache License, Version 2.0, at your option. The vendored
directory ships both texts (`LICENSE-MIT`, `LICENSE-APACHE`).
