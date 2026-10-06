//! The pin bump's seed check (seedCheck.ts; openwiki/deployment-runbook.md,
//! "Office maintenance window"): every base `office-maintenance
//! seed-manifest` names is seeded with this build's engines and the seed's
//! SHA-256 compared with the stored one. Any difference means those files
//! publish on the old engine in a maintenance window before the pin deploys.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::SourceError;
use crate::engine::EnginePool;
use crate::engine::office::calls::On;

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedManifestLine {
    #[serde(rename = "baseSourceSHA256")]
    pub base_source_sha256: String,
    pub files: u64,
    pub format: office_service::Format,
    #[serde(rename = "sourceURL")]
    pub source_url: String,
    #[serde(rename = "stateSeedSHA256")]
    pub state_seed_sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeedCheck {
    #[serde(rename = "baseSourceSHA256")]
    pub base_source_sha256: String,
    pub files: u64,
    pub format: office_service::Format,
    #[serde(rename = "stateSeedSHA256")]
    pub state_seed_sha256: String,
    /// This engine's seed hash; differs from the stored one when it changed.
    #[serde(rename = "seedSHA256")]
    pub seed_sha256: String,
}

impl SeedCheck {
    pub fn changed(&self) -> bool {
        self.seed_sha256 != self.state_seed_sha256
    }
}

/// Seeds each (format, base) once and reports every manifest line. `read`
/// downloads a base (verified against its SHA here).
pub async fn check_seeds<F, Fut>(lines: &[SeedManifestLine], engines: &EnginePool, read: F) -> Result<Vec<SeedCheck>, SourceError>
where
    F: Fn(&str) -> Fut,
    Fut: Future<Output = Result<Vec<u8>, SourceError>>,
{
    let mut seeds: HashMap<String, String> = HashMap::new();
    let mut checks = Vec::with_capacity(lines.len());
    for line in lines {
        let key = format!("{}:{}", line.format.as_str(), line.base_source_sha256);
        let seed = match seeds.get(&key) {
            Some(seed) => seed.clone(),
            None => {
                let bytes = read(&line.source_url).await?;
                if office_service::sha256_hex(&bytes) != line.base_source_sha256 {
                    return Err(SourceError::Other(format!(
                        "base {} downloaded other bytes",
                        line.base_source_sha256
                    )));
                }
                let state = engines
                    .seed(On {
                        format: line.format,
                        base: &bytes,
                        base_sha256: &line.base_source_sha256,
                        room: None,
                    })
                    .await?;
                let seed = office_service::sha256_hex(&state);
                seeds.insert(key, seed.clone());
                seed
            }
        };
        checks.push(SeedCheck {
            base_source_sha256: line.base_source_sha256.clone(),
            files: line.files,
            format: line.format,
            state_seed_sha256: line.state_seed_sha256.clone(),
            seed_sha256: seed,
        });
    }
    Ok(checks)
}

/// The report the CLI prints (one tab-separated line per base, then the
/// verdict) and whether a maintenance window is needed.
pub fn report(checks: &[SeedCheck]) -> (String, bool) {
    let mut out = String::new();
    for check in checks {
        out.push_str(&format!(
            "{}\t{}\t{}\t{} file(s)\n",
            if check.changed() { "changed" } else { "same" },
            check.format.as_str(),
            check.base_source_sha256,
            check.files
        ));
    }
    let changed: Vec<&SeedCheck> = checks.iter().filter(|check| check.changed()).collect();
    let mut formats: Vec<&str> = Vec::new();
    for check in &changed {
        if !formats.contains(&check.format.as_str()) {
            formats.push(check.format.as_str());
        }
    }
    if changed.is_empty() {
        out.push_str(&format!("{} seeds unchanged: this pin can deploy without a window\n", checks.len()));
    } else {
        out.push_str(&format!(
            "{} of {} seeds changed ({}): run the Office maintenance window before deploying this pin\n",
            changed.len(),
            checks.len(),
            formats.join(", ")
        ));
    }
    (out, !changed.is_empty())
}
