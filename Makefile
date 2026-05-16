.PHONY: all up down dev dev-fresh

# Run from the repository root. Requires Go 1.22+, Docker, and `docker compose` (v2).

all:
	./scripts/rebuild.sh
	docker compose build
	docker compose -f docker-compose.dev.yml build

up:
	docker compose -f docker-compose.dev.yml up --build -d

dev: all
	$(MAKE) up

# Reset mock API persisted dev config to Python baseline and recreate mock-api (clears in-memory WG sim too).
dev-fresh:
	rm -f docker/mock-api/state/mock-config.json
	$(MAKE) all
	docker compose -f docker-compose.dev.yml up -d --force-recreate mock-api

down:
	docker compose -f docker-compose.dev.yml down
