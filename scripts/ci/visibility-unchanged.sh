#!/usr/bin/env bash
# The Agent visibility lane's nightly skip (agent-visibility.yml): exits 0 only
# when every change between $1 and HEAD is under a path the lane never reads:
# docs (openwiki/, top-level *.md), decisions (human/), benchmarks (bench/),
# developer tools (lab/), the ops dashboard (ops/) and the Cloudflare Workers
# (workers/). Any other change, or a commit git does not know, exits non-zero
# and the lane runs. An ignore list, not a list of read paths, so new code the
# lane depends on is never skipped.
exec git diff --quiet "$1" HEAD -- . \
  ':(exclude)openwiki' ':(exclude)human' ':(exclude)bench' ':(exclude)lab' \
  ':(exclude)ops' ':(exclude)workers' ':(exclude,glob)*.md'
