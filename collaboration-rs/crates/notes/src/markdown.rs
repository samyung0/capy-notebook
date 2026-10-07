//! Agent markdown → a material document with the editor's own markdown
//! import (`collaboration/src/markdown.ts`, `src/features/notes/markdownConvert.ts`),
//! so the nodes match what a paste gives. The import (Plate's deserializer on
//! the remark pipeline, about 1.7 MB of bundled JS) runs in an embedded V8:
//! the same entry bundled by `markdown/build.mjs` as one script. The server
//! loads the bundle once and keeps the converter.
//!
//! Limits (Epo, 2026-10-07): input over [MAX_INPUT_BYTES] is refused, and a
//! conversion stops after [TIME_LIMIT] or at [HEAP_LIMIT] of JS heap. Each
//! is its own [MarkdownError]; the caller fails the edit, no retry.

use std::cell::RefCell;
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Once};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use crate::plate::Content;

/// Input over this many bytes (UTF-8) is refused: 1 MiB.
pub const MAX_INPUT_BYTES: usize = 1 << 20;
/// A conversion stops after this long.
pub const TIME_LIMIT: Duration = Duration::from_secs(10);
/// A conversion stops when the engine's JS heap reaches this: 512 MiB.
pub const HEAP_LIMIT: usize = 512 << 20;

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

#[derive(Debug, thiserror::Error)]
pub enum MarkdownError {
    #[error("markdown is {bytes} bytes, over the {MAX_INPUT_BYTES}-byte limit")]
    TooLarge { bytes: usize },
    #[error("markdown conversion stopped after {} s", TIME_LIMIT.as_secs())]
    TimedOut,
    #[error("markdown conversion stopped at the {} MiB memory limit", HEAP_LIMIT >> 20)]
    OutOfMemory,
    /// The import threw: a fence that does not parse names itself here.
    #[error("{0}")]
    Invalid(String),
    /// The bundle did not load, or the engine answered something unexpected.
    #[error("markdown engine: {0}")]
    Engine(String),
}

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

