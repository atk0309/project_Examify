// Vitest stub for the `server-only` package. The real package throws at
// import time outside of a server bundle; in tests we just want it to be a
// no-op so we can exercise the modules that mark themselves server-only.
export {};
