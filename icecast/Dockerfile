FROM alpine:latest

RUN apk add --no-cache icecast

# Create icecast user to avoid running as root
RUN addgroup -g 1000 icecast && \
    adduser -D -u 1000 -G icecast icecast && \
    mkdir -p /var/log/icecast && \
    chown -R icecast:icecast /var/log/icecast

USER icecast

EXPOSE 8000

CMD ["icecast", "-c", "/etc/icecast.xml"]
