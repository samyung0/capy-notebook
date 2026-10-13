//! The fonts the browser's Office engines draw with, compiled in from the
//! fork's bundled faces: DOCX measures and paints with the chains its
//! measurement registry builds (packages/docx `TextMeasureFontRegistry` over
//! Capy's `officeFonts.ts`: the metric-compatible face, the last-resort face,
//! then each script's fallback), PPTX with the faces `pptxFonts.ts` registers.
//! The tables and rules mirror @betteroffice/fonts `manifest.ts`.

use std::collections::HashMap;

use ooxml_text::{FontId, FontStore};
use serde::Deserialize;
use serde_json::{Value, json};

macro_rules! latin {
    ($file:literal) => {
        include_bytes!(concat!(
            "../../../../../vendor/betteroffice/packages/fonts/assets/",
            $file
        ))
    };
}

macro_rules! cjk {
    ($file:literal) => {
        include_bytes!(concat!(
            "../../../../../vendor/betteroffice/packages/fonts-cjk/assets/",
            $file
        ))
    };
}

/// A bundled face: the family its name table gives, the Word family it
/// stands in for, and the script it covers as a fallback.
pub struct Face {
    family: &'static str,
    metric_compat_with: Option<&'static str>,
    bold: bool,
    italic: bool,
    script: Option<&'static str>,
    pub bytes: &'static [u8],
}

const fn face(
    family: &'static str,
    metric_compat_with: Option<&'static str>,
    bold: bool,
    italic: bool,
    script: Option<&'static str>,
    bytes: &'static [u8],
) -> Face {
    Face {
        family,
        metric_compat_with,
        bold,
        italic,
        script,
        bytes,
    }
}

/// `BUNDLED_FONTS`, in its order (a script's sans face first).
pub static BUNDLED: [Face; 30] = [
    face(
        "Carlito",
        Some("Calibri"),
        false,
        false,
        None,
        latin!("Carlito-Regular.ttf"),
    ),
    face(
        "Carlito",
        Some("Calibri"),
        true,
        false,
        None,
        latin!("Carlito-Bold.ttf"),
    ),
    face(
        "Carlito",
        Some("Calibri"),
        false,
        true,
        None,
        latin!("Carlito-Italic.ttf"),
    ),
    face(
        "Carlito",
        Some("Calibri"),
        true,
        true,
        None,
        latin!("Carlito-BoldItalic.ttf"),
    ),
    face(
        "Caladea",
        Some("Cambria"),
        false,
        false,
        None,
        latin!("Caladea-Regular.ttf"),
    ),
    face(
        "Caladea",
        Some("Cambria"),
        true,
        false,
        None,
        latin!("Caladea-Bold.ttf"),
    ),
    face(
        "Caladea",
        Some("Cambria"),
        false,
        true,
        None,
        latin!("Caladea-Italic.ttf"),
    ),
    face(
        "Caladea",
        Some("Cambria"),
        true,
        true,
        None,
        latin!("Caladea-BoldItalic.ttf"),
    ),
    face(
        "Liberation Sans",
        Some("Arial"),
        false,
        false,
        None,
        latin!("LiberationSans-Regular.ttf"),
    ),
    face(
        "Liberation Sans",
        Some("Arial"),
        true,
        false,
        None,
        latin!("LiberationSans-Bold.ttf"),
    ),
    face(
        "Liberation Sans",
        Some("Arial"),
        false,
        true,
        None,
        latin!("LiberationSans-Italic.ttf"),
    ),
    face(
        "Liberation Sans",
        Some("Arial"),
        true,
        true,
        None,
        latin!("LiberationSans-BoldItalic.ttf"),
    ),
    face(
        "Liberation Serif",
        Some("Times New Roman"),
        false,
        false,
        None,
        latin!("LiberationSerif-Regular.ttf"),
    ),
    face(
        "Liberation Serif",
        Some("Times New Roman"),
        true,
        false,
        None,
        latin!("LiberationSerif-Bold.ttf"),
    ),
    face(
        "Liberation Serif",
        Some("Times New Roman"),
        false,
        true,
        None,
        latin!("LiberationSerif-Italic.ttf"),
    ),
    face(
        "Liberation Serif",
        Some("Times New Roman"),
        true,
        true,
        None,
        latin!("LiberationSerif-BoldItalic.ttf"),
    ),
    face(
        "Liberation Mono",
        Some("Courier New"),
        false,
        false,
        None,
        latin!("LiberationMono-Regular.ttf"),
    ),
    face(
        "Liberation Mono",
        Some("Courier New"),
        true,
        false,
        None,
        latin!("LiberationMono-Bold.ttf"),
    ),
    face(
        "Liberation Mono",
        Some("Courier New"),
        false,
        true,
        None,
        latin!("LiberationMono-Italic.ttf"),
    ),
    face(
        "Liberation Mono",
        Some("Courier New"),
        true,
        true,
        None,
        latin!("LiberationMono-BoldItalic.ttf"),
    ),
    face(
        "Noto Sans Hebrew",
        None,
        false,
        false,
        Some("hebrew"),
        latin!("NotoSansHebrew-Regular.ttf"),
    ),
    face(
        "Noto Sans Hebrew",
        None,
        true,
        false,
        Some("hebrew"),
        latin!("NotoSansHebrew-Bold.ttf"),
    ),
    face(
        "Noto Sans Arabic",
        None,
        false,
        false,
        Some("arabic"),
        latin!("NotoSansArabic-Regular.ttf"),
    ),
    face(
        "Noto Sans Arabic",
        None,
        true,
        false,
        Some("arabic"),
        latin!("NotoSansArabic-Bold.ttf"),
    ),
    face(
        "Noto Naskh Arabic",
        None,
        false,
        false,
        Some("arabic"),
        latin!("NotoNaskhArabic-Regular.ttf"),
    ),
    face(
        "Noto Sans SC",
        Some("Microsoft YaHei"),
        false,
        false,
        Some("cjk-sc"),
        cjk!("NotoSansSC-Regular.otf"),
    ),
    face(
        "Noto Serif SC",
        Some("SimSun"),
        false,
        false,
        Some("cjk-sc"),
        cjk!("NotoSerifSC-Regular.otf"),
    ),
    face(
        "Noto Sans TC",
        Some("Microsoft JhengHei"),
        false,
        false,
        Some("cjk-tc"),
        cjk!("NotoSansTC-Regular.otf"),
    ),
    face(
        "Noto Sans JP",
        Some("MS Gothic"),
        false,
        false,
        Some("cjk-jp"),
        cjk!("NotoSansJP-Regular.otf"),
    ),
    face(
        "Noto Sans KR",
        Some("Malgun Gothic"),
        false,
        false,
        Some("cjk-kr"),
        cjk!("NotoSansKR-Regular.otf"),
    ),
];

