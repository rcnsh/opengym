import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    globals: false,
    environment: 'node',
    pool: 'forks',
    isolate: true,
    reporters: ['default'],
    /* Pin the timezone. tools.test.js asserts against dates relative to a pinned "today" — the
       newest workout being the Friday before it, for one — which only holds if the runner sits
       near UTC. Run it in UTC+8 and the fixture dates shift a day and the assertion fails. CI
       runs in UTC and is green, so UTC is what these were written against; pinning it here makes
       a local run mean the same thing as a CI run rather than depending on where you are.
       The frontend suite does the same in frontend/vitest.setup.js, which additionally has to
       shim Web Storage for Node 26. */
    env: { TZ: 'UTC' }
  }
})
