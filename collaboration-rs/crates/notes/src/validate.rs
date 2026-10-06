//! A note document's roots (`assertMaterialDocumentRoots`,
//! `keepsMaterialRoots` in `collaboration/src/persistence.ts`).

use yrs::ReadTxn;
use yrs::branch::BranchID;

use ydoc::{CONTRIBUTORS_ROOT, Container};

use crate::plate::CONTENT_ROOT;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RootError {
    #[error("unsupported collaboration document root: {0}")]
    Unsupported(String),
    #[error("invalid collaboration content root")]
    Content,
    #[error("invalid collaboration contributor root")]
    Contributors,
}

/// Only `content` (children only, no attribute ever set) and the marker map
/// (entries only, no sequence item ever written).
pub fn assert_roots<T: ReadTxn>(txn: &T) -> Result<(), RootError> {
    let mut names: Vec<String> = txn.root_refs().map(|(name, _)| name.to_string()).collect();
    names.sort();
    if let Some(name) = names
        .iter()
        .find(|n| *n != CONTENT_ROOT && *n != CONTRIBUTORS_ROOT)
    {
        return Err(RootError::Unsupported(name.clone()));
    }
    if let Some(content) = BranchID::get_root(txn, CONTENT_ROOT) {
        if content.map_items().next().is_some() {
            return Err(RootError::Content);
        }
    }
    if let Some(contributors) = BranchID::get_root(txn, CONTRIBUTORS_ROOT) {
        if contributors.start().is_some() {
            return Err(RootError::Contributors);
        }
    }
    Ok(())
}

/// Whether a placeable update's new structs keep the roots valid: content
/// takes children only, the marker map entries only.
pub fn keeps_roots(containers: &[Container]) -> bool {
    containers.iter().all(|c| {
        if &*c.root == CONTENT_ROOT {
            c.key.is_none()
        } else {
            &*c.root == CONTRIBUTORS_ROOT && c.key.is_some()
        }
    })
}

pub use crate::material::{ValidationError, assert_canonical};
