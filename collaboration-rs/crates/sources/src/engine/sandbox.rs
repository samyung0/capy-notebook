//! The Office engine sandbox (Epo 2026-10-20, the shared decoder policy in
//! human/deployment-runbook.md). An engine reads untrusted Office files and,
//! once started, needs nothing but its pipes. On Linux:
//! - the pool starts it with an empty environment plus [`passes`], in its own
//!   process group (a timeout kills the group), and makes itself
//!   non-dumpable first, so a same-uid engine cannot read the server's
//!   secrets through /proc;
//! - the engine ([`confine`], before its engine thread starts) dies with the
//!   pool, keeps 64 descriptors and no core file (the data cap is the pool's;
//!   no file-size cap: stderr may be a file), sets no_new_privs, and takes
//!   Landlock (reads only under /proc/self, no TCP, no signal or abstract
//!   Unix socket outside its own sandbox) and seccomp: no non-Unix socket,
//!   io_uring, cross-process call, setsid/setpgid, new process or exec, while
//!   threads still start.
//!
//! A production server on a host without Landlock's scoping (ABI 6, Linux
//! 6.12; Epo 2026-10-20) does not start ([`check_host`]); elsewhere the gap is
//! logged once. Off Linux (Windows and macOS development) an engine gets the
//! cleared environment only.

use tokio::process::{Child, Command};

/// Debug builds (the tests) only: the host check acts as if Landlock were
/// missing (crates/server/tests/engine_sandbox.rs).
#[cfg(debug_assertions)]
const TEST_NO_LANDLOCK: &str = "CAPY_TEST_NO_LANDLOCK";

/// The server environment an engine keeps: its own settings, glibc's
/// allocator tuning (Epo 2026-10-17), and the log settings. Everything else
/// (database, Redis, secrets, Sentry) stays in the server.
pub fn passes(name: &str) -> bool {
    name.starts_with("CAPY_ENGINE_")
        || name.starts_with("MALLOC_")
        || name == "APP_ENV"
        || name == "LOG_FORMAT"
}

/// At server start: refuses production (`APP_ENV=production`, UAT included)
/// on a host without Landlock's signal and abstract Unix-socket scoping;
/// otherwise the gap to log once, if any.
pub fn check_host() -> Result<Option<&'static str>, String> {
    let production = std::env::var("APP_ENV").is_ok_and(|env| env == "production");
    if landlock_available() {
        return Ok(None);
    }
    let gap = if cfg!(target_os = "linux") {
        "Landlock with scoping (ABI 6, Linux 6.12) unavailable: Office engines run with          seccomp, their limits and any older Landlock"
    } else {
        "not Linux: Office engines run with a cleared environment only"
    };
    if production {
        return Err(format!(
            "{gap}; a production collaboration server does not start without Landlock's scoping"
        ));
    }
    Ok(Some(gap))
}

