/**
 * Extra route factories plugged into the serve router:
 * `kickoffRoutes` (POST /api/kickoff) and `exportRoutes` (GET /export/:id.html).
 */
import type { RouteFactory } from './types.js'
import { exportRoutes } from './export.js'
import { kickoffRoutes } from './kickoff.js'

export const extraRoutes: RouteFactory[] = [kickoffRoutes, exportRoutes]
