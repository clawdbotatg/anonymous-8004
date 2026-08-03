# ACTA reference implementation — build/test/demo entry points.
#   make demo   -> full CLI walkthrough on anvil (real proofs, real txs)
#   make test   -> SDK + circuit witness tests + Foundry e2e
#   make setup  -> install deps, compile circuit, run dev ceremony

CIRCUITS := packages/circuits

.PHONY: demo test setup compile ceremony contracts clean

demo: setup
	node packages/demo-cli/demo.js

test: compile contracts
	npm test
	cd app/packages/foundry && forge test

setup: node_modules $(CIRCUITS)/build/acta_dev.zkey contracts

node_modules: package.json
	npm install
	touch node_modules

compile: node_modules $(CIRCUITS)/build/ActaPresentation.r1cs

$(CIRCUITS)/build/ActaPresentation.r1cs: $(CIRCUITS)/src/ActaPresentation.circom $(CIRCUITS)/src/lib/gp.circom
	cd $(CIRCUITS) && bash scripts/compile.sh

ceremony: $(CIRCUITS)/build/acta_dev.zkey

$(CIRCUITS)/build/acta_dev.zkey: $(CIRCUITS)/build/ActaPresentation.r1cs
	cd $(CIRCUITS) && bash scripts/dev-ceremony.sh

contracts:
	cd app/packages/foundry && forge build

clean:
	rm -rf $(CIRCUITS)/build app/packages/foundry/out app/packages/foundry/cache
auditor: contracts
	node packages/demo-web/seed-policies.js
	@echo "→ open http://127.0.0.1:8791/auditor.html"
	cd packages/demo-web && python3 -m http.server 8791
