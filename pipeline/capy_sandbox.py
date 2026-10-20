"""The one sandbox policy for processes that decode uploaded files.

Every such child gets an empty environment plus an allowlist, rlimits,
no_new_privs, a seccomp filter (no non-Unix sockets, io_uring or cross-process
calls; setsid, setpgid and process creation where the child never needs them),
a Landlock ruleset limited to its own files and job folder, its own process
group, death with its parent, and a wall-clock timeout that kills the group.
Children keep the parent's non-root uid, so a parent holding secrets makes
itself non-dumpable (``make_undumpable``).

``run`` starts a per-job child by executing this file as a trampoline: a fresh
single-threaded interpreter applies the policy to itself, then execs the
target, so a threaded parent runs no Python between fork and exec. ``confine``
applies the same policy to the calling process (the parser's persistent parse
child). The parser and pipeline images both carry this file, copied from
``pipeline/capy_sandbox.py``. Linux only: elsewhere (local development) ``run``
keeps only the environment and the timeout, and a deployed host (APP_ENV
production) without Landlock refuses to start.
"""

from __future__ import annotations

import ctypes
import errno
import json
import os
import signal
import subprocess
import sys
from dataclasses import dataclass, field
from functools import cache

LINUX = sys.platform == "linux"
PR_SET_PDEATHSIG = 1
PR_SET_DUMPABLE = 4
PR_SET_NO_NEW_PRIVS = 38
# Blocked for every child; ``Policy.blocked`` adds the others.
ALWAYS_BLOCKED = frozenset({"net", "peers"})
_PEERS = (
    "ptrace",
    "process_vm_readv",
    "process_vm_writev",
    "kcmp",
    "perf_event_open",
    "bpf",
    "userfaultfd",
    "keyctl",
    "add_key",
    "request_key",
)


@dataclass(frozen=True)
class Policy:
    """One child's limits. ``limits`` maps an rlimit name (``"DATA"``) to the
    value set as both soft and hard limit (``resource.RLIM_INFINITY`` lifts
    it); ``blocked`` adds seccomp groups (``setsid``, ``setpgid``, ``fork``);
    ``read`` and ``write`` are Landlock paths, files or directories; in a
    ``sockets`` directory the child may only create and remove Unix sockets
    (LibreOffice's IPC pipe goes to /tmp whatever TMPDIR says)."""

    limits: dict[str, int]
    blocked: frozenset[str]
    read: tuple[str, ...]
    write: tuple[str, ...] = ()
    sockets: tuple[str, ...] = ()
    env: dict[str, str] = field(default_factory=dict)
    timeout_s: float | None = None


def python_paths() -> tuple[str, ...]:
    """This interpreter's own files: its installation and import path."""
    paths = {sys.prefix, sys.base_prefix, sys.exec_prefix, *sys.path}
    paths.add(os.path.dirname(os.path.realpath(sys.executable)))
    return tuple(sorted(p for p in paths if p and os.path.exists(p)))


def _libc() -> ctypes.CDLL:
    libc = ctypes.CDLL("libc.so.6", use_errno=True)
    libc.syscall.restype = ctypes.c_long
    return libc


def make_undumpable() -> None:
    """No child (same uid) may trace this process or read its memory and
    environment through /proc. A no-op off Linux."""
    if LINUX and _libc().prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "prctl(PR_SET_DUMPABLE)")


@cache
def landlock_abi() -> int:
    """The kernel's Landlock ABI version, below 1 without Landlock."""
    if not LINUX:
        return 0
    return _libc().syscall(444, None, ctypes.c_size_t(0), ctypes.c_uint32(1))


def landlock_available() -> bool:
    """Whether children get the Landlock layer. Without it a deployed host
    (APP_ENV production) refuses to run decoders; local and e2e run them
    without it."""
    if landlock_abi() >= 1:
        return True
    if os.environ.get("APP_ENV") == "production":
        raise RuntimeError("this host has no Landlock: decoders cannot be confined")
    return False


