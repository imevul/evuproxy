# For reproducible builds, pin with @sha256:… from `docker buildx imagetools inspect nginx:1.27-alpine`.
FROM nginx:1.27-alpine
RUN apk add --no-cache curl

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY web /usr/share/nginx/html

# Upstream is injected at runtime via envsubst
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 9080
ENTRYPOINT ["/entrypoint.sh"]
