# Benchmark machine: evo-ingest-1

Captured on 2026-08-31 after the benchmark containers stopped.

| Field                          | Value                                                                   |
| ------------------------------ | ----------------------------------------------------------------------- |
| Hostname                       | `evo-ingest-1`                                                          |
| Provider                       | Netcup                                                                  |
| VM model                       | RS 2000 G12, KVM virtualization                                         |
| Operating system               | Debian GNU/Linux 13.6, trixie                                           |
| Kernel                         | Linux `6.12.105+deb13-amd64`, x86-64                                    |
| CPU                            | 8 vCPUs, AMD EPYC 9645 96-Core Processor                                |
| CPU topology exposed to guest  | 8 sockets, 1 core per socket, 1 thread per core, 1 NUMA node            |
| RAM                            | 16,773,279,744 bytes, 15.62 GiB                                         |
| Persistent swap                | 25,769,799,680 bytes, 24.00 GiB                                         |
| Root disk                      | 539,792,977,920 bytes total, 479,135,928,320 bytes available at capture |
| Container runtime              | Docker client and server `26.1.5+dfsg1`                                 |
| Cgroup                         | v2, `cgroup2fs`                                                         |
| MinerU                         | 3.4.5, CPU pipeline backend                                             |
| Benchmark image revision label | `2725da1cbe39407786c9b3bdcd40fe68e0149046`                              |

The benchmark images carried that Git revision label, but the images were built
from an in-progress working tree rather than a clean checkout. The production,
UAT, and local ingest stacks were stopped. No production database or user data
was used.
