//! An engine process for the pool tests: the real Office dispatcher plus
//! `test.*` methods that misbehave on purpose (sleep past the timeout, abort,
//! exit, run out of memory, panic in the glue, print to stdout).

#![allow(clippy::print_stdout, clippy::unwrap_used)]

use std::time::Duration;

use serde_json::{Value, json};
use sources::engine::{Frame, child::Answer, office};

fn args(request: &Frame) -> Value {
    serde_json::from_slice(&request.json).unwrap_or(Value::Null)
}

fn call(request: &Frame) -> Answer {
    match request.head.as_str() {
        "test.echo" => Ok((
            json!({ "args": args(request), "pid": std::process::id() }),
            request.blobs.clone(),
        )),
        "test.sleep" => {
            let ms = args(request)["ms"].as_u64().unwrap_or(0);
            std::thread::sleep(Duration::from_millis(ms));
            Ok((json!({ "pid": std::process::id() }), Vec::new()))
        }
        "test.abort" => std::process::abort(),
        "test.exit" => std::process::exit(3),
        "test.allocate" => {
            // Holds `mib` MiB, then answers. Under the Linux memory cap below
            // that size an allocation fails first and the process aborts.
            // Elsewhere (no cap) the abort is raised at the size directly.
            let mib = args(request)["mib"].as_u64().unwrap_or(64) as usize;
            let mut held: Vec<Vec<u8>> = Vec::new();
            while held.len() < mib {
                let mut chunk = vec![0u8; 1 << 20];
                chunk[0] = 1;
                held.push(chunk);
            }
            if !cfg!(target_os = "linux") {
                std::alloc::handle_alloc_error(std::alloc::Layout::new::<[u8; 1 << 20]>());
            }
            Ok((json!({ "held": held.len() }), Vec::new()))
        }
        "test.panic" => panic!("engine glue panicked"),
        "test.print" => {
            println!("a stray line on stdout");
            Ok((Value::Null, Vec::new()))
        }
        _ => office::dispatch(request),
    }
}

fn main() -> std::io::Result<()> {
    sources::engine::serve_with(call)
}
