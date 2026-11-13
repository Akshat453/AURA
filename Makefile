# Shortcuts for common tasks. Everything also works with the commands shown.
# The backend is Node.js (backend/); install it with `make install`.
.PHONY: install lint test test-unit test-integration test-protocol test-security test-frontend check-env db-check db-seed db-counts db-reset start stop demo demo-stop report

install:          ; npm ci --prefix backend
lint:             ; npm run --prefix backend lint
test:             ; npm run --prefix backend lint && npm test --prefix backend
test-unit:        ; npm run --prefix backend test:unit
test-integration: ; npm run --prefix backend test:integration
test-protocol:    ; npm run --prefix backend test:protocol
test-security:    ; npm run --prefix backend test:security
test-frontend:    ; npm run --prefix backend test:frontend
check-env:        ; node backend/bin/config-check.js
db-check:         ; node backend/bin/db.js check
db-seed:          ; node backend/bin/db.js seed
db-counts:        ; node backend/bin/db.js counts
db-reset:         ; ./scripts/start-demo.sh stop && node backend/bin/db.js reset
start:            ; ./scripts/start-local.sh
stop:             ; ./scripts/stop-local.sh
demo:             ; ./scripts/start-demo.sh
demo-stop:        ; ./scripts/start-demo.sh stop
report:           ; /opt/anaconda3/bin/python docs/report/finalize.py
