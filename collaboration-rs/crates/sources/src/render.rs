//! Page 1 of an Office source as the browser's list-card capture draws it
//! (src/office-runtime/thumbnail.ts, pptxRender.ts, xlsxRender.ts), natively:
//! the fork's own layout engines and rasterizers, in an engine process, with
//! the faces the browser's engines measure and paint with (`fonts`). DOCX
//! page 1 and PPTX slide 1 come out 200 px wide, cut at 400 px; XLSX shows
//! the first sheet's top-left 800 x 550 sheet px at a quarter scale. Encoded
//! as the browser encodes it: lossy WebP at quality 60 through libwebp, its
//! image chunk alone.

mod fonts;

use docx_parse::S9PackageWire;
use docx_parse::section::SectionProperties;
use image::RgbImage;
use image::imageops::FilterType;
use office_service::{Checkpoint, Determinism, Format};
use serde_json::{Value, json};

/// The capture's width and the height it is cut at (`thumbnail.ts`).
pub const WIDTH: u32 = 200;
pub const MAX_HEIGHT: u32 = 400;
const QUALITY: f32 = 60.0;
/// The XLSX capture area (xlsxRender.ts `THUMBNAIL_AREA`), in sheet px.
const SHEET_AREA: (f32, f32) = (800.0, 550.0);
/// The collaboration client the render's throwaway documents write as.
const CLIENT: u64 = 1;

/// The WebP of page 1 of `state`, the whole document over `base` (DOCX
/// exports it first with `determinism`).
pub fn page_one(
    format: Format,
    base: &[u8],
    base_sha256: &str,
    state: &[u8],
    determinism: Determinism<'_>,
) -> Result<Vec<u8>, String> {
    let image = match format {
        Format::Docx => {
            let checkpoint = Checkpoint {
                format,
                schema_version: 1,
                base_sha256,
                state,
            };
            let bytes = office_service::export(base, checkpoint, determinism)
                .map_err(|error| error.to_string())?;
            docx(&bytes)?
        }
        Format::Pptx => pptx(base, state)?,
        Format::Xlsx => xlsx(base, state)?,
    };
    let webp =
        webp::Encoder::from_rgb(image.as_raw(), image.width(), image.height()).encode(QUALITY);
    Ok(webp.to_vec())
}

/// `image` `WIDTH` wide (its height in proportion, rounded as a canvas
/// rounds it), cut at `MAX_HEIGHT` from the top.
fn fit(image: &RgbImage) -> RgbImage {
    let height = (f64::from(image.height()) * f64::from(WIDTH) / f64::from(image.width()))
        .round()
        .max(1.0) as u32;
    let scaled = image::imageops::resize(image, WIDTH, height, FilterType::Lanczos3);
    image::imageops::crop_imm(&scaled, 0, 0, WIDTH, height.min(MAX_HEIGHT)).to_image()
}

fn png(bytes: &[u8]) -> Result<RgbImage, String> {
    image::load_from_memory_with_format(bytes, image::ImageFormat::Png)
        .map(|image| image.to_rgb8())
        .map_err(|error| error.to_string())
}

/// DOCX page 1 as the viewer lays it out (packages/docx `openDocumentViewer`
/// over docx-view-wasm): the region request, the fonts its requirements
/// name, the region pass, the first page's display list; then docx-raster.
fn docx(bytes: &[u8]) -> Result<RgbImage, String> {
    let envelope = docx_edit::parse_docx_for_edit(bytes)?;
    let mut request = layout_request(&envelope.document.package);
    let engine = docx_edit::EngineSession::new(CLIENT);
    engine.set_media(docx_edit::package_media(&envelope));
    docx_edit::seed_parsed_docx_in_place(engine.doc(), envelope)?;
    let requirements: Vec<fonts::Requirement> =
        serde_json::from_str(&engine.layout_font_requirements_json(&request.to_string())?)
            .map_err(|error| error.to_string())?;
    let mut faces = fonts::DocxFonts::default();
    request["measurement"] = faces.measurement(&requirements, &request["regions"]["settings"])?;
    if engine.layout_document_with_regions(&request.to_string())? == 0 {
        return Err("the document lays out no page".into());
    }
    let extras = json!({ "fontChains": request["measurement"]["fontChains"] });
    let mut display = engine.region_display_input(&extras.to_string())?;
    let list: docx_layout::display_list::DisplayList =
        serde_json::from_str(&engine.display_pages_json(&mut display, 0..1)?)
            .map_err(|error| error.to_string())?;
    let (store, chains) = faces.paint_store()?;
    let images = docx_raster::ImageMap::new();
    let page = docx_raster::render_page(
        &list,
        0,
        &docx_raster::RenderResources::new(&store, &chains, &images),
    )?;
    Ok(fit(&png(&page.bytes)?))
}

