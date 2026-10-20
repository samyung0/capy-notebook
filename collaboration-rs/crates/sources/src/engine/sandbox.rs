//! The Office engine sandbox (Epo 2026-10-20, the shared decoder policy in
//! human/deployment-runbook.md). An engine reads untrusted Office files and,
//! once started, needs nothing but its pipes. On Linux:
//! - the pool starts it with an empty environment plus [`passes`], in its own
//!   process group (a timeout kills the group), and makes itself
//!   non-dumpable first, so a same-uid engine cannot read the server's
//!   secrets through /proc;
//! - the engine ([`confine`], before its engine thread starts) closes any
//!   descriptor it inherited above stderr, dies with the pool, keeps 64
//!   descriptors and no core file (the data cap is the pool's; no file-size
//!   cap: stderr may be a file), sets no_new_privs, and takes Landlock (reads
//!   only under /proc/self, no TCP, no signal or abstract Unix socket outside
//!   its own sandbox) and seccomp: no non-Unix socket, io_uring,
//!   cross-process call, setsid/setpgid, new process, exec, x32 call or
//!   change to its parent-death signal or dumpability, while threads still
//!   start.
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
        "no Landlock scoping (ABI 6, Linux 6.12): engines run with seccomp, limits and older Landlock"
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
        close_inherited()?;
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

    /// Closes every descriptor above stderr the engine inherited (the
    /// server's are close-on-exec, but nothing else is relied on). Nothing in
    /// this process owns one yet.
    fn close_inherited() -> io::Result<()> {
        let open: Vec<i32> = std::fs::read_dir("/proc/self/fd")?
            .filter_map(|entry| entry.ok()?.file_name().to_str()?.parse().ok())
            .filter(|&fd| fd > 2)
            .collect();
        for fd in open {
            // The listing's own descriptor is already closed.
            match nix::unistd::close(fd) {
                Ok(()) | Err(nix::errno::Errno::EBADF) => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }

    /// Calls refused with EPERM: cross-process calls, session and group
    /// changes, and new processes (with the conditional `clone` and `prctl`
    /// rules in [`seccomp`]).
    pub(super) const DENIED: &[libc::c_long] = &[
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
    ];
    /// Calls refused with EACCES (with the non-Unix `socket` rule).
    pub(super) const REFUSED: &[libc::c_long] = &[libc::SYS_execve, libc::SYS_execveat];
    /// Calls that answer ENOSYS: io_uring, and clone3, so glibc starts
    /// threads with clone, whose CLONE_THREAD flag the filter can read.
    pub(super) const ABSENT: &[libc::c_long] = &[
        libc::SYS_io_uring_setup,
        libc::SYS_io_uring_enter,
        libc::SYS_io_uring_register,
        libc::SYS_clone3,
    ];

    /// One filter per errno over [`DENIED`], [`REFUSED`] and [`ABSENT`],
    /// plus (x86_64) [`x32`].
    fn seccomp() -> io::Result<()> {
        let arch = std::env::consts::ARCH
            .try_into()
            .map_err(io::Error::other)?;
        let any = |numbers: &[libc::c_long]| -> BTreeMap<i64, Vec<SeccompRule>> {
            numbers.iter().map(|&nr| (nr, Vec::new())).collect()
        };
        let rule = |arg: u8, len: SeccompCmpArgLen, op: SeccompCmpOp, value: u64| {
            SeccompCondition::new(arg, len, op, value)
                .and_then(|condition| SeccompRule::new(vec![condition]))
                .map_err(io::Error::other)
        };
        let mut denied = any(DENIED);
        // A clone without CLONE_THREAD is a new process (flags: argument 0).
        denied.insert(
            libc::SYS_clone,
            vec![rule(
                0,
                SeccompCmpArgLen::Qword,
                SeccompCmpOp::MaskedEq(libc::CLONE_THREAD as u64),
                0,
            )?],
        );
        // Its parent-death signal and dumpability stay as set.
        denied.insert(
            libc::SYS_prctl,
            [libc::PR_SET_PDEATHSIG, libc::PR_SET_DUMPABLE]
                .into_iter()
                .map(|option| rule(0, SeccompCmpArgLen::Dword, SeccompCmpOp::Eq, option as u64))
                .collect::<io::Result<_>>()?,
        );
        let mut refused = any(REFUSED);
        refused.insert(
            libc::SYS_socket,
            vec![rule(
                0,
                SeccompCmpArgLen::Dword,
                SeccompCmpOp::Ne,
                libc::AF_UNIX as u64,
            )?],
        );
        for (rules, errno) in [
            (denied, libc::EPERM),
            (refused, libc::EACCES),
            (any(ABSENT), libc::ENOSYS),
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
        #[cfg(target_arch = "x86_64")]
        seccompiler::apply_filter_all_threads(&x32()).map_err(io::Error::other)?;
        Ok(())
    }

    /// Refuses (EPERM) every x32 call: x86_64's arch with the x32 bit in the
    /// number, which the filters above, matching exact numbers, would allow.
    /// Another arch is the other filters' to kill.
    #[cfg(target_arch = "x86_64")]
    pub(super) fn x32() -> BpfProgram {
        use seccompiler::sock_filter;
        const LOAD: u16 = (libc::BPF_LD | libc::BPF_W | libc::BPF_ABS) as u16;
        const JEQ: u16 = (libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K) as u16;
        const JGE: u16 = (libc::BPF_JMP | libc::BPF_JGE | libc::BPF_K) as u16;
        const RET: u16 = (libc::BPF_RET | libc::BPF_K) as u16;
        let op = |code, jt, jf, k| sock_filter { code, jt, jf, k };
        vec![
            op(LOAD, 0, 0, 4), // seccomp_data.arch
            op(JEQ, 0, 3, AUDIT_ARCH_X86_64),
            op(LOAD, 0, 0, 0), // seccomp_data.nr
            op(JGE, 0, 1, X32_SYSCALL_BIT),
            op(RET, 0, 0, libc::SECCOMP_RET_ERRNO | libc::EPERM as u32),
            op(RET, 0, 0, libc::SECCOMP_RET_ALLOW),
        ]
    }

    #[cfg(target_arch = "x86_64")]
    pub(super) const X32_SYSCALL_BIT: u32 = 0x4000_0000;
    /// EM_X86_64 | __AUDIT_ARCH_64BIT | __AUDIT_ARCH_LE (linux/audit.h).
    #[cfg(target_arch = "x86_64")]
    pub(super) const AUDIT_ARCH_X86_64: u32 = 0xc000_003e;
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

    /// Security regression (the Office engine sandbox): each refused call
    /// stays in its filter's table, also those the engine test cannot issue
    /// without unsafe code (io_uring, clone3, bpf, keyctl and the like).
    #[cfg(target_os = "linux")]
    #[test]
    fn the_filter_tables_hold_every_refused_call() {
        use super::linux::{ABSENT, DENIED, REFUSED};
        use nix::libc;
        for nr in [
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
        ] {
            assert!(DENIED.contains(&nr), "{nr}");
        }
        for nr in [libc::SYS_execve, libc::SYS_execveat] {
            assert!(REFUSED.contains(&nr), "{nr}");
        }
        for nr in [
            libc::SYS_io_uring_setup,
            libc::SYS_io_uring_enter,
            libc::SYS_io_uring_register,
            libc::SYS_clone3,
        ] {
            assert!(ABSENT.contains(&nr), "{nr}");
        }
    }

    /// Security regression (the Office engine sandbox): the x32 filter,
    /// run by a small BPF interpreter, refuses every x32 number and lets
    /// x86_64 numbers and other arches through (the engine cannot issue an
    /// x32 call without unsafe code; the engine test counts its filter).
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    #[test]
    fn the_x32_filter_refuses_every_x32_call_and_nothing_else() {
        use super::linux::{AUDIT_ARCH_X86_64, X32_SYSCALL_BIT, x32};
        use nix::libc;
        let program = x32();
        let run = |arch: u32, nr: u32| -> u32 {
            let (mut at, mut value) = (0, 0);
            loop {
                let op = &program[at];
                let jump = |taken: bool| at + 1 + usize::from(if taken { op.jt } else { op.jf });
                match u32::from(op.code) {
                    code if code == libc::BPF_LD | libc::BPF_W | libc::BPF_ABS => {
                        value = match op.k {
                            0 => nr,
                            4 => arch,
                            k => panic!("load at {k}"),
                        };
                        at += 1;
                    }
                    code if code == libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K => {
                        at = jump(value == op.k);
                    }
                    code if code == libc::BPF_JMP | libc::BPF_JGE | libc::BPF_K => {
                        at = jump(value >= op.k);
                    }
                    code if code == libc::BPF_RET | libc::BPF_K => return op.k,
                    code => panic!("opcode {code:#x}"),
                }
            }
        };
        let refused = libc::SECCOMP_RET_ERRNO | libc::EPERM as u32;
        let socket = libc::SYS_socket as u32;
        // x32's socket and its own execve number.
        assert_eq!(run(AUDIT_ARCH_X86_64, socket | X32_SYSCALL_BIT), refused);
        assert_eq!(run(AUDIT_ARCH_X86_64, 520 | X32_SYSCALL_BIT), refused);
        assert_eq!(run(AUDIT_ARCH_X86_64, socket), libc::SECCOMP_RET_ALLOW);
        assert_eq!(
            run(AUDIT_ARCH_X86_64, X32_SYSCALL_BIT - 1),
            libc::SECCOMP_RET_ALLOW
        );
        // i386 (AUDIT_ARCH_I386): the other filters kill it.
        assert_eq!(
            run(0x4000_0003, socket | X32_SYSCALL_BIT),
            libc::SECCOMP_RET_ALLOW
        );
    }
}
