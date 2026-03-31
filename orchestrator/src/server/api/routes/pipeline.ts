import { resolve } from "node:path";
import {
  AppError,
  badRequest,
  conflict,
  notFound,
  requestTimeout,
  serviceUnavailable,
} from "@infra/errors";
import { fail, ok, okWithMeta } from "@infra/http";
import { logger } from "@infra/logger";
import { runWithRequestContext } from "@infra/request-context";
import { setupSse, startSseHeartbeat, writeSseData } from "@infra/sse";
import { isDemoMode } from "@server/config/demo";
import {
  type ExtractorRegistry,
  getExtractorRegistry,
} from "@server/extractors/registry";
import {
  getPendingChallenges,
  getPipelineStatus,
  requestPipelineCancel,
  resolvePipelineChallenge,
  runPipeline,
  subscribeToProgress,
} from "@server/pipeline/index";
import * as pipelineRepo from "@server/repositories/pipeline";
import { simulatePipelineRun } from "@server/services/demo-simulator";
import { PIPELINE_EXTRACTOR_SOURCE_IDS } from "@shared/extractors";
import type { PipelineStatusResponse } from "@shared/types";
import { type Request, type Response, Router } from "express";
import { z } from "zod";

export const pipelineRouter = Router();

/**
 * GET /api/pipeline/status - Get pipeline status
 */
