//! An item room's admission (the notes `Validator`'s pattern): the shape of
//! every new struct, then the room's bound plus the update's growth; only an
//! update past a cap or a limit is applied to a copy and checked exactly.

use notes::limits::{LimitCode, Metrics, limit_code};
use yrs::updates::encoder::Encode;
use yrs::{ReadTxn, StateVector, Transact, Update};

use crate::Kind;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Admission {
    Accepted,
    /// The room cannot place it yet: the server drops it and resyncs.
    Unheld,
}

#[derive(Debug, thiserror::Error)]
pub enum Refusal {
    /// Sent to the writer as `document-rejected` with `code` and `metrics`.
    #[error("invalid material document: {}", code.as_str())]
    Limit { code: LimitCode, metrics: Metrics },
    #[error(transparent)]
    Update(#[from] ydoc::UpdateError),
    /// A struct outside the document's shape, or a text past its cap.
    #[error("{0}")]
    Shape(String),
}

#[derive(Debug)]
pub struct Validator {
    pub kind: Kind,
    /// The last exact metrics plus each later update's growth.
    pub bound: Option<Metrics>,
    /// The last exact metrics (the shrink baseline).
    pub metrics: Option<Metrics>,
    /// A quiz document: the other document's metrics, which count with
    /// this one's against the material's limits (REVIEW1 S3).
    pub peer: Option<Metrics>,
    /// Exact checks taken (a copy of the room each).
    pub exact_checks: u64,
}

impl Validator {
    /// `metrics` as the room's load measured them.
    pub fn new(kind: Kind, metrics: Option<Metrics>) -> Self {
        Validator {
            kind,
            bound: metrics,
            metrics,
            peer: None,
            exact_checks: 0,
        }
    }

    pub fn admit(&mut self, doc: &yrs::Doc, update: &Update) -> Result<Admission, Refusal> {
        let txn = doc.transact();
        self.kind.assert_roots(&txn).map_err(Refusal::Shape)?;
        let incoming = ydoc::Incoming::new(update);
        let inspection = ydoc::inspect(&txn, &incoming)?;
        if inspection.unheld {
            return Ok(Admission::Unheld);
        }
        let growth = self
            .kind
            .admit_shapes(&txn, &incoming)
            .map_err(Refusal::Shape)?;
        if let Some(bound) = self.bound
            && !growth.over_cap
        {
            let next = Metrics {
                content_bytes: bound.content_bytes + growth.bytes,
                max_depth: bound.max_depth,
                node_count: bound.node_count + growth.nodes,
            };
            if limit_code(&crate::combine(&next, self.peer.as_ref())).is_none() {
                self.bound = Some(next);
                return Ok(Admission::Accepted);
            }
        }
        self.exact_checks += 1;
        let candidate = match inspection.trial {
            Some(trial) => trial,
            None => {
                let candidate = ydoc::scratch_doc();
                let mut copy = candidate.transact_mut();
                let state = txn.encode_state_as_update_v1(&StateVector::default());
                let update = update.encode_v1();
                for bytes in [state.as_slice(), update.as_slice()] {
                    copy.apply_update(ydoc::decode(bytes)?)
                        .map_err(|error| ydoc::UpdateError::Decode(error.to_string()))?;
                }
                drop(copy);
                candidate
            }
        };
        let candidate_txn = candidate.transact();
        self.kind
            .assert_roots(&candidate_txn)
            .map_err(Refusal::Shape)?;
        self.kind
            .check_caps(&candidate_txn)
            .map_err(Refusal::Shape)?;
        if self.metrics.is_none() {
            let value = self.kind.document_value(&txn);
            self.metrics = Some(notes::limits::measure_value(&value));
        }
        let value = self.kind.document_value(&candidate_txn);
        let metrics =
            crate::check_value(self.kind, &value, self.metrics.as_ref(), self.peer.as_ref())?;
        self.bound = Some(metrics);
        self.metrics = Some(metrics);
        Ok(Admission::Accepted)
    }

    /// A content change `admit` did not check entered the room (a server
    /// write, a reload): the next update measures exactly.
    pub fn invalidate(&mut self) {
        self.bound = None;
        self.metrics = None;
    }
}
