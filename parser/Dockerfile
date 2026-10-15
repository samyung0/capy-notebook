# CapyMain (parser/java) compiled against the pinned ODL jar; the runtime image
# keeps a JRE only.
FROM python:3.12.14-slim-bookworm@sha256:0f5b26b9518d002b6173fd61daad821fa340635ebfec5bba471013f9ca114579 AS odl-entry
COPY parser/debian.sources /etc/apt/sources.list.d/debian.sources
RUN apt-get update \
    && apt-get install -y --no-install-recommends openjdk-17-jdk-headless \
    && rm -rf /var/lib/apt/lists/*
COPY parser/requirements.txt /build/requirements.txt
RUN sed -n '/^opendataloader-pdf==/,/^    # via/p' /build/requirements.txt \
        | grep -v '# via' > /build/odl.txt \
    && pip install --no-cache-dir --no-deps --require-hashes -r /build/odl.txt
COPY parser/java/CapyMain.java parser/java/build.sh /build/java/
RUN sh /build/java/build.sh /build/capy-odl.jar

FROM python:3.12.14-slim-bookworm@sha256:0f5b26b9518d002b6173fd61daad821fa340635ebfec5bba471013f9ca114579

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOME=/run/capy-parser/home \
    PYTHONPATH=/app/parser

COPY parser/debian.sources /etc/apt/sources.list.d/debian.sources
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl \
        fonts-dejavu-core \
        fonts-noto-core \
        fonts-noto-cjk \
        fontconfig \
        libreoffice-calc \
        libreoffice-impress \
        libreoffice-writer \
        openjdk-17-jre-headless \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY parser/requirements.txt ./parser/requirements.txt
RUN pip install --no-cache-dir --require-hashes -r parser/requirements.txt

COPY --from=odl-entry --chmod=644 /build/capy-odl.jar /opt/capy-odl/capy-odl.jar
ENV CAPY_ODL_ENTRY_JAR=/opt/capy-odl/capy-odl.jar
# Some builders give the directory COPY creates the file's --chmod mode.
RUN chmod 755 /opt/capy-odl

# PID 1 reaps the soffice.bin a conversion timeout kills (parser/odl/document.py).
# Execute-only: the kernel then runs it non-dumpable, so the parser user cannot
# read its environment (PARSER_TOKEN) through /proc/1.
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/* \
    && chmod 0711 /usr/bin/tini

# RELEASE_SHA sits below every cacheable layer so a new commit rebuilds only the
# source copy (Coolify must not inject build args above).
ARG RELEASE_SHA
RUN test "$(printf %s "$RELEASE_SHA" | wc -c)" -eq 40 \
    && ! printf %s "$RELEASE_SHA" | grep -q '[^0-9a-f]'
LABEL org.opencontainers.image.revision=$RELEASE_SHA
ENV RELEASE_SHA=$RELEASE_SHA

# The ingest host clones the build context under umask 077, so copy the runtime
# sources with an explicit mode: USER parser below cannot read 0600 root files.
COPY --chmod=644 parser/app.py ./parser/
COPY --chmod=644 parser/odl/ ./parser/odl/
RUN chmod 755 /app/parser/odl

# Under read_only the HOME tmpfs is the user's only writable home, and Java
# reads user.home from passwd, not $HOME.
RUN useradd --home-dir /run/capy-parser/home --uid 10001 parser \
    && mkdir -p /run/capy-parser/home /run/capy-parser/work \
    && chown -R parser:parser /run/capy-parser
# Python's temporary files (spooled uploads) go to the disk-backed work volume,
# not the small RAM-backed /tmp the compose files mount.
ENV TMPDIR=/run/capy-parser/work
USER parser

EXPOSE 8090
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["uvicorn", "app:app", "--app-dir", "/app/parser", "--host", "0.0.0.0", "--port", "8090", "--workers", "1"]
