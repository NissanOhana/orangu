/**
 * Extra route factories plugged into the serve router:
 * `kickoffRoutes` (POST /api/kickoff), `exportRoutes` (GET /export/:id.html) and `profileRoutes` (GET /api/profile).
 */
import type { RouteFactory } from './types.js'
import { exportRoutes } from './export.js'
import { kickoffRoutes } from './kickoff.js'
import { profileRoutes } from './profile.js'

export const extraRoutes: RouteFactory[] = [kickoffRoutes, exportRoutes, profileRoutes]
