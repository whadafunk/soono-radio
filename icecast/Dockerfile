FROM alpine:latest

RUN apk add --no-cache icecast

# Icecast package creates icecast user automatically
# Just ensure log directory is writable
RUN mkdir -p /var/log/icecast && \
    chown -R icecast:icecast /var/log/icecast

EXPOSE 8000

CMD ["icecast", "-c", "/etc/icecast.xml"]
