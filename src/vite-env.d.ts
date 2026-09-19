// `import worker from 'pdfjs-dist/build/pdf.worker.min.js?url'` is the only way
// to get a stable, hashed URL for the pdf.js worker out of Vite 5. Vite rewrites
// the import into a string at build time, but tsconfig.json has no "types" entry
// so `tsc` — the project's only frontend typecheck — cannot resolve the `?url`
// suffix on its own and `npm run build` fails before Vite ever runs.
/// <reference types="vite/client" />
