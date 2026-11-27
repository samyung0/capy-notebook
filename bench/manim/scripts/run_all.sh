#!/bin/zsh
# Export each scene to a CMV film (the smaller of drawn and video) beside its original take,
# decode it (a drawn film back into a take), compare it with the original drawn by ManimGX's
# headless player, then delete the takes. One JSON line per scene.
# usage: run_all.sh <python> <examples dir> <out.jsonl> <scene> [scene …]
PY=$1 EX=$2 OUT=$3
shift 3
R=${0:A:h:h}/.results
mkdir -p $R/cmv
for f in "$@"; do
  e=$($PY -I -m cmv_manimgx export $EX/$f.py -o $R/cmv/$f.cmv --take $R/$f.take --json 2>/dev/null | tail -1)
  d=$($PY -I ${0:A:h}/decode.py $R/cmv/$f.cmv --take $R/$f.rebuilt.take 2>/dev/null | tail -1)
  b=$R/$f.rebuilt.take
  [[ -f $b ]] || b=$R/cmv/$f.cmv
  c=$($PY -I ${0:A:h}/check.py $R/$f.take $b 30 2>/dev/null | tail -1)
  echo "{\"scene\": \"$f\", \"export\": ${e:-null}, \"decode\": ${d:-null}, \"check\": ${c:-null}}" >> $OUT
  rm -f $R/$f.take $R/$f.rebuilt.take
done
