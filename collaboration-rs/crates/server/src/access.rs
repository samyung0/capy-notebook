//! Note access in SQL (the Node server's `persistence.ts`): who may hold a
//! material room, and the read-only narrowing for a frozen account or an
//! owner at its storage limit. `frozen_sql` and `full_sql` mirror Go's
//! `over_quota_frozen` and `StorageUsage.Full` (`TestCollaborationFrozenSQLMatchesGo`).

use deadpool_postgres::GenericClient;

use crate::auth::Access;

pub const NOT_FOUND_REASON: &str = "collaboration-not-found";
pub const FORBIDDEN_REASON: &str = "collaboration-forbidden";
pub const READ_ONLY_REASON: &str = "collaboration-read-only";

/// Go's renewalTolerance: an entitling period stays live this long past
/// current_period_end, so a late renewal webhook never lapses a paying owner.
const RENEWAL_TOLERANCE: &str = "interval '48 hours'";

#[derive(Clone, Debug, thiserror::Error)]
pub enum AccessError {
    /// A missing or trashed material, or an owner deleted, being deleted or
    /// suspended.
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Forbidden(String),
    /// The room turned read-only for this writer: the editor drops to view.
    #[error("{0}")]
    ReadOnly(String),
    #[error("{0}")]
    Database(String),
}

impl AccessError {
    /// The refusal reason a client acts on, or none (it retries).
    pub fn reason(&self) -> Option<&'static str> {
        match self {
            AccessError::NotFound(_) => Some(NOT_FOUND_REASON),
            AccessError::Forbidden(_) => Some(FORBIDDEN_REASON),
            AccessError::ReadOnly(_) => Some(READ_ONLY_REASON),
            AccessError::Database(_) => None,
        }
    }

    /// The writer lost write access (an incident's `discard_unsaved`).
    pub fn lost_write(&self) -> bool {
        !matches!(self, AccessError::Database(_))
    }

    /// `errorReason` for incidents.
    pub fn incident_reason(&self) -> &'static str {
        match self {
            AccessError::NotFound(_) => "not_found",
            AccessError::Forbidden(_) => "forbidden",
            AccessError::ReadOnly(_) => "read_only",
            AccessError::Database(_) => "error",
        }
    }
}

impl AccessError {
    /// A source room's access answer from the gateway: the read-only
    /// refusal, a missing file or lost access get their reasons; anything
    /// else retries (`onAuthenticate`'s source mapping).
    pub fn from_source(error: &sources::SourceError) -> Self {
        if error.read_only() {
            return AccessError::ReadOnly(error.to_string());
        }
        match error.status() {
            Some(404) => AccessError::NotFound(error.to_string()),
            Some(403) => AccessError::Forbidden(error.to_string()),
            _ => AccessError::Database(error.to_string()),
        }
    }
}

impl From<tokio_postgres::Error> for AccessError {
    fn from(error: tokio_postgres::Error) -> Self {
        AccessError::Database(error.to_string())
    }
}

/// Go's over_quota_frozen: no live Pro period, the latest Pro period ended or
/// closed at least 14 days ago, and stored plus reserved bytes over the Free
/// limit. An account that never had Pro has no such period, so it is not
/// frozen (the comparison is NULL there; Node read it as false, a `bool`
/// column cannot hold it).
pub fn frozen_sql(user: &str, storage: &str) -> String {
    format!(
        "NOT EXISTS(SELECT 1 FROM user_subscriptions live_sub
        WHERE live_sub.user_id={user}.id
          AND live_sub.plan_tier='pro'
          AND live_sub.status IN ('active','trialing','past_due')
          AND (live_sub.current_period_end IS NULL
            OR live_sub.current_period_end > now() - {RENEWAL_TOLERANCE}))
      AND COALESCE(GREATEST(
        (SELECT max(expired_sub.current_period_end)
          FROM user_subscriptions expired_sub
          WHERE expired_sub.user_id={user}.id
            AND expired_sub.plan_tier='pro'
            AND expired_sub.status IN ('active','trialing','past_due')
            AND expired_sub.current_period_end <= now() - {RENEWAL_TOLERANCE}),
        (SELECT max(LEAST(
            COALESCE(closed_sub.current_period_end, closed_sub.ended_at,
              closed_sub.canceled_at,
              to_timestamp(NULLIF(closed_sub.stripe_event_created, 0)),
              closed_sub.updated_at),
            COALESCE(closed_sub.ended_at, closed_sub.canceled_at,
              to_timestamp(NULLIF(closed_sub.stripe_event_created, 0)),
              closed_sub.updated_at)))
          FROM user_subscriptions closed_sub
          WHERE closed_sub.user_id={user}.id
            AND closed_sub.plan_tier='pro'
            AND closed_sub.status NOT IN ('active','trialing','past_due'))
      ) <= now() - interval '14 days', false)
      AND COALESCE({storage}.used_bytes, 0)
        + COALESCE({storage}.reserved_bytes, 0)
        + COALESCE((SELECT sum(delta_bytes) FROM user_storage_deltas delta
          WHERE delta.user_id={user}.id), 0)
        > (SELECT storage_limit_bytes FROM plan_limits WHERE plan_tier='free')"
    )
}

