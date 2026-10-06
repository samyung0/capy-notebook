//! Frames over an engine process's pipes: `CAPY`, the body length (u32 LE),
//! then the body: the head (u16 length + UTF-8; a method in a request, `ok` or
//! `error` in an answer), the JSON (u32 length + bytes) and the byte arguments
//! (u16 count, each u32 length + bytes). Bytes travel raw, never as base64.

use std::io::{self, Read, Write};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

const MAGIC: [u8; 4] = *b"CAPY";
/// A frame past this is a corrupt pipe, not a call: bases, states and exports
/// stop at 100 MB.
pub const MAX_FRAME_BYTES: usize = 1 << 30;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Frame {
    pub head: String,
    pub json: Vec<u8>,
    pub blobs: Vec<Vec<u8>>,
}

impl Frame {
    pub fn new(head: impl Into<String>, json: Vec<u8>, blobs: Vec<Vec<u8>>) -> Self {
        Self {
            head: head.into(),
            json,
            blobs,
        }
    }

    fn body_len(&self) -> usize {
        2 + self.head.len()
            + 4
            + self.json.len()
            + 2
            + self.blobs.iter().map(|blob| 4 + blob.len()).sum::<usize>()
    }

    /// Everything up to the first blob's bytes; each blob then follows as its
    /// length and bytes, so blobs are written without being copied.
    fn prefix(&self) -> io::Result<Vec<u8>> {
        let body = self.body_len();
        if body > MAX_FRAME_BYTES || self.head.len() > u16::MAX as usize {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "engine frame too large",
            ));
        }
        let blobs = u16::try_from(self.blobs.len())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "too many engine blobs"))?;
        let mut out = Vec::with_capacity(16 + self.head.len() + self.json.len());
        out.extend_from_slice(&MAGIC);
        out.extend_from_slice(&(body as u32).to_le_bytes());
        out.extend_from_slice(&(self.head.len() as u16).to_le_bytes());
        out.extend_from_slice(self.head.as_bytes());
        out.extend_from_slice(&(self.json.len() as u32).to_le_bytes());
        out.extend_from_slice(&self.json);
        out.extend_from_slice(&blobs.to_le_bytes());
        Ok(out)
    }

    /// The bytes the frame takes on the pipe.
    pub fn wire_len(&self) -> usize {
        8 + self.body_len()
    }

    pub fn write_to(&self, writer: &mut impl Write) -> io::Result<()> {
        writer.write_all(&self.prefix()?)?;
        for blob in &self.blobs {
            writer.write_all(&(blob.len() as u32).to_le_bytes())?;
            writer.write_all(blob)?;
        }
        writer.flush()
    }

    pub async fn write_async(&self, writer: &mut (impl AsyncWrite + Unpin)) -> io::Result<()> {
        writer.write_all(&self.prefix()?).await?;
        for blob in &self.blobs {
            writer.write_all(&(blob.len() as u32).to_le_bytes()).await?;
            writer.write_all(blob).await?;
        }
        writer.flush().await
    }

    /// The next frame, or `None` at a clean end of the pipe.
    pub fn read_from(reader: &mut impl Read) -> io::Result<Option<Frame>> {
        let mut start = [0u8; 8];
        if !read_start(reader, &mut start)? {
            return Ok(None);
        }
        let body = body_len(&start)?;
        let mut body = reader.take(body as u64);
        Ok(Some(parse(&mut body)?))
    }

    pub async fn read_async(reader: &mut (impl AsyncRead + Unpin)) -> io::Result<Option<Frame>> {
        let mut start = [0u8; 8];
        let first = reader.read(&mut start).await?;
        if first == 0 {
            return Ok(None);
        }
        reader.read_exact(&mut start[first..]).await?;
        let body = body_len(&start)?;
        let mut body = reader.take(body as u64);
        let head_len = body.read_u16_le().await? as usize;
        let head = read_vec_async(&mut body, head_len).await?;
        let json_len = body.read_u32_le().await? as usize;
        let json = read_vec_async(&mut body, json_len).await?;
        let count = body.read_u16_le().await? as usize;
        let mut blobs = Vec::with_capacity(count);
        for _ in 0..count {
            let len = body.read_u32_le().await? as usize;
            blobs.push(read_vec_async(&mut body, len).await?);
        }
        if body.limit() != 0 {
            return Err(corrupt("engine frame shorter than its length"));
        }
        Ok(Some(Frame {
            head: String::from_utf8(head).map_err(|_| corrupt("engine frame head"))?,
            json,
            blobs,
        }))
    }
}

fn corrupt(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_owned())
}

