FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates python3 python3-uno python3-pikepdf python3-pil python3-olefile python3-defusedxml \
    libreoffice-writer libreoffice-calc clamav clamav-freshclam \
    && freshclam --stdout \
    && date +%s > /opt/signatures-built-at \
    && dpkg-query -W > /opt/package-versions.txt \
    && rm -rf /var/lib/apt/lists/*
COPY --chmod=0444 sandbox.py /opt/sandbox.py
# LibreOffice requires /tmp; both names share the sole bounded runtime tmpfs.
RUN rmdir /tmp && ln -s /work /tmp
USER 65532:65532
WORKDIR /work
ENTRYPOINT ["timeout", "--signal=KILL", "75s", "/usr/bin/python3", "/opt/sandbox.py"]
