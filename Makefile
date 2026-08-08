.PHONY: all up down dev dev-fresh playwright-deps playwright-visual a11y ui-behavior \
	crowdsec-install crowdsec-up crowdsec-status crowdsec-down crowdsec-logs \
	check fmt vet test test-race deadcode

# Run from the repository root. Requires Go 1.22+, Docker, and `docker compose` (v2).

# check runs the same gates as CI: formatting, vet, and the full test suite.
check: fmt vet test

# fmt fails if any Go file is not gofmt-clean (does not modify files).
fmt:
	@out="$$(gofmt -l .)"; \
	if [ -n "$$out" ]; then \
	  echo "gofmt needed on:"; echo "$$out"; \
	  echo "run: gofmt -w ."; \
	  exit 1; \
	fi

vet:
	go vet ./...

test:
	go test ./... -count=1

test-race:
	go test ./... -race -count=1

# deadcode reports unreachable functions (go install golang.org/x/tools/cmd/deadcode@latest).
deadcode:
	deadcode ./...

CROWDSEC_DIR := contrib/crowdsec

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

# Playwright: npm deps + Chromium for admin UI screenshots and axe checks (devtools/playwright-visual).
playwright-deps:
	cd $(PLAYWRIGHT_DIR) && npm ci && npx playwright install chromium

# Both Playwright targets need the dev UI answering; skip with SKIP_PLAYWRIGHT_PING=1.
define require_dev_ui
	@if [ -z "$$SKIP_PLAYWRIGHT_PING" ]; then \
	  u="$${BASE_URL:-http://127.0.0.1:9080}"; \
	  curl -sf --max-time 3 "$${u%/}/" >/dev/null || { \
	    printf '%s\n' >&2 '$(1): UI not reachable at '"$$u"' (hint: run `make up` from repo root first)'; \
	    exit 1; \
	  }; \
	fi
endef

playwright-visual:
	$(call require_dev_ui,playwright-visual)
	cd $(PLAYWRIGHT_DIR) && npm run test

# axe-core gate: fails on critical/serious WCAG 2.1 AA violations in light and dark.
a11y:
	$(call require_dev_ui,a11y)
	cd $(PLAYWRIGHT_DIR) && npm run test:a11y

# Behavioural a11y the axe gate cannot see: Escape order, focus trap, inertness.
ui-behavior:
	$(call require_dev_ui,ui-behavior)
	cd $(PLAYWRIGHT_DIR) && npm run test:behavior

# Optional CrowdSec stack (same host as EvuProxy). See contrib/crowdsec/README.md.
crowdsec-install:
	./$(CROWDSEC_DIR)/install.sh install

crowdsec-up:
	./$(CROWDSEC_DIR)/install.sh up

crowdsec-status:
	./$(CROWDSEC_DIR)/install.sh status

crowdsec-down:
	./$(CROWDSEC_DIR)/install.sh down

crowdsec-logs:
	./$(CROWDSEC_DIR)/install.sh logs