/// `WORD_FAMILY_ALIASES` (keys and values lowercase).
const WORD_FAMILY_ALIASES: [(&str, &str); 43] = [
    ("helvetica", "arial"),
    ("times", "times new roman"),
    ("courier", "courier new"),
    ("simhei", "microsoft yahei"),
    ("dengxian", "microsoft yahei"),
    ("微软雅黑", "microsoft yahei"),
    ("黑体", "microsoft yahei"),
    ("等线", "microsoft yahei"),
    ("nsimsun", "simsun"),
    ("fangsong", "simsun"),
    ("kaiti", "simsun"),
    ("宋体", "simsun"),
    ("仿宋", "simsun"),
    ("楷体", "simsun"),
    ("微軟正黑體", "microsoft jhenghei"),
    ("pmingliu", "microsoft jhenghei"),
    ("mingliu", "microsoft jhenghei"),
    ("dfkai-sb", "microsoft jhenghei"),
    ("新細明體", "microsoft jhenghei"),
    ("細明體", "microsoft jhenghei"),
    ("標楷體", "microsoft jhenghei"),
    ("ms pgothic", "ms gothic"),
    ("meiryo", "ms gothic"),
    ("yu gothic", "ms gothic"),
    ("ｍｓ ゴシック", "ms gothic"),
    ("ｍｓ ｐゴシック", "ms gothic"),
    ("メイリオ", "ms gothic"),
    ("游ゴシック", "ms gothic"),
    ("ms mincho", "ms gothic"),
    ("ms pmincho", "ms gothic"),
    ("yu mincho", "ms gothic"),
    ("ｍｓ 明朝", "ms gothic"),
    ("ｍｓ ｐ明朝", "ms gothic"),
    ("游明朝", "ms gothic"),
    ("맑은 고딕", "malgun gothic"),
    ("gulim", "malgun gothic"),
    ("dotum", "malgun gothic"),
    ("batang", "malgun gothic"),
    ("gungsuh", "malgun gothic"),
    ("굴림", "malgun gothic"),
    ("돋움", "malgun gothic"),
    ("바탕", "malgun gothic"),
    ("궁서", "malgun gothic"),
];

