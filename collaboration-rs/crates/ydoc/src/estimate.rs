//! A room's state byte cap by estimate (persistence.ts `updateFitsRoom`),
//! shared by source rooms and board rooms: O(1) per update except the exact
//! measure near the cap, which runs at most once per [MEASURE_EVERY] updates
//! or [MEASURE_GROWTH] bytes of estimated growth, with the update's apply
//! work-limited (Epo 2026-10-19).

use yrs::updates::decoder::Decode;
use yrs::{Doc, ReadTxn, StateVector, Transact, Update};

/// Updates between two exact measures of a room near its cap: one past the
/// estimate meanwhile is refused by the estimate alone. A measure costs about
/// 13 ms per MB of state in release (0.9 s at 64 MiB), so a writer at the
/// allowance's 200 updates a second costs a room at most one every 5 s.
pub const MEASURE_EVERY: u32 = 1000;
/// Estimated growth since the last exact measure after which the next may
/// run sooner: the update allowance's byte burst, so a large action's pieces
/// over existing content near the cap are measured, not refused by the
/// estimate alone. At the allowance's 2 MiB a second that is one measure per
/// 4 s per writer at most.
pub const MEASURE_GROWTH: u64 = 8 << 20;

/// A room's running state size: the bytes of the state and of each update
/// applied since it was last measured, the bytes that measure found, and the
/// updates left before the next exact measure may run.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Estimate {
    pub bytes: u64,
    pub measured: u64,
    pub until_measure: u32,
}

impl Estimate {
    pub fn new(bytes: u64) -> Self {
        Estimate {
            bytes,
            measured: bytes,
            until_measure: 0,
        }
    }

    /// An applied update of `bytes` whose deletes freed `freed` payload bytes
    /// (`ydoc::apply_freeing`, Epo 2026-10-19): overwrites, deletes and
    /// replaced pictures do not drift the estimate toward refusals, and it
    /// stays an upper bound of the state.
    pub fn applied(&mut self, bytes: u64, freed: u64) {
        self.bytes = (self.bytes + bytes).saturating_sub(freed);
    }
}

/// Whether the update keeps the room within the cap: by the estimate, and
/// past it by one exact measure of the room plus the update (at most once
/// per [MEASURE_EVERY] updates, or once the estimate grew [MEASURE_GROWTH]
/// since the last), which also resets the estimate. The update's apply to
/// the measured copy is limited to `ydoc::MAX_WORK` steps.
pub fn fits_room(
    doc: &Doc,
    update: &[u8],
    estimate: &mut Estimate,
    cap: u64,
) -> Result<bool, String> {
    estimate.until_measure = estimate.until_measure.saturating_sub(1);
    if estimate.bytes + update.len() as u64 <= cap {
        return Ok(true);
    }
    if estimate.until_measure > 0 && estimate.bytes < estimate.measured + MEASURE_GROWTH {
        return Ok(false);
    }
    estimate.until_measure = MEASURE_EVERY;
    let state = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    estimate.bytes = state.len() as u64;
    estimate.measured = estimate.bytes;
    let candidate = crate::scratch_doc();
    let decoded = Update::decode_v1(&state).map_err(|error| error.to_string())?;
    candidate
        .transact_mut()
        .apply_update(decoded)
        .map_err(|error| error.to_string())?;
    let mut txn = candidate.transact_mut();
    txn.limit_work(crate::MAX_WORK);
    let decoded = Update::decode_v1(update).map_err(|error| error.to_string())?;
    let costly = || {
        format!(
            "update would take yrs more than {} steps to place",
            crate::MAX_WORK
        )
    };
    match txn.apply_update(decoded) {
        Ok(()) => {}
        Err(yrs::error::UpdateError::WorkBudgetExceeded(_)) => return Err(costly()),
        Err(error) => return Err(error.to_string()),
    }
    if txn.work() > crate::MAX_WORK {
        return Err(costly());
    }
    let measured = txn.encode_state_as_update_v1(&StateVector::default()).len() as u64;
    Ok(measured <= cap)
}
