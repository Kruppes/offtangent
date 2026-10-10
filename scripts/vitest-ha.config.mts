/** Bounded HA + existing interview regression suite; no live DATA_DIR access. */
import {fileURLToPath} from 'node:url'
import {defineConfig} from 'vitest/config'
export default defineConfig({
 root:fileURLToPath(new URL('..',import.meta.url)),
 resolve:{alias:{'@axiom/core':fileURLToPath(new URL('../packages/core/src/index.ts',import.meta.url))}},
 test:{globals:true,environment:'node',pool:'forks',maxWorkers:1,
  poolOptions:{forks:{execArgv:['--max-old-space-size=2048']}},
  setupFiles:[fileURLToPath(new URL('../vitest.setup.ts',import.meta.url))],
  include:['packages/core/src/ha-json.test.ts','packages/core/src/ha-provider-auth.test.ts','packages/core/src/provider-config.test.ts','packages/web-backend/src/integrations/ha-relay.test.ts','packages/core/src/ha-inference.haiku.test.ts','packages/core/src/ha-inference.test.ts','packages/core/src/ha-inference.subscription.test.ts','packages/core/src/isolated-inference.test.ts','packages/core/src/isolated-inference.fault.test.ts'],
 },
})