fn read_start(reader: &mut impl Read, start: &mut [u8; 8]) -> io::Result<bool> {
    let mut filled = 0;
    while filled < start.len() {
        match reader.read(&mut start[filled..]) {
            Ok(0) if filled == 0 => return Ok(false),
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(read) => filled += read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(true)
}

fn body_len(start: &[u8; 8]) -> io::Result<usize> {
    if start[..4] != MAGIC {
        return Err(corrupt("engine frame without its magic"));
    }
    let body = u32::from_le_bytes([start[4], start[5], start[6], start[7]]) as usize;
    if body > MAX_FRAME_BYTES {
        return Err(corrupt("engine frame too large"));
    }
    Ok(body)
}

fn parse(reader: &mut io::Take<&mut impl Read>) -> io::Result<Frame> {
    let mut u16_at = || -> io::Result<usize> {
        let mut bytes = [0u8; 2];
        reader.read_exact(&mut bytes)?;
        Ok(u16::from_le_bytes(bytes) as usize)
    };
    let head_len = u16_at()?;
    let head = read_vec(reader, head_len)?;
    let json_len = read_u32(reader)? as usize;
    let json = read_vec(reader, json_len)?;
    let mut count = [0u8; 2];
    reader.read_exact(&mut count)?;
    let count = u16::from_le_bytes(count) as usize;
    let mut blobs = Vec::with_capacity(count);
    for _ in 0..count {
        let len = read_u32(reader)? as usize;
        blobs.push(read_vec(reader, len)?);
    }
    if reader.limit() != 0 {
        return Err(corrupt("engine frame shorter than its length"));
    }
    Ok(Frame {
        head: String::from_utf8(head).map_err(|_| corrupt("engine frame head"))?,
        json,
        blobs,
    })
}

fn read_u32(reader: &mut impl Read) -> io::Result<u32> {
    let mut bytes = [0u8; 4];
    reader.read_exact(&mut bytes)?;
    Ok(u32::from_le_bytes(bytes))
}

fn read_vec(reader: &mut io::Take<&mut impl Read>, len: usize) -> io::Result<Vec<u8>> {
    if len as u64 > reader.limit() {
        return Err(corrupt("engine frame overruns its length"));
    }
    let mut out = vec![0u8; len];
    reader.read_exact(&mut out)?;
    Ok(out)
}

async fn read_vec_async(
    reader: &mut tokio::io::Take<&mut (impl AsyncRead + Unpin)>,
    len: usize,
) -> io::Result<Vec<u8>> {
    if len as u64 > reader.limit() {
        return Err(corrupt("engine frame overruns its length"));
    }
    let mut out = vec![0u8; len];
    reader.read_exact(&mut out).await?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Frame {
        Frame::new(
            "seedOffice",
            br#"{"format":"docx"}"#.to_vec(),
            vec![vec![1, 2, 3], vec![]],
        )
    }

    #[test]
    fn round_trips_sync_and_async() {
        let mut wire = Vec::new();
        sample().write_to(&mut wire).unwrap();
        sample().write_to(&mut wire).unwrap();
        assert_eq!(wire.len(), 2 * sample().wire_len());
        let mut reader = wire.as_slice();
        assert_eq!(Frame::read_from(&mut reader).unwrap(), Some(sample()));
        assert_eq!(Frame::read_from(&mut reader).unwrap(), Some(sample()));
        assert_eq!(Frame::read_from(&mut reader).unwrap(), None);

        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        runtime.block_on(async {
            let mut reader = wire.as_slice();
            assert_eq!(
                Frame::read_async(&mut reader).await.unwrap(),
                Some(sample())
            );
            assert_eq!(
                Frame::read_async(&mut reader).await.unwrap(),
                Some(sample())
            );
            assert_eq!(Frame::read_async(&mut reader).await.unwrap(), None);
        });
    }

    #[test]
    fn refuses_garbage_and_truncation() {
        let mut wire = Vec::new();
        sample().write_to(&mut wire).unwrap();
        // Garbage on stdout (a stray print) is a corrupt pipe, not a frame.
        let mut garbage = b"hello world\n".to_vec();
        garbage.extend_from_slice(&wire);
        assert!(Frame::read_from(&mut garbage.as_slice()).is_err());
        // A child that dies mid-answer.
        let cut = &wire[..wire.len() - 2];
        assert!(Frame::read_from(&mut &cut[..]).is_err());
        let runtime = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        runtime.block_on(async {
            assert!(Frame::read_async(&mut garbage.as_slice()).await.is_err());
            assert!(Frame::read_async(&mut &cut[..]).await.is_err());
        });
    }
}
