//! Agent markdown → a material document with the editor's own markdown
//! import (`collaboration/src/markdown.ts`, `src/features/notes/markdownConvert.ts`),
//! so the nodes match what a paste gives. The import (Plate's deserializer on
//! the remark pipeline, about 1.7 MB of bundled JS) runs in an embedded
//! QuickJS: the same entry bundled by `markdown/build.mjs` for a worker-like
//! runtime. The server loads the bundle once and keeps the converter.

use rquickjs::loader::{BuiltinLoader, BuiltinResolver};
use rquickjs::{CatchResultExt, CaughtError, Context, Function, Module, Runtime};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use crate::plate::Content;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Embedded {
    Quiz { questions: Vec<Value> },
    Flashcards { cards: Vec<Card> },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Card {
    pub back: String,
    pub front: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Converted {
    pub document: Content,
    /// A quiz or flashcard set per fence, in depth-first document order.
    pub embedded: Vec<Embedded>,
}

/// The fence that did not parse, or the engine failing.
#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct MarkdownError(pub String);

/// The converter's globals: `console` (the import may warn),
/// `crypto.getRandomValues` (id generation) and the WHATWG `URL` (link and
/// embed checks), parsed natively by the `url` crate (`__parseUrl`).
const PRELUDE: &str = r#"
const ignore = () => {};
globalThis.console = { log: ignore, info: ignore, warn: ignore, error: ignore, debug: ignore };
globalThis.crypto = {
  getRandomValues(array) {
    for (let i = 0; i < array.length; i++) array[i] = Math.floor(Math.random() * 256);
    return array;
  },
};
class URLSearchParams {
  constructor(search = '') {
    this.entries_ = String(search).replace(/^\?/, '').split('&').filter(Boolean).map((pair) => {
      const at = pair.indexOf('=');
      const decode = (v) => decodeURIComponent(v.replace(/\+/g, ' '));
      return at < 0 ? [decode(pair), ''] : [decode(pair.slice(0, at)), decode(pair.slice(at + 1))];
    });
  }
  get(name) { const found = this.entries_.find(([k]) => k === name); return found ? found[1] : null; }
  getAll(name) { return this.entries_.filter(([k]) => k === name).map(([, v]) => v); }
  has(name) { return this.entries_.some(([k]) => k === name); }
}
const URL_FIELDS = ['href', 'protocol', 'username', 'password', 'host', 'hostname', 'port', 'pathname', 'search', 'hash', 'origin'];
class URL {
  constructor(input, base) {
    const parts = base === undefined ? __parseUrl(String(input)) : __parseUrl(String(input), String(base));
    URL_FIELDS.forEach((field, i) => { this[field] = parts[i]; });
    this.searchParams = new URLSearchParams(this.search);
  }
  toString() { return this.href; }
  toJSON() { return this.href; }
  static canParse(input, base) { try { new URL(input, base); return true; } catch { return false; } }
}
globalThis.URL = URL;
globalThis.URLSearchParams = URLSearchParams;
"#;

/// `new URL(input, base)`'s fields, or a TypeError.
fn parse_url<'js>(
    ctx: rquickjs::Ctx<'js>,
    input: String,
    base: rquickjs::prelude::Opt<String>,
) -> rquickjs::Result<Vec<String>> {
    let invalid = |ctx: &rquickjs::Ctx<'js>| rquickjs::Exception::throw_type(ctx, "Invalid URL");
    let base = match base.0 {
        Some(base) => Some(url::Url::parse(&base).map_err(|_| invalid(&ctx))?),
        None => None,
    };
    let url = url::Url::options()
        .base_url(base.as_ref())
        .parse(&input)
        .map_err(|_| invalid(&ctx))?;
    let prefixed = |prefix: &str, part: Option<&str>| {
        part.filter(|p| !p.is_empty())
            .map_or(String::new(), |p| format!("{prefix}{p}"))
    };
    let hostname = url.host_str().unwrap_or("").to_owned();
    let port = url.port().map_or(String::new(), |p| p.to_string());
    Ok(vec![
        url.as_str().to_owned(),
        format!("{}:", url.scheme()),
        url.username().to_owned(),
        url.password().unwrap_or("").to_owned(),
        if port.is_empty() {
            hostname.clone()
        } else {
            format!("{hostname}:{port}")
        },
        hostname,
        port,
        url.path().to_owned(),
        prefixed("?", url.query()),
        prefixed("#", url.fragment()),
        url.origin().ascii_serialization(),
    ])
}

/// One QuickJS runtime holding the loaded import.
pub struct Converter {
    context: Context,
    _runtime: Runtime,
}

fn caught(error: CaughtError<'_>) -> MarkdownError {
    match error {
        CaughtError::Error(error) => MarkdownError(error.to_string()),
        CaughtError::Exception(exception) => {
            MarkdownError(exception.message().unwrap_or_else(|| exception.to_string()))
        }
        CaughtError::Value(value) => MarkdownError(format!("{value:?}")),
    }
}

impl Converter {
    /// Loads the bundle (about 0.4 s).
    pub fn new(bundle: &str) -> Result<Self, MarkdownError> {
        let runtime = Runtime::new().map_err(|e| MarkdownError(e.to_string()))?;
        runtime.set_loader(BuiltinResolver::default(), BuiltinLoader::default());
        let context = Context::full(&runtime).map_err(|e| MarkdownError(e.to_string()))?;
        context.with(|ctx| -> Result<(), MarkdownError> {
            let parse = Function::new(ctx.clone(), parse_url)
                .catch(&ctx)
                .map_err(caught)?;
            ctx.globals()
                .set("__parseUrl", parse)
                .catch(&ctx)
                .map_err(caught)?;
            let () = ctx.eval(PRELUDE).catch(&ctx).map_err(caught)?;
            let module = Module::declare(ctx.clone(), "markdown.bundle.mjs", bundle)
                .catch(&ctx)
                .map_err(caught)?;
            let (module, promise) = module.eval().catch(&ctx).map_err(caught)?;
            promise.finish::<()>().catch(&ctx).map_err(caught)?;
            let convert: Function = module
                .get("convertAgentMarkdown")
                .catch(&ctx)
                .map_err(caught)?;
            ctx.globals()
                .set("__convertAgentMarkdown", convert)
                .catch(&ctx)
                .map_err(caught)?;
            Ok(())
        })?;
        Ok(Converter {
            context,
            _runtime: runtime,
        })
    }

    /// `convertAgentMarkdown(source)`: the document and a draft per quiz or
    /// flashcards fence. A fence that does not parse is an error naming it.
    pub fn convert(&self, source: &str) -> Result<Converted, MarkdownError> {
        let json = self.context.with(|ctx| -> Result<String, MarkdownError> {
            let convert: Function = ctx
                .globals()
                .get("__convertAgentMarkdown")
                .catch(&ctx)
                .map_err(caught)?;
            let result: rquickjs::Value = convert.call((source,)).catch(&ctx).map_err(caught)?;
            let json = ctx.json_stringify(result).catch(&ctx).map_err(caught)?;
            json.map(|s| s.to_string().map_err(|e| MarkdownError(e.to_string())))
                .transpose()?
                .ok_or_else(|| MarkdownError("the import returned nothing".into()))
        })?;
        serde_json::from_str(&json).map_err(|e| MarkdownError(e.to_string()))
    }
}
