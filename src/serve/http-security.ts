/** HTTP-only protections for HTML served from the loopback app. */
export const HTML_ANTI_FRAMING_HEADERS = {
  'Content-Security-Policy': "frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
} as const
