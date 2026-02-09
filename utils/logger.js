// Dev-only logger — suppresses debug output in production
const isDev = process.env.NODE_ENV !== 'production'

module.exports = {
  error: (...args) => { if (isDev) console.error(...args) },
  log:   (...args) => { if (isDev) console.log(...args) },
  // Always log — for startup, shutdown, and critical operational messages
  info:  (...args) => console.log(...args),
}
