//! Pooled database connections that carried a large message, for this crate
//! and the server's note store alike.

use std::error::Error;
use std::sync::atomic::{AtomicUsize, Ordering};

use deadpool_postgres::Object;
use tokio_postgres::types::{FromSql, Type};

/// A pooled connection whose largest message was over this many bytes
/// closes instead of going back to the pool (Epo 2026-11-24): whole boards
/// and Office states are over it, edits and receipts far under.
pub const LARGE_ROW_BYTES: usize = 1 << 20;

/// A pooled connection that closes, instead of going back to its pool, when
/// the largest message it carried was over [LARGE_ROW_BYTES]. A connection
/// keeps its read, write and bind buffers at about twice its largest message
/// for as long as it lives (8 MiB each after a 4 MiB board,
/// `bench/collaboration/reports/2026-11-24-room-memory-prod-2.md`), and the
/// pool never closes an idle one.
///
/// The close is in `Drop`, so every exit closes it, early returns and `?`
/// included. It cuts off a transaction still open, which Postgres logs as an
/// unexpected EOF: an exit that is not an error rolls its transaction back
/// first, ignoring a failed rollback (its refusal stands, and Postgres rolls
/// back as the connection closes).
pub struct Pooled {
    /// Taken only by `Drop`.
    client: Option<Object>,
    largest: Largest,
}

/// The largest message a [Pooled] connection carried: a row or column read,
/// a state written.
#[derive(Default)]
pub struct Largest(AtomicUsize);

impl Largest {
    pub fn note(&self, bytes: usize) {
        self.0.fetch_max(bytes, Ordering::Relaxed);
    }
}

impl Pooled {
    pub fn new(client: Object) -> Self {
        Pooled {
            client: Some(client),
            largest: Largest::default(),
        }
    }

    /// The connection and its [Largest] apart, so a transaction borrowing
    /// the one leaves the other free to note on.
    pub fn parts(&mut self) -> (&mut Object, &Largest) {
        let client = self.client.as_mut().expect("only Drop takes the client");
        (client, &self.largest)
    }
}

impl Drop for Pooled {
    fn drop(&mut self) {
        if *self.largest.0.get_mut() > LARGE_ROW_BYTES
            && let Some(client) = self.client.take()
        {
            // Detached from the pool, it closes as it drops.
            drop(Object::take(client));
        }
    }
}

/// A column's value and its bytes as they came over the connection, for
/// [Largest::note] where the value is not bytes itself (a material's content
/// JSON).
pub struct Measured<T> {
    pub value: T,
    pub bytes: usize,
}

impl<'a, T: FromSql<'a>> FromSql<'a> for Measured<T> {
    fn from_sql(ty: &Type, raw: &'a [u8]) -> Result<Self, Box<dyn Error + Sync + Send>> {
        Ok(Measured {
            value: T::from_sql(ty, raw)?,
            bytes: raw.len(),
        })
    }

    fn from_sql_null(ty: &Type) -> Result<Self, Box<dyn Error + Sync + Send>> {
        Ok(Measured {
            value: T::from_sql_null(ty)?,
            bytes: 0,
        })
    }

    fn accepts(ty: &Type) -> bool {
        T::accepts(ty)
    }
}
