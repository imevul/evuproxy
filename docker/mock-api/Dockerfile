FROM python:3.12-alpine

WORKDIR /app
COPY mock_server.py .

ENV MOCK_API_TOKEN=dev
EXPOSE 9847

CMD ["python3", "mock_server.py"]