def run(
    argv: list[str],
    policy: Policy,
    *,
    input: bytes | None = None,
    stderr: int = subprocess.PIPE,
) -> subprocess.CompletedProcess[bytes]:
    """Run ``argv`` under ``policy`` and return its output. At the timeout the
    whole process group is killed and ``subprocess.TimeoutExpired`` raised."""
    if not policy.timeout_s:
        raise ValueError("a per-job child needs a timeout")
    command, env, group = argv, policy.env, {}
    if os.name == "posix":
        group = {"process_group": 0}
    elif "SYSTEMROOT" in os.environ:
        # A Windows process cannot start its networking stack without it
        # (local development only).
        env = {**env, "SYSTEMROOT": os.environ["SYSTEMROOT"]}
    if LINUX:
        spec = {
            "parent": os.getpid(),
            "env": policy.env,
            "limits": policy.limits,
            "blocked": sorted(policy.blocked),
            "read": policy.read,
            "write": policy.write,
            "sockets": policy.sockets,
            "landlock": landlock_available(),
        }
        command = [sys.executable, "-I", "-S", __file__, json.dumps(spec), *argv]
        env = {}
    process = subprocess.Popen(
        command,
        env=env,
        stdin=subprocess.DEVNULL if input is None else subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=stderr,
        **group,
    )
    try:
        stdout, err = process.communicate(input, timeout=policy.timeout_s)
    except BaseException:
        _kill_group(process)
        process.communicate()
        raise
    _kill_group(process)  # Whatever the child left in its group.
    return subprocess.CompletedProcess(argv, process.returncode, stdout, err)


def _kill_group(process: subprocess.Popen[bytes]) -> None:
    if os.name != "posix":
        process.kill()
        return
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def confine(policy: Policy) -> None:
    """Apply ``policy``'s limits, seccomp filter and Landlock ruleset to this
    process and every process it starts (not its env or timeout). A no-op off
    Linux."""
    if LINUX:
        _apply(
            policy.limits,
            policy.blocked,
            policy.read,
            policy.write,
            policy.sockets,
            landlock_available(),
        )


def _apply(
    limits: dict[str, int],
    blocked: frozenset[str] | list[str],
    read: tuple[str, ...] | list[str],
    write: tuple[str, ...] | list[str],
    sockets: tuple[str, ...] | list[str],
    landlock: bool,
) -> None:
    import resource

    # Loaded first: the child's Landlock rules need not cover the library.
    libseccomp = ctypes.CDLL("libseccomp.so.2", use_errno=True)
    for name, value in limits.items():
        resource.setrlimit(getattr(resource, f"RLIMIT_{name}"), (value, value))
    if _libc().prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "prctl(PR_SET_NO_NEW_PRIVS)")
    if landlock:
        _landlock(read, write, sockets)
    _seccomp(libseccomp, ALWAYS_BLOCKED | set(blocked))


# --------------------------------------------------------------------- seccomp


class _Cmp(ctypes.Structure):
    _fields_ = [
        ("arg", ctypes.c_uint),
        ("op", ctypes.c_int),
        ("a", ctypes.c_uint64),
        ("b", ctypes.c_uint64),
    ]


def _seccomp(lib: ctypes.CDLL, groups: frozenset[str] | set[str]) -> None:
    lib.seccomp_init.restype = ctypes.c_void_p
    lib.seccomp_init.argtypes = [ctypes.c_uint32]
    lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    lib.seccomp_rule_add_array.argtypes = [
        ctypes.c_void_p,
        ctypes.c_uint32,
        ctypes.c_int,
        ctypes.c_uint,
        ctypes.POINTER(_Cmp),
    ]
    lib.seccomp_load.argtypes = [ctypes.c_void_p]
    lib.seccomp_release.argtypes = [ctypes.c_void_p]
    # Everything is allowed but the denials below; other architectures'
    # system calls kill the process (libseccomp's default).
    context = lib.seccomp_init(0x7FFF0000)
    if not context:
        raise OSError("seccomp_init failed")

    def deny(name: str, code: int, *cmps: _Cmp) -> None:
        number = lib.seccomp_syscall_resolve_name(name.encode())
        if number < 0:  # Not a system call on this architecture.
            return
        array = (_Cmp * len(cmps))(*cmps) if cmps else None
        rc = lib.seccomp_rule_add_array(
            context, 0x00050000 | code, number, len(cmps), array
        )
        if rc != 0:
            raise OSError(-rc, f"seccomp rule for {name}")

    not_equal, masked_equal = 1, 7
    if "net" in groups:
        # Unix sockets only (socketpair is Unix-only); io_uring opens sockets
        # without socket(2).
        deny("socket", errno.EACCES, _Cmp(0, not_equal, 1, 0))
        for name in ("io_uring_setup", "io_uring_enter", "io_uring_register"):
            deny(name, errno.ENOSYS)
    if "peers" in groups:
        for name in _PEERS:
            deny(name, errno.EPERM)
    for name in ("setsid", "setpgid"):
        if name in groups:
            deny(name, errno.EPERM)
    if "fork" in groups:
        # Threads stay allowed: clone with CLONE_THREAD. clone3 answers
        # ENOSYS, so glibc falls back to clone.
        deny("fork", errno.EPERM)
        deny("vfork", errno.EPERM)
        deny("clone", errno.EPERM, _Cmp(0, masked_equal, 0x00010000, 0))
        deny("clone3", errno.ENOSYS)
    try:
        rc = lib.seccomp_load(context)
    finally:
        lib.seccomp_release(context)
    if rc != 0:
        raise OSError(-rc, "seccomp_load")


