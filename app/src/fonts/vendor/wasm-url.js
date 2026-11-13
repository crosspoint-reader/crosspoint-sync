// Browser-only: hands freetype.js the bundler-resolved URL of the wasm binary.
// Kept in its own module so node (tests, parity harness) never evaluates the
// `?url` import, which only a bundler understands.
import wasmUrl from './wasm/freetype.wasm?url'

export default wasmUrl
