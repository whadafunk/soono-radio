FROM alpine:latest

RUN apk add --no-cache icecast

# Create both standard log directories and ensure they're writable by icecast
RUN mkdir -p /var/log/icecast /usr/local/icecast/logs && \
    chown -R icecast:icecast /var/log/icecast /usr/local/icecast/logs

USER icecast

EXPOSE 8000

CMD ["icecast", "-c", "/etc/icecast.xml"]