fn landlock_available() -> bool {
    #[cfg(debug_assertions)]
    if std::env::var_os(TEST_NO_LANDLOCK).is_some() {
        return false;
    }
    #[cfg(target_os = "linux")]
    {
        linux::landlock_available()
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

/// The pool's side, once before any engine starts: the engines' parent is
/// not dumpable, so its /proc files (environment, memory) stay closed to a
/// process of the same uid.
pub(super) fn parent() {
    #[cfg(target_os = "linux")]
    #[allow(clippy::expect_used)]
    nix::sys::prctl::set_dumpable(false).expect("the engine pool's process becomes non-dumpable");
}

/// An engine process's environment and process group.
pub(super) fn isolate(command: &mut Command) {
    command.env_clear();
    for (name, value) in std::env::vars_os() {
        if name.to_str().is_some_and(passes) {
            command.env(name, value);
        }
    }
    #[cfg(target_os = "linux")]
    command.process_group(0);
}

/// Kills an engine's process group (Linux), then the engine itself.
pub(super) fn kill(child: &mut Child) {
    #[cfg(target_os = "linux")]
    if let Some(pid) = child.id().and_then(|pid| i32::try_from(pid).ok()) {
        let _ = nix::sys::signal::killpg(
            nix::unistd::Pid::from_raw(pid),
            nix::sys::signal::Signal::SIGKILL,
        );
    }
    let _ = child.start_kill();
}

/// The engine's side, on its main thread before any other thread starts
/// (Landlock binds the calling thread and the threads it starts later).
pub(super) fn confine() -> std::io::Result<()> {
    #[cfg(target_os = "linux")]
    linux::confine()?;
    Ok(())
}

#[cfg(target_os = "linux")]
mod linux {
    use std::collections::BTreeMap;
    use std::io;

    use landlock::{
        Access, AccessFs, AccessNet, CompatLevel, Compatible, PathBeneath, PathFd, Ruleset,
        RulesetAttr, RulesetCreatedAttr, Scope,
    };
    use nix::libc;
    use rlimit::Resource;
    use seccompiler::{
        BpfProgram, SeccompAction, SeccompCmpArgLen, SeccompCmpOp, SeccompCondition, SeccompFilter,
        SeccompRule,
    };

    /// The newest Landlock ABI this crate knows; an older kernel enforces
    /// what it has (best effort).
    const ABI: landlock::ABI = landlock::ABI::V9;

    /// Landlock with the signal and abstract Unix-socket scopes.
    pub(super) fn landlock_available() -> bool {
        Ruleset::default()
            .set_compatibility(CompatLevel::HardRequirement)
            .handle_access(AccessFs::Execute)
            .and_then(|ruleset| ruleset.scope(Scope::from_all(landlock::ABI::V6)))
            .and_then(Ruleset::create)
            .is_ok()
    }

    pub(super) fn confine() -> io::Result<()> {
        // The pool's spawner thread outlives its engines (engine/mod.rs).
        nix::sys::prctl::set_pdeathsig(nix::sys::signal::Signal::SIGKILL)?;
        Resource::NOFILE.set(64, 64)?;
        Resource::CORE.set(0, 0)?;
        nix::sys::prctl::set_no_new_privs()?;
        // Reads of its own /proc files only (the usage it reports). Without
        // Landlock (development only: a production server refuses to start)
        // the engine runs on with seccomp and its limits.
        let own = PathFd::new("/proc/self").map_err(io::Error::other)?;
        Ruleset::default()
            .handle_access(AccessFs::from_all(ABI))
            .and_then(|ruleset| ruleset.handle_access(AccessNet::from_all(ABI)))
            .and_then(|ruleset| ruleset.scope(Scope::from_all(ABI)))
            .and_then(Ruleset::create)
            .and_then(|ruleset| {
                ruleset.add_rule(PathBeneath::new(
                    own,
                    AccessFs::ReadFile | AccessFs::ReadDir,
                ))
            })
            .and_then(|ruleset| ruleset.restrict_self())
            .map_err(io::Error::other)?;
        seccomp()
    }

    /// Three filters, one per errno: EPERM for cross-process calls, session
    /// and group changes and new processes; EACCES for non-Unix sockets and
    /// exec; ENOSYS for io_uring and clone3 (glibc then starts threads with
    /// clone, which keeps CLONE_THREAD visible to the filter).
    fn seccomp() -> io::Result<()> {
        let arch = std::env::consts::ARCH
            .try_into()
            .map_err(io::Error::other)?;
        let any = |numbers: &[libc::c_long]| -> BTreeMap<i64, Vec<SeccompRule>> {
            numbers.iter().map(|&nr| (nr, Vec::new())).collect()
        };
        let when = |arg: u8, len: SeccompCmpArgLen, op: SeccompCmpOp, value: u64| {
            SeccompCondition::new(arg, len, op, value)
                .and_then(|condition| SeccompRule::new(vec![condition]))
                .map(|rule| vec![rule])
                .map_err(io::Error::other)
        };
        let mut denied = any(&[
            libc::SYS_ptrace,
            libc::SYS_process_vm_readv,
            libc::SYS_process_vm_writev,
            libc::SYS_process_madvise,
            libc::SYS_pidfd_getfd,
            libc::SYS_kcmp,
            libc::SYS_perf_event_open,
            libc::SYS_bpf,
            libc::SYS_userfaultfd,
            libc::SYS_keyctl,
            libc::SYS_add_key,
            libc::SYS_request_key,
            libc::SYS_setsid,
            libc::SYS_setpgid,
            #[cfg(target_arch = "x86_64")]
            libc::SYS_fork,
            #[cfg(target_arch = "x86_64")]
            libc::SYS_vfork,
        ]);
        // A clone without CLONE_THREAD is a new process (flags: argument 0).
        denied.insert(
            libc::SYS_clone,
            when(
                0,
                SeccompCmpArgLen::Qword,
                SeccompCmpOp::MaskedEq(libc::CLONE_THREAD as u64),
                0,
            )?,
        );
        let mut refused = any(&[libc::SYS_execve, libc::SYS_execveat]);
        refused.insert(
            libc::SYS_socket,
            when(
                0,
                SeccompCmpArgLen::Dword,
                SeccompCmpOp::Ne,
                libc::AF_UNIX as u64,
            )?,
        );
        let absent = any(&[
            libc::SYS_io_uring_setup,
            libc::SYS_io_uring_enter,
            libc::SYS_io_uring_register,
            libc::SYS_clone3,
        ]);
        for (rules, errno) in [
            (denied, libc::EPERM),
            (refused, libc::EACCES),
            (absent, libc::ENOSYS),
        ] {
            let program: BpfProgram = SeccompFilter::new(
                rules,
                SeccompAction::Allow,
                SeccompAction::Errno(errno as u32),
                arch,
            )
            .and_then(TryInto::try_into)
            .map_err(io::Error::other)?;
            seccompiler::apply_filter_all_threads(&program).map_err(io::Error::other)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::passes;

    #[test]
    fn an_engine_keeps_only_its_own_allocator_and_log_settings() {
        for name in [
            "CAPY_ENGINE_MEMORY_LIMIT",
            "MALLOC_ARENA_MAX",
            "APP_ENV",
            "LOG_FORMAT",
        ] {
            assert!(passes(name), "{name}");
        }
        for name in [
            "DATABASE_URL",
            "COLLABORATION_SECRET",
            "SENTRY_DSN",
            "PATH",
            "COLLABORATION_ENGINE_MEMORY_LIMIT_BYTES",
        ] {
            assert!(!passes(name), "{name}");
        }
    }
}