pipelineRouter.get("/status", async (_req: Request, res: Response) => {
  try {
    const { isRunning } = getPipelineStatus();
    const lastRun = await pipelineRepo.getLatestPipelineRun();
    const data: PipelineStatusResponse = {
      isRunning,
      lastRun,
      nextScheduledRun: null,
    };
    ok(res, data);
  } catch (error) {
    fail(
      res,
      new AppError({
        status: 500,
        code: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
    );
  }
});

/**
 * GET /api/pipeline/progress - Server-Sent Events endpoint for live progress
 */
pipelineRouter.get("/progress", (req: Request, res: Response) => {
  setupSse(res, { disableBuffering: true });

  // Send initial progress
  const sendProgress = (data: unknown) => {
    writeSseData(res, data);
  };

  // Subscribe to progress updates
  const unsubscribe = subscribeToProgress(sendProgress);

  // Send heartbeat every 30 seconds to keep connection alive
  const stopHeartbeat = startSseHeartbeat(res);

  // Cleanup on close
  req.on("close", () => {
    stopHeartbeat();
    unsubscribe();
  });
});

/**
 * GET /api/pipeline/runs - Get recent pipeline runs
 */
pipelineRouter.get("/runs", async (_req: Request, res: Response) => {
  try {
    const runs = await pipelineRepo.getRecentPipelineRuns(20);
    ok(res, runs);
  } catch (error) {
    fail(
      res,
      new AppError({
        status: 500,
        code: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
    );
  }
});

/**
 * POST /api/pipeline/run - Trigger the pipeline manually
 */
const runPipelineSchema = z.object({
  topN: z.number().min(1).max(50).optional(),
  minSuitabilityScore: z.number().min(0).max(100).optional(),
  sources: z
    .array(
      z.enum(
        PIPELINE_EXTRACTOR_SOURCE_IDS as [
          (typeof PIPELINE_EXTRACTOR_SOURCE_IDS)[number],
          ...(typeof PIPELINE_EXTRACTOR_SOURCE_IDS)[number][],
        ],
      ),
    )
    .min(1)
    .optional(),
});

pipelineRouter.post("/run", async (req: Request, res: Response) => {
  try {
    const config = runPipelineSchema.parse(req.body);
    if (config.sources && config.sources.length > 0) {
      let registry: ExtractorRegistry;
      try {
        registry = await getExtractorRegistry();
      } catch (error) {
        logger.error(
          "Extractor registry unavailable during source validation",
          {
            route: "/api/pipeline/run",
            error,
          },
        );
        return fail(
          res,
          serviceUnavailable(
            "Extractor registry is unavailable. Try again after fixing startup errors.",
          ),
        );
      }
      const unavailableSources = config.sources.filter(
        (source) => !registry.manifestBySource.has(source),
      );
      if (unavailableSources.length > 0) {
        return fail(
          res,
          badRequest(
            `Requested sources are not available at runtime: ${unavailableSources.join(", ")}`,
            { unavailableSources },
          ),
        );
      }
    }

    if (isDemoMode()) {
      const simulated = await simulatePipelineRun(config);
      return okWithMeta(res, simulated, { simulated: true });
    }

    // Start pipeline in background
    runWithRequestContext({}, () => {
      runPipeline(config).catch((error) => {
        logger.error("Background pipeline run failed", error);
      });
    });
    ok(res, { message: "Pipeline started" });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return fail(res, badRequest(error.message, error.flatten()));
    }
    if (error instanceof Error && error.name === "AbortError") {
      return fail(res, requestTimeout("Request timed out"));
    }
    fail(
      res,
      new AppError({
        status: 500,
        code: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
    );
  }
});

/**
 * POST /api/pipeline/cancel - Request cancellation of active pipeline run
 */
pipelineRouter.post("/cancel", async (_req: Request, res: Response) => {
  try {
    const cancelResult = requestPipelineCancel();
    if (!cancelResult.accepted) {
      return fail(res, conflict("No running pipeline to cancel"));
    }

    logger.info("Pipeline cancellation requested", {
      route: "/api/pipeline/cancel",
      action: "cancel",
      status: "accepted",
      pipelineRunId: cancelResult.pipelineRunId,
      alreadyRequested: cancelResult.alreadyRequested,
    });

    ok(res, {
      message: cancelResult.alreadyRequested
        ? "Pipeline cancellation already requested"
        : "Pipeline cancellation requested",
      pipelineRunId: cancelResult.pipelineRunId,
      alreadyRequested: cancelResult.alreadyRequested,
    });
  } catch (error) {
    fail(
      res,
      new AppError({
        status: 500,
        code: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
    );
  }
});

/**
 * GET /api/pipeline/challenges - Returns pending Cloudflare challenges
 *
 * Non-empty only when the pipeline is paused at the "challenge_required" step.
 */
pipelineRouter.get("/challenges", (_req: Request, res: Response) => {
  ok(res, { challenges: getPendingChallenges() });
});

/**
 * POST /api/pipeline/solve-challenge - Opens a headed browser for a human to
 * solve a Cloudflare challenge.
 *
 * Blocks until the challenge is solved or times out (~5 min). On success the
 * pipeline automatically resumes — no separate "resume" call needed.
 *
 * The solved cookies are persisted to the extractor's storage directory so
 * the subsequent headless retry (and future runs) can reuse them.
 */
const solveChallengeSchema = z.object({
  extractorId: z.string().min(1),
});

pipelineRouter.post("/solve-challenge", async (req: Request, res: Response) => {
  try {
    const body = solveChallengeSchema.parse(req.body);

    const pending = getPendingChallenges();
    const match = pending.find((c) => c.extractorId === body.extractorId);
    if (!match) {
      return fail(
        res,
        notFound(`No pending challenge for extractor "${body.extractorId}"`),
      );
    }

    // Use the server-side challenge URL, not the client-supplied one.
    // The client sends url for display/convenience, but the server is the
    // source of truth — prevents solving a different URL than the one that
    // actually triggered the challenge.
    const challengeUrl = match.url;

    logger.info("Launching challenge solver", {
      route: "/api/pipeline/solve-challenge",
      extractorId: body.extractorId,
      url: challengeUrl,
    });

    // Resolve the extractor's storage directory so cookies are saved where
    // the extractor reads them from on the next headless run.
    // Convention: each Playwright extractor stores cookies at
    // extractors/<id>/storage/<id>-cookies.json  (see browser-utils/cookies.ts)
    const storageDir = resolve(
      process.cwd(),
      `../extractors/${body.extractorId}/storage`,
    );

    // Dynamic import: browser-utils pulls in playwright which is heavy.
    // A top-level import would slow down every server startup even though
    // most pipeline runs never hit a challenge.
    const { solveChallenge } = await import("browser-utils");
    const result = await solveChallenge(
      challengeUrl,
      body.extractorId,
      storageDir,
    );

    if (result.status === "solved") {
      const { remaining } = resolvePipelineChallenge(body.extractorId);

      logger.info("Challenge solved", {
        route: "/api/pipeline/solve-challenge",
        extractorId: body.extractorId,
        challengesRemaining: remaining,
      });

      ok(res, {
        status: "solved",
        extractorId: body.extractorId,
        challengesRemaining: remaining,
      });
    } else {
      logger.warn("Challenge solver did not succeed", {
        route: "/api/pipeline/solve-challenge",
        extractorId: body.extractorId,
        solverStatus: result.status,
      });

      if (result.status === "timeout") {
        fail(
          res,
          requestTimeout(
            "Challenge timed out — browser was open for 5 minutes without the challenge being solved",
          ),
        );
      } else {
        fail(res, serviceUnavailable(`Solver error: ${result.message}`));
      }
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return fail(res, badRequest(error.message, error.flatten()));
    }
    fail(
      res,
      new AppError({
        status: 500,
        code: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : "Unknown error",
      }),
    );
  }
});
