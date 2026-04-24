FROM alpine:latest

RUN apk add --no-cache icecast

# icecast package already creates icecast user and log directories
# Just ensure they exist and have correct permissions
RUN mkdir -p /var/log/icecast && \
    chown -R icecast:icecast /var/log/icecast

USER icecast

EXPOSE 8000

CMD ["icecast", "-c", "/etc/icecast.xml"]
