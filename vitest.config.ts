import { configDefaults, defineConfig } from 'vitest/config';

// The app's tests run from app/ with its own setup (jsdom), not here.
export default defineConfig({
  // Tests stay offline: without this the default metadata API (metadata.dev) would be asked for real.
  test: { exclude: [...configDefaults.exclude, 'app/**'], env: { METADATA_API: 'false' } },
});
