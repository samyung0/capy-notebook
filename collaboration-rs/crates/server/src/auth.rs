//! Collaboration tokens and room names (`collaboration/src/auth.ts`): HS256
//! JWTs the Go API mints for one room and schema.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use subtle::ConstantTimeEq;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Access {
    Read,
    Write,
}

impl Access {
    pub fn as_str(self) -> &'static str {
        match self {
            Access::Read => "read",
            Access::Write => "write",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Claims {
    pub access: Access,
    pub aud: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    pub exp: i64,
    pub iat: i64,
    pub iss: String,
    pub jti: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub room: String,
    pub schema: i64,
    pub sub: String,
}

/// Who a channel is: the token's user and access, and when it expires.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Context {
    pub access: Access,
    pub expires_at: i64,
    pub token_id: String,
    pub user_id: String,
}

impl From<&Claims> for Context {
    fn from(claims: &Claims) -> Self {
        Context {
            access: claims.access,
            expires_at: claims.exp,
            token_id: claims.jti.clone(),
            user_id: claims.sub.clone(),
        }
    }
}

/// `material:<id>:schema:<n>` or `source:<id>:epoch:<n>`.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum RoomName {
    Material { material_id: String, schema: i64 },
    Source { file_id: String, epoch: i64 },
}

fn id_ok(id: &str) -> bool {
    !id.is_empty()
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

impl RoomName {
    pub fn parse(name: &str) -> Option<Self> {
        let parts: Vec<&str> = name.split(':').collect();
        let [kind, id, label, number] = parts.as_slice() else {
            return None;
        };
        if !id_ok(id) || number.is_empty() || !number.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        let number: i64 = number.parse().ok()?;
        match (*kind, *label) {
            ("material", "schema") => Some(RoomName::Material {
                material_id: (*id).to_owned(),
                schema: number,
            }),
            ("source", "epoch") => Some(RoomName::Source {
                file_id: (*id).to_owned(),
                epoch: number,
            }),
            _ => None,
        }
    }

    /// The schema or epoch the name carries (a token's `schema`).
    pub fn number(&self) -> i64 {
        match self {
            RoomName::Material { schema, .. } => *schema,
            RoomName::Source { epoch, .. } => *epoch,
        }
    }

    pub fn is_source(&self) -> bool {
        matches!(self, RoomName::Source { .. })
    }
}

impl std::fmt::Display for RoomName {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RoomName::Material {
                material_id,
                schema,
            } => write!(f, "material:{material_id}:schema:{schema}"),
            RoomName::Source { file_id, epoch } => write!(f, "source:{file_id}:epoch:{epoch}"),
        }
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum TokenError {
    #[error("invalid collaboration token")]
    Malformed,
    #[error("unsupported collaboration token")]
    Unsupported,
    #[error("invalid collaboration token signature")]
    Signature,
    #[error("collaboration room mismatch")]
    Room,
    #[error("invalid collaboration token claims")]
    Claims,
}

#[derive(Deserialize)]
struct Header {
    alg: Option<String>,
    typ: Option<String>,
}

fn decode_part<T: for<'de> Deserialize<'de>>(part: &str) -> Result<T, TokenError> {
    let bytes = URL_SAFE_NO_PAD
        .decode(part)
        .map_err(|_| TokenError::Malformed)?;
    serde_json::from_slice(&bytes).map_err(|_| TokenError::Malformed)
}

fn sign(secret: &str, signed: &str) -> Vec<u8> {
    #[allow(clippy::expect_used)]
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC takes any key length");
    mac.update(signed.as_bytes());
    mac.finalize().into_bytes().to_vec()
}

/// `verifyCollaborationToken`.
pub fn verify(token: &str, secret: &str, room: &str, now: i64) -> Result<Claims, TokenError> {
    let parts: Vec<&str> = token.split('.').collect();
    let [header, payload, signature] = parts.as_slice() else {
        return Err(TokenError::Malformed);
    };
    let decoded: Header = decode_part(header)?;
    if decoded.alg.as_deref() != Some("HS256") || decoded.typ.as_deref() != Some("JWT") {
        return Err(TokenError::Unsupported);
    }
    let expected = sign(secret, &format!("{header}.{payload}"));
    let actual = URL_SAFE_NO_PAD
        .decode(signature)
        .map_err(|_| TokenError::Signature)?;
    if actual.len() != expected.len() || !bool::from(actual.ct_eq(&expected)) {
        return Err(TokenError::Signature);
    }
    let claims: Claims = decode_part(payload).map_err(|_| TokenError::Claims)?;
    let Some(name) = RoomName::parse(room) else {
        return Err(TokenError::Claims);
    };
    if claims.room != room || claims.schema != name.number() {
        return Err(TokenError::Room);
    }
    if name.number() < 1
        || claims.aud != "capy-collaboration"
        || claims.iss != "capy-api"
        || claims.sub.is_empty()
        || claims.jti.is_empty()
        || claims.iat > now + 30
        || claims.exp <= now
    {
        return Err(TokenError::Claims);
    }
    Ok(claims)
}

/// Signs claims (tests and tools; the Go API mints production tokens).
pub fn mint(secret: &str, claims: &Claims) -> String {
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256","typ":"JWT"}"#);
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(claims).unwrap_or_default());
    let signature = URL_SAFE_NO_PAD.encode(sign(secret, &format!("{header}.{payload}")));
    format!("{header}.{payload}.{signature}")
}

