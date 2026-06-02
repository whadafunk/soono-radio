FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    icecast2 \
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8000

ENTRYPOINT ["/entrypoint.sh"]
