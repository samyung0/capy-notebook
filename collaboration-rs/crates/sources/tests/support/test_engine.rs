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
        #[cfg(target_os = "linux")]
        "test.reach" => Ok((reach(&args(request)), Vec::new())),
        _ => office::dispatch(request),
    }
}

/// What this engine can still reach from inside its sandbox: its environment,
/// sockets, new processes and threads, its kernel-side status and limits, a
/// file outside it (`path`), its parent's environment, a signal to its parent
/// and an abstract Unix socket outside it (`abstract`). Each attempt
/// answers `ok` or the errno it failed with.
#[cfg(target_os = "linux")]
fn reach(args: &Value) -> Value {
    use std::os::linux::net::SocketAddrExt;
    use std::os::unix::process::CommandExt;

    fn errno<T>(result: std::io::Result<T>) -> Value {
        match result {
            Ok(_) => json!("ok"),
            Err(error) => json!(error.raw_os_error()),
        }
    }
    let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    let field = |name: &str| {
        status
            .lines()
            .find_map(|line| line.strip_prefix(name)?.strip_prefix(':'))
            .map(str::trim)
            .map(str::to_owned)
    };
    let limit = |resource: rlimit::Resource| resource.get().ok();
    let missing = "/nonexistent/capy-engine-probe";
    json!({
        "env": std::env::vars_os()
            .map(|(name, _)| name.to_string_lossy().into_owned())
            .collect::<Vec<_>>(),
        "udp": errno(std::net::UdpSocket::bind(("127.0.0.1", 0))),
        "spawn": errno(std::process::Command::new(missing).spawn()),
        "exec": errno(Err::<(), _>(std::process::Command::new(missing).exec())),
        "thread": std::thread::spawn(|| 7).join().ok(),
        "no_new_privs": field("NoNewPrivs"),
        "seccomp": field("Seccomp"),
        "seccomp_filters": field("Seccomp_filters"),
        "nofile": limit(rlimit::Resource::NOFILE),
        "core": limit(rlimit::Resource::CORE),
        "data": limit(rlimit::Resource::DATA),
        "fsize": limit(rlimit::Resource::FSIZE),
        "own_group": nix::unistd::getpgrp() == nix::unistd::getpid(),
        "setpgid": errno(nix::unistd::setpgid(nix::unistd::Pid::from_raw(0), nix::unistd::Pid::from_raw(0)).map_err(std::io::Error::from)),
        "file": errno(std::fs::read(args["path"].as_str().unwrap_or(missing))),
        "signal_parent": errno(nix::sys::signal::kill(nix::unistd::getppid(), None).map_err(std::io::Error::from)),
        "abstract_unix": errno(
            std::os::unix::net::SocketAddr::from_abstract_name(args["abstract"].as_str().unwrap_or("capy"))
                .and_then(|address| std::os::unix::net::UnixStream::connect_addr(&address)),
        ),
        "parent_environ": errno(std::fs::read(format!("/proc/{}/environ", nix::unistd::getppid()))),
    })
}

fn main() -> std::io::Result<()> {
    #[cfg(target_os = "linux")]
    if std::env::args().nth(1).as_deref() == Some("pool") {
        return pool();
    }
    sources::engine::serve_with(call)
}

/// `pool`: a stand-in server for the parent-death test. Runs a pool of this
/// engine, starts a 60 s call on it, prints the engine's pid and waits to be
/// killed.
#[cfg(target_os = "linux")]
fn pool() -> std::io::Result<()> {
    use sources::engine::{EnginePool, Lane, PoolConfig};
    tokio::runtime::Runtime::new()?.block_on(async {
        let pool = std::sync::Arc::new(EnginePool::new(PoolConfig {
            program: std::env::current_exe()?,
            args: Vec::new(),
            save_processes: 1,
            background_processes: 1,
            call_timeout: Duration::from_secs(120),
            replica_budget_bytes: 0,
            memory_limit_bytes: None,
        }));
        let call = |method: &str, args: Value| {
            let (pool, request) = (
                pool.clone(),
                Frame::new(method, args.to_string().into(), Vec::new()),
            );
            async move { pool.call(Lane::Save, None, request).await }
        };
        let engine = call("test.echo", json!({})).await.unwrap().value["pid"].clone();
        let sleeping = tokio::spawn(call("test.sleep", json!({ "ms": 60_000 })));
        tokio::time::sleep(Duration::from_millis(300)).await;
        println!("{engine}");
        let _ = sleeping.await;
        Ok(())
    })
}