/// `resolveMetricCompatFace`: the Word family (or an alias of one) to its
/// bundled substitute, exact style first, else the family's regular face.
pub fn metric_compat_face(word_family: &str, bold: bool, italic: bool) -> Option<&'static Face> {
    let key = word_family.trim().to_lowercase();
    let key = WORD_FAMILY_ALIASES
        .iter()
        .find(|(alias, _)| *alias == key)
        .map_or(key.as_str(), |(_, family)| family);
    let family = BUNDLED
        .iter()
        .find(|face| {
            face.metric_compat_with
                .is_some_and(|word| word.to_lowercase() == key)
        })?
        .family;
    let faces = || BUNDLED.iter().filter(move |face| face.family == family);
    faces()
        .find(|face| face.bold == bold && face.italic == italic)
        .or_else(|| faces().find(|face| !face.bold && !face.italic))
}

/// `resolveScriptFallbackFace`.
pub fn script_fallback_face(script: &str, bold: bool, italic: bool) -> Option<&'static Face> {
    let faces = || {
        BUNDLED
            .iter()
            .filter(move |face| face.script == Some(script))
    };
    faces()
        .find(|face| face.bold == bold && face.italic == italic)
        .or_else(|| faces().find(|face| face.bold == bold && !face.italic))
        .or_else(|| faces().find(|face| !face.bold && !face.italic))
        .or_else(|| faces().next())
}

/// `looksSerif`: which base face measures an unknown family.
fn looks_serif(family: &str) -> bool {
    let lower = family.to_lowercase();
    [
        "times",
        "georgia",
        "garamond",
        "palatino",
        "baskerville",
        "bodoni",
        "cambria",
        "minion",
        "mincho",
        "明朝",
        "明體",
        "宋",
        "ming",
        "song",
        "serif",
    ]
    .iter()
    .any(|word| lower.contains(word))
}

/// `resolveLastResortFace`: a heavier variant's base family in bold, else a
/// serif or sans base face.
pub fn last_resort_face(family: &str, bold: bool, italic: bool) -> &'static Face {
    let words: Vec<&str> = family
        .trim()
        .split(|c: char| c.is_whitespace() || c == '-')
        .filter(|word| !word.is_empty())
        .collect();
    if let [base @ .., last] = words.as_slice()
        && !base.is_empty()
        && [
            "black",
            "heavy",
            "extrabold",
            "ultrabold",
            "extrablack",
            "ultra",
        ]
        .contains(&last.to_lowercase().as_str())
        && let Some(face) = metric_compat_face(&base.join(" "), true, italic)
    {
        return face;
    }
    let base = if family.trim().eq_ignore_ascii_case("calibri light") {
        "Calibri"
    } else if looks_serif(family) {
        "Times New Roman"
    } else {
        "Arial"
    };
    metric_compat_face(base, bold, italic).unwrap_or(&BUNDLED[0])
}

/// One family the layout measures with (`collect_font_requirements`).
#[derive(Deserialize)]
pub struct Requirement {
    key: String,
    family: String,
    bold: bool,
    italic: bool,
    #[serde(default)]
    scripts: Vec<String>,
}

/// What the measurement store was given, in order, so a paint store gets the
/// same ids.
enum Registration {
    Face(&'static [u8]),
    Substitute(u32, String),
}

/// The measurement fonts of one DOCX layout: registered in the layout
/// engine's store and recorded, for the raster store to repeat.
#[derive(Default)]
pub struct DocxFonts {
    log: Vec<Registration>,
    chains: HashMap<String, Vec<u32>>,
}

impl DocxFonts {
    fn register(&mut self, face: &Face) -> Result<u32, String> {
        self.log.push(Registration::Face(face.bytes));
        docx_layout::register_measure_font(face.bytes)
            .map_err(|_| format!("the bundled face {} did not register", face.family))
    }

    /// `measuredAs`: the view of `base` measured as Word measures `family`.
    fn measured_as(&mut self, base: u32, family: &str) -> Result<u32, String> {
        self.log
            .push(Registration::Substitute(base, family.to_owned()));
        docx_layout::register_substitute_measure_font(base, family)
            .map_err(|_| format!("the measurement view of {family} did not register"))
    }

