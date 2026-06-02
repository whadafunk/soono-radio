FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    icecast2 \
    && rm -rf /var/lib/apt/lists/*

EXPOSE 8000

CMD ["icecast2", "-c", "/etc/icecast2/icecast.xml"]

