/**
 * GET /api/profile: whether the profile of the interview exists, and the date of a valid one. The body is exactly
 * `{ exists, updatedAt }`, with no path and no profile value, so the app can say whether an interview ran and when.
 * `updatedAt` is null when no file reads as profile v1 (src/suggest/profile.ts).
 */
import { profileStatus } from '../suggest/profile.js'
import type { RouteFactory } from './types.js'

export const profileRoutes: RouteFactory = () => [
  {
    method: 'GET',
    path: '/api/profile',
    handler: async (_m, _req, res) => {
      const { exists, updatedAt } = await profileStatus()
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ exists, updatedAt }))
    },
  },
]