    /// Resolves every requirement into the engine's store and answers the
    /// layout request's `measurement` (rustMeasureSource.ts
    /// `measurementConfigForRequirements`), `settings` being the request's.
    pub fn measurement(
        &mut self,
        requirements: &[Requirement],
        settings: &Value,
    ) -> Result<Value, String> {
        docx_layout::clear_measure_fonts();
        let mut family_ids: HashMap<String, Vec<u32>> = HashMap::new();
        let mut script_ids: HashMap<String, Option<u32>> = HashMap::new();
        for requirement in requirements {
            let key = format!(
                "{}|{}|{}",
                requirement.family.trim().to_lowercase(),
                u8::from(requirement.bold),
                u8::from(requirement.italic)
            );
            if !family_ids.contains_key(&key) {
                let mut ids = Vec::new();
                let (family, bold, italic) =
                    (&requirement.family, requirement.bold, requirement.italic);
                if let Some(face) = metric_compat_face(family, bold, italic) {
                    let base = self.register(face)?;
                    ids.push(self.measured_as(base, family)?);
                }
                let base = self.register(last_resort_face(family, bold, italic))?;
                let id = self.measured_as(base, family)?;
                if !ids.contains(&id) {
                    ids.push(id);
                }
                family_ids.insert(key.clone(), ids);
            }
            let mut chain = family_ids[&key].clone();
            for script in &requirement.scripts {
                if !script_ids.contains_key(script) {
                    let id = match script_fallback_face(script, false, false) {
                        Some(face) => Some(self.register(face)?),
                        None => None,
                    };
                    script_ids.insert(script.clone(), id);
                }
                if let Some(id) = script_ids[script]
                    && !chain.contains(&id)
                {
                    chain.push(id);
                }
            }
            if !chain.is_empty() {
                self.chains.insert(requirement.key.clone(), chain);
            }
        }
        let flag = |name: &str| {
            settings["compatibilityFlags"][name]
                .as_bool()
                .unwrap_or(false)
        };
        Ok(json!({
            "fontChains": self.chains,
            "defaults": { "fontSize": 11, "fontFamily": "Calibri" },
            "compat": {
                "noLeading": flag("noLeading"),
                "doNotExpandShiftReturn": flag("doNotExpandShiftReturn"),
            },
            "authoritativeShaping": true,
        }))
    }

    /// A store holding what the engine's store holds, under the same ids, and
    /// the chains the display list's runs name.
    pub fn paint_store(&self) -> Result<(FontStore, HashMap<String, Vec<FontId>>), String> {
        let mut store = FontStore::new();
        for registration in &self.log {
            match registration {
                Registration::Face(bytes) => {
                    if store.find(bytes).is_none() {
                        store
                            .register(bytes.to_vec())
                            .map_err(|error| error.to_string())?;
                    }
                }
                Registration::Substitute(base, family) => {
                    if let Some(metrics) = ooxml_text::word_fonts::requested_line_metrics(family) {
                        store
                            .register_substitute(FontId::from_u32(*base), metrics)
                            .map_err(|error| error.to_string())?;
                    }
                }
            }
        }
        let chains = self
            .chains
            .iter()
            .map(|(key, ids)| {
                (
                    key.clone(),
                    ids.iter().copied().map(FontId::from_u32).collect(),
                )
            })
            .collect();
        Ok((store, chains))
    }
}

/// The faces Capy's PPTX editor registers (`pptxFonts.ts`): Liberation Sans
/// as Arial, Caladea as Cambria.
pub fn pptx_faces() -> impl Iterator<Item = (&'static str, &'static Face)> {
    let arial = BUNDLED[8..12].iter().map(|face| ("Arial", face));
    arial.chain(BUNDLED[4..8].iter().map(|face| ("Cambria", face)))
}

impl Face {
    pub fn bold(&self) -> bool {
        self.bold
    }

    pub fn italic(&self) -> bool {
        self.italic
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn named(face: Option<&Face>) -> Option<(&str, bool, bool)> {
        face.map(|face| (face.family, face.bold, face.italic))
    }

    // The resolutions manifest.ts makes (its own tests' cases).
    #[test]
    fn faces_resolve_as_the_bundled_manifest_resolves_them() {
        assert_eq!(
            named(metric_compat_face("Calibri", true, false)),
            Some(("Carlito", true, false))
        );
        assert_eq!(
            named(metric_compat_face(" HELVETICA ", false, true)),
            Some(("Liberation Sans", false, true))
        );
        assert_eq!(
            named(metric_compat_face("宋体", true, false)),
            Some(("Noto Serif SC", false, false))
        );
        assert_eq!(
            named(metric_compat_face("Comic Sans MS", false, false)),
            None
        );
        assert_eq!(
            named(Some(last_resort_face("Garamond", false, false))),
            Some(("Liberation Serif", false, false))
        );
        assert_eq!(
            named(Some(last_resort_face("Segoe UI", true, false))),
            Some(("Liberation Sans", true, false))
        );
        assert_eq!(
            named(Some(last_resort_face("Calibri Light", false, false))),
            Some(("Carlito", false, false))
        );
        assert_eq!(
            named(Some(last_resort_face("Arial Black", false, true))),
            Some(("Liberation Sans", true, true))
        );
        assert_eq!(
            named(script_fallback_face("arabic", true, false)),
            Some(("Noto Sans Arabic", true, false))
        );
        assert_eq!(
            named(script_fallback_face("cjk-jp", true, true)),
            Some(("Noto Sans JP", false, false))
        );
        assert_eq!(named(script_fallback_face("latin", false, false)), None);
    }
}
