import { configDefaults, defineConfig } from 'vitest/config';

// The app's tests run from app/ with its own setup (jsdom), not here.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, 'app/**'] },
});
