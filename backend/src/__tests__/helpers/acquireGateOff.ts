import type { NextFunction, Request, Response } from "express";

/**
 * Stands in for requireAcquirePermission in route tests about what happens past the download gate. The gate
 * itself is tested in routes/__tests__/acquirePermission.route.test.ts.
 */
export const acquireGateOff = (_req: Request, _res: Response, next: NextFunction): void => next();