# -------------------------------------------------------------------- landlock

_READ = (1 << 0) | (1 << 2) | (1 << 3)  # execute, read file, read directory
_SOCKETS = (1 << 5) | (1 << 9)  # remove file, make socket
# The rights a rule on a file (not a directory) may carry.
_FILE = (1 << 0) | (1 << 1) | (1 << 2) | (1 << 14) | (1 << 15)


class _RulesetAttr(ctypes.Structure):
    _fields_ = [("fs", ctypes.c_uint64), ("net", ctypes.c_uint64)]


class _PathBeneath(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("allowed", ctypes.c_uint64), ("fd", ctypes.c_int32)]


def _landlock(
    read: tuple[str, ...] | list[str],
    write: tuple[str, ...] | list[str],
    sockets: tuple[str, ...] | list[str],
) -> None:
    abi = landlock_abi()
    handled = (1 << 13) - 1
    for version, right in ((2, 1 << 13), (3, 1 << 14), (5, 1 << 15)):
        if abi >= version:
            handled |= right
    # ABI 4 handles TCP bind and connect too, with no rule allowing either.
    attr = _RulesetAttr(handled, 0b11 if abi >= 4 else 0)
    libc = _libc()
    ruleset = libc.syscall(
        444,
        ctypes.byref(attr),
        ctypes.c_size_t(16 if abi >= 4 else 8),
        ctypes.c_uint32(0),
    )
    if ruleset < 0:
        raise OSError(ctypes.get_errno(), "landlock_create_ruleset")
    try:
        for paths, rights in ((read, _READ), (write, handled), (sockets, _SOCKETS)):
            for path in paths:
                if not os.path.exists(path):
                    continue  # Nothing there to allow (/lib64 on some systems).
                descriptor = os.open(path, os.O_PATH | os.O_CLOEXEC)
                try:
                    allowed = rights if os.path.isdir(path) else rights & _FILE
                    rule = _PathBeneath(allowed & handled, descriptor)
                    if (
                        libc.syscall(
                            445,
                            ctypes.c_int(ruleset),
                            ctypes.c_int(1),
                            ctypes.byref(rule),
                            ctypes.c_uint32(0),
                        )
                        < 0
                    ):
                        raise OSError(ctypes.get_errno(), f"landlock rule for {path}")
                finally:
                    os.close(descriptor)
        if libc.syscall(446, ctypes.c_int(ruleset), ctypes.c_uint32(0)) < 0:
            raise OSError(ctypes.get_errno(), "landlock_restrict_self")
    finally:
        os.close(ruleset)


# ------------------------------------------------------------------ trampoline


def _trampoline(spec: dict, argv: list[str]) -> None:
    # Dies with the process that started it; one already gone means stop.
    libc = _libc()
    if libc.prctl(PR_SET_PDEATHSIG, signal.SIGKILL, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "prctl(PR_SET_PDEATHSIG)")
    if os.getppid() != spec["parent"]:
        os._exit(125)
    _apply(
        spec["limits"],
        spec["blocked"],
        spec["read"],
        spec["write"],
        spec["sockets"],
        spec["landlock"],
    )
    os.execve(argv[0], argv, spec["env"])


if __name__ == "__main__":
    try:
        _trampoline(json.loads(sys.argv[1]), sys.argv[2:])
    except BaseException as exc:  # noqa: BLE001 - reported to the parent
        sys.stderr.write(f"sandbox: {exc!r}\n")
        sys.stderr.flush()
        os._exit(126)