/// A test or tool token for `room`, valid `seconds` from `now`.
pub fn claims_for(room: &str, user: &str, access: Access, now: i64, seconds: i64) -> Claims {
    Claims {
        access,
        aud: "capy-collaboration".into(),
        avatar_url: None,
        exp: now + seconds,
        iat: now,
        iss: "capy-api".into(),
        jti: format!("tok_{now}_{user}"),
        name: None,
        room: room.into(),
        schema: RoomName::parse(room).map(|name| name.number()).unwrap_or(0),
        sub: user.into(),
    }
}

/// Constant-time comparison of the service secret header.
pub fn secret_matches(provided: Option<&str>, secret: &str) -> bool {
    provided.is_some_and(|value| {
        value.len() == secret.len() && bool::from(value.as_bytes().ct_eq(secret.as_bytes()))
    })
}

pub fn now_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOM: &str = "material:mat_1:schema:2";

    #[test]
    fn room_names_parse_and_print() {
        let name = RoomName::parse(ROOM).unwrap();
        assert_eq!(name.to_string(), ROOM);
        assert_eq!(name.number(), 2);
        assert!(
            RoomName::parse("source:file-1:epoch:3")
                .unwrap()
                .is_source()
        );
        for bad in [
            "material:a b:schema:1",
            "material:a:epoch:1",
            "x:a:schema:1",
            "material:a:schema:",
            "material:a:schema:1:2",
        ] {
            assert!(RoomName::parse(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn verifies_a_minted_token() {
        let now = 1_800_000_000;
        let token = mint("secret", &claims_for(ROOM, "u_1", Access::Write, now, 300));
        let claims = verify(&token, "secret", ROOM, now).unwrap();
        assert_eq!(claims.sub, "u_1");
        assert_eq!(Context::from(&claims).access, Access::Write);
    }

    #[test]
    fn rejects_wrong_rooms_expiry_access_and_signatures() {
        let now = 1_800_000_000;
        let token = mint("secret", &claims_for(ROOM, "u_1", Access::Write, now, 300));
        assert_eq!(
            verify(&token, "other", ROOM, now),
            Err(TokenError::Signature)
        );
        assert_eq!(
            verify(&token, "secret", "material:mat_1:schema:3", now),
            Err(TokenError::Room)
        );
        assert_eq!(
            verify(&token, "secret", ROOM, now + 300),
            Err(TokenError::Claims)
        );
        let early = mint(
            "secret",
            &claims_for(ROOM, "u_1", Access::Write, now + 60, 300),
        );
        assert_eq!(verify(&early, "secret", ROOM, now), Err(TokenError::Claims));
        let mut bad_access =
            serde_json::to_value(claims_for(ROOM, "u_1", Access::Read, now, 300)).unwrap();
        bad_access["access"] = "admin".into();
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256","typ":"JWT"}"#);
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&bad_access).unwrap());
        let signature = URL_SAFE_NO_PAD.encode(sign("secret", &format!("{header}.{payload}")));
        assert_eq!(
            verify(
                &format!("{header}.{payload}.{signature}"),
                "secret",
                ROOM,
                now
            ),
            Err(TokenError::Claims)
        );
        assert_eq!(
            verify("a.b", "secret", ROOM, now),
            Err(TokenError::Malformed)
        );
    }

    #[test]
    fn the_service_secret_compares_whole() {
        assert!(secret_matches(Some("abc"), "abc"));
        assert!(!secret_matches(Some("abd"), "abc"));
        assert!(!secret_matches(Some("ab"), "abc"));
        assert!(!secret_matches(None, "abc"));
    }
}