/// `new URL(input, base)`'s fields in `URL_FIELDS` order, or `None` (a
/// TypeError in JS).
fn url_fields(input: &str, base: Option<&str>) -> Option<Vec<String>> {
    let base = match base {
        Some(base) => Some(url::Url::parse(base).ok()?),
        None => None,
    };
    let url = url::Url::options()
        .base_url(base.as_ref())
        .parse(input)
        .ok()?;
    let prefixed = |prefix: &str, part: Option<&str>| {
        part.filter(|p| !p.is_empty())
            .map_or(String::new(), |p| format!("{prefix}{p}"))
    };
    let hostname = url.host_str().unwrap_or("").to_owned();
    let port = url.port().map_or(String::new(), |p| p.to_string());
    Some(vec![
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

fn parse_url(
    scope: &mut v8::PinScope,
    args: v8::FunctionCallbackArguments,
    mut result: v8::ReturnValue,
) {
    let input = args.get(0).to_rust_string_lossy(scope);
    let base = (args.length() > 1).then(|| args.get(1).to_rust_string_lossy(scope));
    match url_fields(&input, base.as_deref()) {
        Some(fields) => {
            let fields: Vec<v8::Local<v8::Value>> = fields
                .iter()
                .filter_map(|field| v8::String::new(scope, field).map(Into::into))
                .collect();
            result.set(v8::Array::new_with_elements(scope, &fields).into());
        }
        None => {
            let message =
                v8::String::new(scope, "Invalid URL").unwrap_or_else(|| v8::String::empty(scope));
            let error = v8::Exception::type_error(scope, message);
            scope.throw_exception(error);
        }
    }
}

fn init_v8() {
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        // Intl and the `\p{…}` classes micromark's regexps use read ICU data.
        if let Err(code) = v8::icu::set_common_data_78(deno_core_icudata::ICU_DATA) {
            panic!("ICU data refused by V8 ({code})");
        }
        let platform = v8::new_default_platform(0, false).make_shared();
        v8::V8::initialize_platform(platform);
        v8::V8::initialize();
    });
}

/// The engine thread's isolate, for the near-heap-limit callback (which V8
/// calls on that thread).
struct Limits {
    handle: v8::IsolateHandle,
    out_of_memory: AtomicBool,
}

thread_local! {
    static LIMITS: RefCell<Option<Arc<Limits>>> = const { RefCell::new(None) };
}

/// Near the heap limit: stop the script and give it room to unwind; the
/// isolate is dropped after the call.
extern "C" fn near_heap_limit(_data: *mut c_void, current: usize, _initial: usize) -> usize {
    LIMITS.with_borrow(|limits| {
        if let Some(limits) = limits {
            limits.out_of_memory.store(true, Ordering::SeqCst);
            limits.handle.terminate_execution();
        }
    });
    current.saturating_mul(2)
}

/// One isolate with the import loaded. Fields drop in order: the handles
/// before the isolate.
struct Engine {
    convert: v8::Global<v8::Function>,
    context: v8::Global<v8::Context>,
    isolate: v8::OwnedIsolate,
    limits: Arc<Limits>,
}

fn message(scope: &mut v8::PinScope, exception: Option<v8::Local<v8::Value>>) -> String {
    let Some(exception) = exception else {
        return "no exception".into();
    };
    if let Ok(object) = v8::Local::<v8::Object>::try_from(exception)
        && let Some(key) = v8::String::new(scope, "message")
        && let Some(text) = object.get(scope, key.into())
        && text.is_string()
    {
        return text.to_rust_string_lossy(scope);
    }
    exception.to_rust_string_lossy(scope)
}

impl Engine {
    fn load(bundle: &str) -> Result<Self, MarkdownError> {
        let failed = |what: &str| MarkdownError::Engine(what.to_owned());
        let mut isolate = v8::Isolate::new(v8::CreateParams::default().heap_limits(0, HEAP_LIMIT));
        let limits = Arc::new(Limits {
            handle: isolate.thread_safe_handle(),
            out_of_memory: AtomicBool::new(false),
        });
        LIMITS.set(Some(limits.clone()));
        isolate.add_near_heap_limit_callback(near_heap_limit, std::ptr::null_mut());
        let (context, convert) = {
            v8::scope!(let scope, &mut isolate);
            let context = v8::Context::new(scope, Default::default());
            let scope = &mut v8::ContextScope::new(scope, context);
            v8::tc_scope!(let tc, scope);
            let global = context.global(tc);
            let parse = v8::Function::new(tc, parse_url).ok_or_else(|| failed("__parseUrl"))?;
            let key = v8::String::new(tc, "__parseUrl").ok_or_else(|| failed("__parseUrl"))?;
            global
                .set(tc, key.into(), parse.into())
                .ok_or_else(|| failed("__parseUrl"))?;
            for (name, source) in [("prelude", PRELUDE), ("bundle", bundle)] {
                let code = v8::String::new(tc, source).ok_or_else(|| failed(name))?;
                let ran = v8::Script::compile(tc, code, None).and_then(|script| script.run(tc));
                if ran.is_none() {
                    let exception = tc.exception();
                    return Err(MarkdownError::Engine(format!(
                        "{name}: {}",
                        message(tc, exception)
                    )));
                }
            }
            let key = v8::String::new(tc, "__markdown").ok_or_else(|| failed("__markdown"))?;
            let exports = global
                .get(tc, key.into())
                .and_then(|value| v8::Local::<v8::Object>::try_from(value).ok())
                .ok_or_else(|| failed("the bundle set no __markdown"))?;
            let key =
                v8::String::new(tc, "convertAgentMarkdown").ok_or_else(|| failed("convert"))?;
            let convert = exports
                .get(tc, key.into())
                .and_then(|value| v8::Local::<v8::Function>::try_from(value).ok())
                .ok_or_else(|| failed("the bundle exports no convertAgentMarkdown"))?;
            (v8::Global::new(tc, context), v8::Global::new(tc, convert))
        };
        Ok(Engine {
            convert,
            context,
            isolate,
            limits,
        })
    }

    /// One conversion under the time limit. `false` beside the result: a
    /// limit tripped and the isolate must not be reused.
    fn convert(&mut self, source: &str) -> (Result<Converted, MarkdownError>, bool) {
        let (done, wait) = mpsc::channel::<()>();
        let handle = self.isolate.thread_safe_handle();
        let fired = Arc::new(AtomicBool::new(false));
        let watchdog = {
            let fired = fired.clone();
            thread::spawn(move || {
                if let Err(RecvTimeoutError::Timeout) = wait.recv_timeout(TIME_LIMIT) {
                    fired.store(true, Ordering::SeqCst);
                    handle.terminate_execution();
                }
            })
        };
        let outcome = self.call(source);
        drop(done);
        let _ = watchdog.join();
        let timed_out = fired.load(Ordering::SeqCst);
        let out_of_memory = self.limits.out_of_memory.load(Ordering::SeqCst);
        let result = match outcome {
            Ok(json) => {
                serde_json::from_str(&json).map_err(|e| MarkdownError::Engine(e.to_string()))
            }
            Err(_) if out_of_memory => Err(MarkdownError::OutOfMemory),
            Err(_) if timed_out => Err(MarkdownError::TimedOut),
            Err(error) => Err(error),
        };
        (result, !(timed_out || out_of_memory))
    }

    /// `JSON.stringify(convertAgentMarkdown(source))`.
    fn call(&mut self, source: &str) -> Result<String, MarkdownError> {
        v8::scope!(let scope, &mut self.isolate);
        let context = v8::Local::new(scope, &self.context);
        let scope = &mut v8::ContextScope::new(scope, context);
        v8::tc_scope!(let tc, scope);
        let convert = v8::Local::new(tc, &self.convert);
        let input = v8::String::new(tc, source)
            .ok_or_else(|| MarkdownError::Engine("the source does not fit a JS string".into()))?;
        let receiver = v8::undefined(tc).into();
        let json = convert
            .call(tc, receiver, &[input.into()])
            .and_then(|value| v8::json::stringify(tc, value));
        match json {
            Some(json) => Ok(json.to_rust_string_lossy(tc)),
            None if tc.has_terminated() => Err(MarkdownError::Engine("terminated".into())),
            None => {
                let exception = tc.exception();
                Err(MarkdownError::Invalid(message(tc, exception)))
            }
        }
    }
}

struct Job {
    source: String,
    reply: mpsc::SyncSender<Result<Converted, MarkdownError>>,
}

/// The import, loaded in a V8 isolate on its own thread; calls take turns.
/// After a conversion trips a limit its isolate is dropped and the next call
/// loads a fresh one.
pub struct Converter {
    jobs: Option<mpsc::Sender<Job>>,
    worker: Option<JoinHandle<()>>,
}

impl Converter {
    /// Loads the bundle (`markdown/build.mjs`'s output) and fails if it does
    /// not load.
    pub fn new(bundle: &str) -> Result<Self, MarkdownError> {
        let bundle = bundle.to_owned();
        let (jobs, queue) = mpsc::channel::<Job>();
        let (ready, loaded) = mpsc::sync_channel(1);
        let worker = thread::Builder::new()
            .name("markdown-v8".into())
            .spawn(move || {
                init_v8();
                let mut engine = match Engine::load(&bundle) {
                    Ok(engine) => {
                        let _ = ready.send(Ok(()));
                        Some(engine)
                    }
                    Err(error) => {
                        let _ = ready.send(Err(error));
                        return;
                    }
                };
                for job in queue {
                    let mut current = match engine.take() {
                        Some(engine) => engine,
                        None => match Engine::load(&bundle) {
                            Ok(engine) => engine,
                            Err(error) => {
                                let _ = job.reply.send(Err(error));
                                continue;
                            }
                        },
                    };
                    let (result, reusable) = current.convert(&job.source);
                    if reusable {
                        engine = Some(current);
                    }
                    let _ = job.reply.send(result);
                }
            })
            .map_err(|e| MarkdownError::Engine(e.to_string()))?;
        loaded
            .recv()
            .map_err(|_| MarkdownError::Engine("the engine thread stopped".into()))??;
        Ok(Converter {
            jobs: Some(jobs),
            worker: Some(worker),
        })
    }

    /// `convertAgentMarkdown(source)`: the document and a draft per quiz or
    /// flashcards fence. Blocks while the conversion runs (up to
    /// [TIME_LIMIT] plus the wait for earlier calls).
    pub fn convert(&self, source: &str) -> Result<Converted, MarkdownError> {
        if source.len() > MAX_INPUT_BYTES {
            return Err(MarkdownError::TooLarge {
                bytes: source.len(),
            });
        }
        let stopped = || MarkdownError::Engine("the engine thread stopped".into());
        let (reply, answer) = mpsc::sync_channel(1);
        self.jobs
            .as_ref()
            .ok_or_else(stopped)?
            .send(Job {
                source: source.to_owned(),
                reply,
            })
            .map_err(|_| stopped())?;
        answer.recv().map_err(|_| stopped())?
    }
}

impl Drop for Converter {
    fn drop(&mut self) {
        self.jobs.take();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