/// docx-view-wasm `layout_request` (which mirrors packages/docx
/// `buildResidentRegionLayoutRequest`): the region-layout request without
/// its `measurement`.
fn layout_request(package: &S9PackageWire) -> Value {
    let body = &package.document;
    let body_sections = body.sections.as_deref().unwrap_or_default();
    let mut sections = body_sections
        .iter()
        .map(|section| {
            section_entry(
                section
                    .id
                    .as_ref()
                    .or(section.properties.section_id.as_ref()),
                &section.properties,
            )
        })
        .collect::<Vec<_>>();
    let final_id = sections
        .last()
        .and_then(|section| section.get("sectionId"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| {
            body.final_section_properties
                .as_ref()
                .and_then(|properties| properties.section_id.clone())
        });
    let final_properties = body_sections
        .last()
        .map(|section| &section.properties)
        .or(body.final_section_properties.as_ref())
        .cloned()
        .unwrap_or_default();
    sections.push(section_entry(final_id.as_ref(), &final_properties));

    let normal = |kind: &str| kind.is_empty() || kind == "normal";
    let notes = package
        .footnotes
        .as_deref()
        .unwrap_or_default()
        .iter()
        .filter(|note| normal(&note.note_type))
        // Note ids parse as f64; the layout request reads them as integers.
        .map(|note| json!({ "id": note.id as i64, "noteKind": "footnote", "height": 0 }))
        .chain(
            package
                .endnotes
                .as_deref()
                .unwrap_or_default()
                .iter()
                .filter(|note| normal(&note.note_type))
                .map(|note| json!({ "id": note.id as i64, "noteKind": "endnote", "height": 0 })),
        )
        .collect::<Vec<_>>();

    let styles = package
        .styles
        .as_ref()
        .map(|styles| styles.styles.as_slice())
        .unwrap_or_default();
    let paragraph_styles = || {
        styles
            .iter()
            .filter(|style| style.style_type == "paragraph" && !style.style_id.is_empty())
    };
    let mut toc_style_ids = Vec::<&str>::new();
    for style in paragraph_styles() {
        let toc = std::iter::once(style.style_id.as_str())
            .chain(style.name.as_deref())
            .any(is_toc_style_name);
        if toc && !toc_style_ids.contains(&style.style_id.as_str()) {
            toc_style_ids.push(&style.style_id);
        }
    }
    let default_paragraph_style_id = paragraph_styles()
        .find(|style| style.default == Some(true))
        .map(|style| style.style_id.as_str())
        .or_else(|| {
            paragraph_styles()
                .any(|style| style.style_id == "Normal")
                .then_some("Normal")
        });

    let theme_colors = serde_json::to_value(&package.theme.color_scheme).unwrap_or_default();
    let settings = serde_json::to_value(&package.settings).unwrap_or_default();
    let default_tab_stop = settings
        .get("defaultTabStop")
        .cloned()
        .unwrap_or(Value::Null);
    let mut render_env = json!({
        "themeColors": theme_colors,
        "defaultTabStopTwips": default_tab_stop,
        "numericIds": {},
        "tocStyleIds": toc_style_ids,
    });
    if let Some(id) = default_paragraph_style_id {
        render_env["defaultParagraphStyleId"] = json!(id);
    }
    json!({
        "bodyStory": "body",
        "options": { "pageGap": 24.0 },
        "regions": { "sections": sections, "settings": settings },
        "notes": { "contents": notes },
        "renderEnv": render_env,
    })
}

fn section_entry(section_id: Option<&String>, properties: &SectionProperties) -> Value {
    let mut entry = json!({ "properties": properties });
    if let Some(id) = section_id {
        entry["sectionId"] = json!(id);
    }
    entry
}

/// `/^TOC\s*\d+$/i`
fn is_toc_style_name(name: &str) -> bool {
    let Some(rest) = name
        .get(..3)
        .filter(|prefix| prefix.eq_ignore_ascii_case("toc"))
        .map(|_| name[3..].trim_start())
    else {
        return false;
    };
    !rest.is_empty() && rest.bytes().all(|byte| byte.is_ascii_digit())
}

/// PPTX slide 1 as the editor lays it out (packages/pptx `openPresentation`
/// with Capy's faces, then the deck's embedded ones), painted at the
/// capture's scale as `slideThumbnail` paints it.
fn pptx(base: &[u8], state: &[u8]) -> Result<RgbImage, String> {
    let deck = pptx_edit::DeckSession::open_from_update_with_source(state, base, CLIENT)
        .map_err(|error| error.to_string())?;
    let scope = deck.slide_scope(0).map_err(|error| error.to_string())?;
    let mut renderer = pptx_render::SlideRenderer::new();
    for (family, face) in fonts::pptx_faces() {
        renderer
            .register_font(family, face.bold(), face.italic(), face.bytes)
            .map_err(|error| error.to_string())?;
    }
    renderer.register_embedded_fonts(deck.package());
    let rendered = renderer
        .layout_scoped_slide(deck.package(), &scope)
        .map_err(|error| error.to_string())?;
    let list = &rendered.display_list;
    let pending = list
        .primitives
        .iter()
        .filter_map(|primitive| match primitive {
            pptx_render::Primitive::Image {
                asset_id: Some(id), ..
            } if id.starts_with("pending-media:") => Some(id.as_str()),
            _ => None,
        })
        .map(|id| deck.media_bytes(id).map(|bytes| (id, bytes)))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let mut images: pptx_raster::AssetMap<'_> = deck
        .package()
        .media
        .iter()
        .map(|part| (part.part_path.as_str(), part.bytes.as_slice()))
        .collect();
    images.extend(pending.iter().map(|(id, bytes)| (*id, bytes.as_slice())));
    // The capture's scale, a hair under so the surface's ceiling is WIDTH.
    let scale = (WIDTH as f32 - 1e-3) / list.width;
    let slide = pptx_raster::render_slide(
        list,
        &pptx_raster::RenderResources::new(renderer.fonts(), &images)
            .with_label_font(renderer.fallback_font()),
        &pptx_raster::RenderOptions {
            scale,
            ..Default::default()
        },
    )?;
    let image = png(&slide.bytes)?;
    let height = (f64::from(list.height) * f64::from(WIDTH) / f64::from(list.width))
        .round()
        .clamp(1.0, f64::from(MAX_HEIGHT)) as u32;
    Ok(image::imageops::crop_imm(&image, 0, 0, WIDTH, height.min(image.height())).to_image())
}

/// The XLSX first sheet's top-left as the workbook worker draws it
/// (`displayList` of `THUMBNAIL_AREA`, recalculated at this moment's clock),
/// painted by xlsx-raster and drawn down to a quarter.
fn xlsx(base: &[u8], state: &[u8]) -> Result<RgbImage, String> {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis() as f64;
    let options = betteroffice_xlsx::CalculationOptions {
        now_serial: Some(now_ms / 86_400_000.0 + 25_569.0),
    };
    let mut workbook =
        betteroffice_xlsx::Workbook::open_collaborative_recalculated(base, CLIENT, options)
            .map_err(|error| error.to_string())?;
    workbook
        .apply_update_v1(state, options)
        .map_err(|error| error.to_string())?;
    let area = betteroffice_xlsx::Viewport {
        x: 0.0,
        y: 0.0,
        width: SHEET_AREA.0,
        height: SHEET_AREA.1,
    };
    let list = workbook
        .display_list_for(betteroffice_xlsx::SheetId(0), &area)
        .map_err(|error| error.to_string())?;
    Ok(fit(&png(&xlsx_raster::render_png(&list)?)?))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn fixture(path: &str) -> Vec<u8> {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        std::fs::read(root.join(path)).unwrap()
    }

    /// The WebP's chunks: Go takes one image chunk alone, sized to its end.
    fn chunks(webp: &[u8]) -> Vec<String> {
        assert_eq!(&webp[..4], b"RIFF");
        assert_eq!(&webp[8..12], b"WEBP");
        let riff = u32::from_le_bytes(webp[4..8].try_into().unwrap()) as usize;
        assert_eq!(riff + 8, webp.len());
        let (mut at, mut ids) = (12, Vec::new());
        while at < webp.len() {
            let size = u32::from_le_bytes(webp[at + 4..at + 8].try_into().unwrap()) as usize;
            ids.push(String::from_utf8_lossy(&webp[at..at + 4]).into_owned());
            at += 8 + size + size % 2;
        }
        assert_eq!(at, webp.len());
        ids
    }

    /// The VP8 key frame's size (image is built without a WebP decoder).
    fn size(webp: &[u8]) -> (u32, u32) {
        let frame = &webp[20..];
        assert_eq!(&frame[3..6], [0x9d, 0x01, 0x2a], "a VP8 key frame");
        let width = u32::from(u16::from_le_bytes([frame[6], frame[7]]) & 0x3fff);
        let height = u32::from(u16::from_le_bytes([frame[8], frame[9]]) & 0x3fff);
        (width, height)
    }

    fn seed(format: Format, base: &[u8]) -> Vec<u8> {
        office_service::seed(format, base).unwrap()
    }

    // Each format's capture has the browser capture's size and a layout Go
    // takes: one lossy image chunk.
    #[test]
    fn page_one_has_the_browser_captures_size() {
        let determinism = Determinism {
            seed: &"a".repeat(64),
            now: "2000-01-01T00:00:00.000Z",
        };
        for (format, path, expected) in [
            // Letter, as the browser's 200 x 259.
            (
                Format::Docx,
                "e2e/fixtures/files/basic/lesson.docx",
                (200, 259),
            ),
            // A 4:3 deck, as 200 x 150.
            (
                Format::Pptx,
                "e2e/fixtures/files/basic/lesson.pptx",
                (200, 150),
            ),
            // 800 x 550 sheet px at a quarter, as 200 x 138.
            (
                Format::Xlsx,
                "e2e/fixtures/files/basic/grades.xlsx",
                (200, 138),
            ),
        ] {
            let base = fixture(path);
            let sha = office_service::sha256_hex(&base);
            let webp = page_one(format, &base, &sha, &seed(format, &base), determinism).unwrap();
            assert_eq!(chunks(&webp), ["VP8 "], "{path}");
            assert_eq!(size(&webp), expected, "{path}");
            assert!(webp.len() < 64 << 10, "{path}: {} bytes", webp.len());
        }
    }
}
