.PHONY: all up down dev dev-fresh playwright-deps playwright-visual

# Run from the repository root. Requires Go 1.22+, Docker, and `docker compose` (v2).

PLAYWRIGHT_DIR := devtools/playwright-visual

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

# Playwright: npm deps + Chromium for admin UI screenshots (devtools/playwright-visual).
playwright-deps:
	cd $(PLAYWRIGHT_DIR) && npm ci && npx playwright install chromium

playwright-visual:
	@if [ -z "$$SKIP_PLAYWRIGHT_PING" ]; then \
	  u="$${BASE_URL:-http://127.0.0.1:9080}"; \
	  curl -sf --max-time 3 "$${u%/}/" >/dev/null || { \
	    printf '%s\n' >&2 'playwright-visual: UI not reachable at '"$$u"' (hint: run `make up` from repo root first)'; \
	    exit 1; \
	  }; \
	fi
	cd $(PLAYWRIGHT_DIR) && npm run test
