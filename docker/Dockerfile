# For reproducible builds, pin with @sha256:… from `docker buildx imagetools inspect nginx:1.27-alpine`.
FROM nginx:1.27-alpine
RUN apk add --no-cache curl

# Identity for diagnostics / OCI consumers (passed from compose or CI).
ARG EVUPROXY_VERSION=dev
ARG EVUPROXY_REVISION=unknown
ARG EVUPROXY_CREATED=unknown
LABEL org.opencontainers.image.title="EvuProxy UI" \
      org.opencontainers.image.description="EvuProxy admin web UI (nginx)" \
      org.opencontainers.image.source="https://github.com/imevul/evuproxy" \
      org.opencontainers.image.version="${EVUPROXY_VERSION}" \
      org.opencontainers.image.revision="${EVUPROXY_REVISION}" \
      org.opencontainers.image.created="${EVUPROXY_CREATED}"

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY web /usr/share/nginx/html

# Upstream is injected at runtime via envsubst
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 9080
ENTRYPOINT ["/entrypoint.sh"]
