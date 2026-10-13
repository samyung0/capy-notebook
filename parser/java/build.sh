#!/bin/sh
# Compile CapyMain against the installed opendataloader-pdf jar into one jar.
# Usage: build.sh [OUTPUT_JAR]   (default parser/java/build/capy-odl.jar)
# Needs a JDK (javac and jar, release 17) and the Python that has
# opendataloader-pdf installed as PYTHON (default python3).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out=${1:-$here/build/capy-odl.jar}
odl=$("${PYTHON:-python3}" -c 'from importlib import resources; print(resources.files("opendataloader_pdf").joinpath("jar", "opendataloader-pdf-cli.jar"))')
classes=$(mktemp -d)
trap 'rm -rf "$classes"' EXIT
javac --release 17 -Xlint:all -Werror -cp "$odl" -d "$classes" "$here/CapyMain.java"
mkdir -p "$(dirname "$out")"
jar --create --file "$out" -C "$classes" .