/// Go's StorageUsage.Full: stored plus reserved bytes at or over the current
/// plan's limit (Free once a paid period lapsed, so grace counts).
pub fn full_sql(user: &str, storage: &str) -> String {
    format!(
        "COALESCE({storage}.used_bytes, 0)
        + COALESCE({storage}.reserved_bytes, 0)
        + COALESCE((SELECT sum(delta_bytes) FROM user_storage_deltas delta
          WHERE delta.user_id={user}.id), 0)
        >= (SELECT storage_limit_bytes FROM plan_limits WHERE plan_tier=CASE
          WHEN NOT EXISTS(SELECT 1 FROM user_subscriptions any_sub
            WHERE any_sub.user_id={user}.id) THEN {user}.plan_tier
          ELSE COALESCE((SELECT live.plan_tier FROM user_subscriptions live
            WHERE live.user_id={user}.id
              AND live.status IN ('active','trialing','past_due')
              AND (live.current_period_end IS NULL
                OR live.current_period_end > now() - {RENEWAL_TOLERANCE})
            ORDER BY (live.plan_tier='pro') DESC,
              live.current_period_end DESC NULLS FIRST LIMIT 1), 'free')
          END)"
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LiveAccess {
    /// The actor may edit (role editor or owner); a viewer reads only
    /// (signed-in viewers hold read channels, Epo 2026-10-10).
    pub editor: bool,
    pub frozen: bool,
    pub full: bool,
}

impl LiveAccess {
    pub fn access(self) -> Access {
        if !self.editor || self.frozen || self.full {
            Access::Read
        } else {
            Access::Write
        }
    }
}

fn rank(role: &str) -> u8 {
    match role {
        "viewer" => 1,
        "editor" => 2,
        "owner" => 3,
        _ => 0,
    }
}

/// `liveCollaborationAccess`: the actor's role on the material and the
/// read-only narrowing. An embedded item (a note's quiz or set) is reachable
/// exactly as its note is (Go `materialEffectiveAccess`).
pub async fn live_access<C: GenericClient>(
    client: &C,
    material_id: &str,
    actor: &str,
) -> Result<LiveAccess, AccessError> {
    let parent = client
        .query(
            "SELECT parent_material_id FROM materials WHERE id=$1 AND trashed_at IS NULL",
            &[&material_id],
        )
        .await?;
    let Some(row) = parent.first() else {
        return Err(AccessError::NotFound("material not found".into()));
    };
    let parent: Option<String> = row.get("parent_material_id");
    let material_id = parent.as_deref().unwrap_or(material_id);
    // `owner` is the lifecycle owner (the workspace owner, or a standalone
    // material's owner); `payer` is owner_user_id, the account the material is
    // charged to (uploader pays): its frozen, locked or full state makes the
    // material read-only (Go's canEditMaterial).
    let sql = format!(
        "SELECT m.owner_user_id, m.privacy, m.workspace_id, owner.id AS owner_id,
           (owner.deleted_at IS NOT NULL OR owner.deletion_requested_at IS NOT NULL) AS owner_gone,
           (owner.suspended_at IS NOT NULL) AS owner_suspended,
           (actor.deleted_at IS NOT NULL OR actor.deletion_requested_at IS NOT NULL
             OR actor.suspended_at IS NOT NULL) AS actor_locked,
           (payer.deleted_at IS NOT NULL OR payer.deletion_requested_at IS NOT NULL
             OR payer.suspended_at IS NOT NULL) AS payer_locked,
           w.privacy AS workspace_privacy,
           w.share_role, COALESCE(wm.role, '') AS member_role,
           (EXISTS(SELECT 1 FROM workspace_link_grants g WHERE g.workspace_id=w.id AND g.user_id=$2)
             OR EXISTS(SELECT 1 FROM material_link_grants g WHERE g.material_id=m.id AND g.user_id=$2))
             AS link_granted,
           {} AS payer_frozen,
           {} AS payer_full,
           {} AS actor_frozen
         FROM materials m
         JOIN users payer ON payer.id=m.owner_user_id
         JOIN users actor ON actor.id=$2
         LEFT JOIN workspaces w ON w.id=m.workspace_id
         JOIN users owner ON owner.id=COALESCE(w.user_id, m.owner_user_id)
         LEFT JOIN workspace_members wm ON wm.workspace_id=w.id AND wm.user_id=$2
         LEFT JOIN user_storage payer_storage ON payer_storage.user_id=payer.id
         LEFT JOIN user_storage actor_storage ON actor_storage.user_id=actor.id
         WHERE m.id=$1 AND m.trashed_at IS NULL",
        frozen_sql("payer", "payer_storage"),
        full_sql("payer", "payer_storage"),
        frozen_sql("actor", "actor_storage"),
    );
    let rows = client.query(&sql, &[&material_id, &actor]).await?;
    let Some(row) = rows.first() else {
        return Err(AccessError::NotFound("material not found".into()));
    };
    let owner_id: String = row.get("owner_id");
    let material_privacy: String = row.get("privacy");
    let workspace_id: Option<String> = row.get("workspace_id");
    // A deleted or deletion-pending owner's material is gone for everyone, a
    // suspended owner's for everyone but the owner (refused below as a locked
    // actor), as in Go's materialEffectiveAccess.
    if row.get::<_, bool>("owner_gone")
        || (row.get::<_, bool>("owner_suspended") && owner_id != actor)
    {
        return Err(AccessError::NotFound("material not found".into()));
    }
    if row.get::<_, bool>("actor_locked") {
        return Err(AccessError::Forbidden("actor account is locked".into()));
    }
    let role = if actor == owner_id {
        "owner".to_owned()
    } else {
        let workspace_privacy: Option<String> = row.get("workspace_privacy");
        let share_role: Option<String> = row.get("share_role");
        let member_role: String = row.get("member_role");
        // A link resource reaches a nonmember only through a redeemed link
        // (Go's workspaceRoles and materialEffectiveAccess).
        let link_granted: bool = row.get("link_granted");
        let shared = match (&workspace_id, workspace_privacy.as_deref()) {
            (Some(_), Some("public")) => share_role.unwrap_or_else(|| "viewer".into()),
            (Some(_), Some("link")) if !member_role.is_empty() || link_granted => {
                share_role.unwrap_or_else(|| "viewer".into())
            }
            (None, _)
                if material_privacy == "public" || (material_privacy == "link" && link_granted) =>
            {
                "viewer".into()
            }
            _ => String::new(),
        };
        if rank(&member_role) >= rank(&shared) {
            member_role
        } else {
            shared
        }
    };
    // Viewers hold read channels only; anyone else holds nothing.
    if rank(&role) < rank("viewer") {
        return Err(AccessError::Forbidden("material access was revoked".into()));
    }
    Ok(LiveAccess {
        editor: rank(&role) >= rank("editor"),
        frozen: row.get::<_, bool>("payer_frozen")
            || row.get::<_, bool>("payer_locked")
            || row.get::<_, bool>("actor_frozen"),
        full: row.get("payer_full"),
    })
}

/// `assertLiveCollaborationAccess`; returns the access it checked.
pub async fn assert_access<C: GenericClient>(
    client: &C,
    material_id: &str,
    actor: &str,
    requested: Access,
) -> Result<LiveAccess, AccessError> {
    let live = live_access(client, material_id, actor).await?;
    if requested == Access::Write && live.access() != Access::Write {
        return Err(AccessError::ReadOnly("collaboration access changed".into()));
    }
    Ok(live)
}

/// A writer in a store's snapshot must still hold an editing role (frozen
/// and full are enforced at admission, so their admitted updates save).
pub async fn assert_editor<C: GenericClient>(
    client: &C,
    material_id: &str,
    actor: &str,
) -> Result<(), AccessError> {
    if !live_access(client, material_id, actor).await?.editor {
        return Err(AccessError::Forbidden("material access was revoked".into()));
    }
    Ok(())
}

pub struct Boundary {
    /// The account the material is charged to (`owner_user_id`).
    pub payer_user_id: String,
}

/// The advisory lock that serializes a material's Yjs writes.
pub async fn lock_material<C: GenericClient>(
    client: &C,
    material_id: &str,
) -> Result<(), tokio_postgres::Error> {
    client
        .execute(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
            &[&material_id],
        )
        .await
        .map(|_| ())
}

/// `lockCollaborationBoundary`: Go's mutation order (workspace, ordered
/// accounts, then material), checking the placement did not move.
pub async fn lock_boundary<C: GenericClient>(
    client: &C,
    material_id: &str,
    actors: &[String],
) -> Result<Boundary, AccessError> {
    let placement = client
        .query(
            "SELECT owner_user_id, workspace_id, kind FROM materials WHERE id=$1 AND trashed_at IS NULL",
            &[&material_id],
        )
        .await?;
    let Some(expected) = placement.first() else {
        return Err(AccessError::NotFound("material not found".into()));
    };
    let payer: String = expected.get("owner_user_id");
    let workspace: Option<String> = expected.get("workspace_id");
    let kind: String = expected.get("kind");
    let mut owner = payer.clone();
    if let Some(workspace) = &workspace {
        let found = client
            .query(
                "SELECT user_id FROM workspaces WHERE id=$1 FOR SHARE",
                &[workspace],
            )
            .await?;
        let Some(found) = found.first() else {
            return Err(AccessError::NotFound("material not found".into()));
        };
        owner = found.get("user_id");
    }
    // The payer is charged by the write (agent inverses), so its row is
    // locked with the owner's and the actors'.
    let mut ids: Vec<String> = actors.to_vec();
    ids.push(owner.clone());
    ids.push(payer.clone());
    ids.sort();
    ids.dedup();
    let rows = client
        .query(
            "SELECT u.id, (u.deleted_at IS NOT NULL OR u.deletion_requested_at IS NOT NULL
               OR u.suspended_at IS NOT NULL) AS locked
             FROM users u WHERE u.id=ANY($1::text[]) ORDER BY u.id FOR SHARE OF u",
            &[&ids],
        )
        .await?;
    if rows.len() != ids.len() {
        return Err(AccessError::Forbidden(
            "collaboration account not found".into(),
        ));
    }
    // A deleted, deleting or suspended account among those rows stops the
    // write here, before the material lock: PurgeUser rewrites or deletes that
    // account's materials before it updates its row, so waiting on the
    // material while holding the row would deadlock. The owner (the
    // workspace's, or a standalone material's) and the payer refuse as the
    // material's; an actor's access is gone anyway (live_access).
    for row in &rows {
        if !row.get::<_, bool>("locked") {
            continue;
        }
        let id: String = row.get("id");
        return Err(AccessError::Forbidden(if id == owner || id == payer {
            "material owner account is locked".into()
        } else {
            "collaboration account is locked".into()
        }));
    }
    let locked = client
        .query(
            "SELECT owner_user_id, workspace_id, kind FROM materials WHERE id=$1 AND trashed_at IS NULL FOR SHARE",
            &[&material_id],
        )
        .await?;
    let Some(locked) = locked.first() else {
        return Err(AccessError::NotFound("material not found".into()));
    };
    if locked.get::<_, String>("owner_user_id") != payer
        || locked.get::<_, Option<String>>("workspace_id") != workspace
        || locked.get::<_, String>("kind") != kind
    {
        return Err(AccessError::Forbidden("material placement changed".into()));
    }
    Ok(Boundary {
        payer_user_id: payer,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_only_narrowing() {
        let open = LiveAccess {
            editor: true,
            frozen: false,
            full: false,
        };
        assert_eq!(open.access(), Access::Write);
        for narrowed in [
            LiveAccess {
                frozen: true,
                ..open
            },
            LiveAccess { full: true, ..open },
            LiveAccess {
                editor: false,
                ..open
            },
        ] {
            assert_eq!(narrowed.access(), Access::Read);
        }
    }

    #[test]
    fn refusal_reasons() {
        assert_eq!(
            AccessError::NotFound(String::new()).reason(),
            Some(NOT_FOUND_REASON)
        );
        assert_eq!(
            AccessError::Forbidden(String::new()).reason(),
            Some(FORBIDDEN_REASON)
        );
        assert_eq!(
            AccessError::ReadOnly(String::new()).reason(),
            Some(READ_ONLY_REASON)
        );
        assert_eq!(AccessError::Database(String::new()).reason(), None);
    }
}
