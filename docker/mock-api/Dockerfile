FROM python:3.12-alpine

RUN apk add --no-cache openssl

WORKDIR /app
COPY mock_server.py .

# MOCK_API_TOKEN must be set at runtime (docker-compose.dev.yml defaults to "dev").
EXPOSE 9847

CMD ["python3", "mock_server.py"]
