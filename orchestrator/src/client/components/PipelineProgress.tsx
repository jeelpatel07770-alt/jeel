/**
 * Live pipeline progress display component.
 */

import {
  sourceLabel as getSourceLabel,
  isExtractorSourceId,
} from "@shared/extractors";
import { Loader2, ShieldAlert } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { subscribeToEventSource } from "@/client/lib/sse";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

interface PipelineProgress {
  step:
    | "idle"
    | "crawling"
    | "challenge_required"
    | "importing"
    | "scoring"
    | "processing"
    | "completed"
    | "cancelled"
    | "failed";
  message: string;
  detail?: string;
  pendingChallenges?: Array<{
    extractorId: string;
    extractorName: string;
    url: string;
  }>;
  crawlingSource: string | null;
  crawlingSourcesCompleted: number;
  crawlingSourcesTotal: number;
  crawlingTermsProcessed: number;
  crawlingTermsTotal: number;
  crawlingListPagesProcessed: number;
  crawlingListPagesTotal: number;
  crawlingJobCardsFound: number;
  crawlingJobPagesEnqueued: number;
  crawlingJobPagesSkipped: number;
  crawlingJobPagesProcessed: number;
  crawlingPhase?: "list" | "job";
  crawlingCurrentUrl?: string;
  jobsDiscovered: number;
  jobsScored: number;
  jobsProcessed: number;
  totalToProcess: number;
  currentJob?: {
    id: string;
    title: string;
    employer: string;
  };
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

interface PipelineProgressProps {
  isRunning: boolean;
}

const stepLabels: Record<PipelineProgress["step"], string> = {
  idle: "Ready",
  crawling: "Crawling",
  challenge_required: "Challenge",
  importing: "Importing",
  scoring: "Scoring",
  processing: "Processing",
  completed: "Complete",
  cancelled: "Cancelled",
  failed: "Failed",
};

const stepBadgeClasses: Record<PipelineProgress["step"], string> = {
  idle: "bg-muted text-muted-foreground border-border",
  crawling: "bg-sky-500/10 text-sky-400 border-sky-500/20",
  challenge_required: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  importing: "bg-sky-500/10 text-sky-400 border-sky-500/20",
  scoring: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  processing: "bg-primary/10 text-primary border-primary/20",
  completed: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  cancelled: "bg-muted text-muted-foreground border-border",
  failed: "bg-destructive/10 text-destructive border-destructive/20",
};

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

function resolveSourceLabel(source: string): string {
  if (source === "jobspy") return "JobSpy";
  if (isExtractorSourceId(source)) return getSourceLabel(source);
  return source;
}

export const PipelineProgress: React.FC<PipelineProgressProps> = ({
  isRunning,
}) => {
  const [progress, setProgress] = useState<PipelineProgress | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [solvingExtractor, setSolvingExtractor] = useState<string | null>(null);

  const handleSolveChallenge = useCallback(async (extractorId: string) => {
    setSolvingExtractor(extractorId);
    try {
      // Open noVNC viewer so the user can see and click the CF challenge.
      // In Docker, the solver renders Firefox on a virtual display exposed
      // via noVNC on port 6080. Locally (non-Docker) this tab won't connect
      // but that's fine - the solver opens a native window instead.
      // The tab opens BEFORE the POST because the solver blocks until
      // the challenge is resolved or times out (up to 5 minutes).
      const vncUrl = `${window.location.protocol}//${window.location.hostname}:6080/vnc.html?autoconnect=true`;
      window.open(vncUrl, "_blank", "noopener");

      const res = await fetch("/api/pipeline/solve-challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ extractorId }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        console.error("Solve challenge failed:", data.error ?? res.statusText);
      }
    } catch (err) {
      console.error("Solve challenge request failed:", err);
    } finally {
      setSolvingExtractor(null);
    }
  }, []);

  const percentage = useMemo(() => {
    if (!progress) return 0;

    switch (progress.step) {
      case "challenge_required":
        return 15;
      case "crawling": {
        if (progress.crawlingTermsTotal > 0) {
          return clamp(
            5 +
              (progress.crawlingTermsProcessed / progress.crawlingTermsTotal) *
                10,
            5,
            15,
          );
        }
        if (progress.crawlingListPagesTotal > 0) {
          return clamp(
            (progress.crawlingListPagesProcessed /
              progress.crawlingListPagesTotal) *
              15,
            0,
            15,
          );
        }
        if (progress.crawlingListPagesProcessed > 0) return 8;
        return 5;
      }
      case "importing":
        return 20;
      case "scoring": {
        if (progress.jobsScored > 0) {
          return clamp(
            20 +
              (progress.jobsScored / Math.max(progress.jobsDiscovered, 1)) * 30,
            20,
            50,
          );
        }
        return 25;
      }
      case "processing": {
        if (progress.totalToProcess > 0) {
          return clamp(
            50 + (progress.jobsProcessed / progress.totalToProcess) * 50,
            50,
            100,
          );
        }
        return 55;
      }
      case "completed":
      case "cancelled":
      case "failed":
        return 100;
      default:
        return 0;
    }
  }, [progress]);

  useEffect(() => {
    if (!isRunning) {
      setProgress(null);
      setIsConnected(false);
      return;
    }

    const unsubscribe = subscribeToEventSource<PipelineProgress>(
      "/api/pipeline/progress",
      {
        onOpen: () => {
          setIsConnected(true);
        },
        onMessage: (payload) => {
          setProgress(payload);
        },
        onError: () => {
          setIsConnected(false);
        },
      },
    );

    return () => {
      unsubscribe();
      setIsConnected(false);
    };
  }, [isRunning]);

  if (!isRunning && !progress) {
    return null;
  }

  const step = progress?.step ?? "idle";
  const isActive =
    step !== "idle" &&
    step !== "completed" &&
    step !== "cancelled" &&
    step !== "failed";
  const listPagesText = progress
    ? progress.crawlingListPagesTotal > 0
      ? `${progress.crawlingListPagesProcessed}/${progress.crawlingListPagesTotal}`
      : progress.crawlingListPagesProcessed > 0
        ? `${progress.crawlingListPagesProcessed}`
        : "—"
    : "—";
  const jobPagesText = progress
    ? progress.crawlingJobPagesEnqueued > 0
      ? `${progress.crawlingJobPagesProcessed}/${progress.crawlingJobPagesEnqueued}`
      : progress.crawlingJobPagesProcessed > 0
        ? `${progress.crawlingJobPagesProcessed}`
        : "—"
    : "—";

  const showStats =
    !!progress &&
    ["crawling", "scoring", "processing", "completed", "cancelled"].includes(
      step,
    );

  return (
    <Card>
      <CardHeader className="space-y-2">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <CardTitle className="text-base">Pipeline</CardTitle>
            <Badge
              variant="outline"
              className={cn("uppercase tracking-wide", stepBadgeClasses[step])}
            >
              {stepLabels[step]}
            </Badge>
            <span className="truncate text-xs text-muted-foreground">
              {isConnected ? "Live" : "Connecting…"}
            </span>
          </div>

          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {isActive && <Loader2 className="h-4 w-4 animate-spin" />}
            <span className="tabular-nums">{Math.round(percentage)}%</span>
          </div>
        </div>

        <Progress value={percentage} className="h-2" />
      </CardHeader>

      {progress && (
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <p className="text-sm">{progress.message}</p>
            {progress.detail && (
              <p className="text-sm text-muted-foreground">{progress.detail}</p>
            )}
            {step === "crawling" && (
              <p className="text-xs text-muted-foreground">
                Source:{" "}
                {progress.crawlingSource
                  ? resolveSourceLabel(progress.crawlingSource)
                  : "starting"}
                {"  "}({progress.crawlingSourcesCompleted}/
                {Math.max(progress.crawlingSourcesTotal, 0)})
                {progress.crawlingTermsTotal > 0 && (
                  <>
                    {"  "}
                    Terms: {progress.crawlingTermsProcessed}/
                    {progress.crawlingTermsTotal}
                  </>
                )}
              </p>
            )}
          </div>

          {showStats && (
            <>
              <Separator />
              <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                {step === "crawling" ? (
                  <>
                    <div>
                      <div className="text-xs text-muted-foreground">
                        List pages
                      </div>
                      <div className="tabular-nums">{listPagesText}</div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">
                        Job pages
                      </div>
                      <div className="tabular-nums">{jobPagesText}</div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">
                        Enqueued
                      </div>
                      <div className="tabular-nums">
                        {progress.crawlingJobPagesEnqueued}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">
                        Skipped
                      </div>
                      <div className="tabular-nums">
                        {progress.crawlingJobPagesSkipped}
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <div>
                      <div className="text-xs text-muted-foreground">
                        Discovered
                      </div>
                      <div className="tabular-nums">
                        {progress.jobsDiscovered}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">
                        Scored
                      </div>
                      <div className="tabular-nums">{progress.jobsScored}</div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">
                        Processed
                      </div>
                      <div className="tabular-nums">
                        {progress.totalToProcess > 0
                          ? `${progress.jobsProcessed}/${progress.totalToProcess}`
                          : progress.jobsProcessed}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-muted-foreground">
                        To process
                      </div>
                      <div className="tabular-nums">
                        {progress.totalToProcess}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </>
          )}

          {step === "challenge_required" &&
            progress.pendingChallenges &&
            progress.pendingChallenges.length > 0 && (
              <div className="space-y-2">
                <Separator />
                {progress.pendingChallenges.map((challenge) => (
                  <div
                    key={challenge.extractorId}
                    className="flex items-center justify-between rounded-md border border-orange-500/20 bg-orange-500/10 p-3"
                  >
                    <div className="flex items-center gap-2 text-sm text-orange-400">
                      <ShieldAlert className="h-4 w-4 shrink-0" />
                      <span>{challenge.extractorName}</span>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-orange-500/30 text-orange-400 hover:bg-orange-500/20"
                      disabled={solvingExtractor === challenge.extractorId}
                      onClick={() =>
                        handleSolveChallenge(challenge.extractorId)
                      }
                    >
                      {solvingExtractor === challenge.extractorId ? (
                        <>
                          <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                          Solving…
                        </>
                      ) : (
                        "Solve"
                      )}
                    </Button>
                  </div>
                ))}
              </div>
            )}

          {step === "failed" && progress.error && (
            <div className="rounded-md border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
              {progress.error}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
};
