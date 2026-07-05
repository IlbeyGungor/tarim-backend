#!/bin/zsh
set -euo pipefail

cd /Users/dilankaya/downloads/tarim-backend

node src/jobs/localFetchCanakkale.js | ssh deploy@46.225.61.99 'docker exec -i tarim-backend sh -lc "node src/jobs/importMarketRowsFromStdin.js"'
