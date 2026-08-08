import { createHash, randomUUID } from "node:crypto";
import { appendFile, open } from "node:fs/promises";
import { dirname } from "node:path";
import { IntegralError } from "./errors.ts";
import { atomicWrite, ensureDir, readText } from "./fs.ts";
import type { ModelSelection } from "./model-selection.ts";
import type { IntegralPaths } from "./paths.ts";
import type { ContainerPackageOperation } from "./container-packages.ts";

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "stale"
  | "succeeded"
  | "failed";
export type TerminalApprovalStatus = Exclude<
  ApprovalStatus,
  "pending" | "approved"
>;

export interface PackageApprovalRequest {
  kind: "container-packages";
  operation: ContainerPackageOperation;
  packages: string[];
  expectedRevision: number;
}

export interface ApprovalRecord {
  schemaVersion: 1;
  id: string;
  status: ApprovalStatus;
  summary: string;
  requestDigest: string;
  request: PackageApprovalRequest;
  origin: {
    sessionId: string;
    runId?: string;
    selection: ModelSelection;
  };
  createdAt: string;
  expiresAt: string;
  decision?: {
    outcome: "approved" | "denied";
    terminalId: string;
    at: string;
  };
  execution?: {
    at: string;
    result?: Record<string, unknown>;
    error?: string;
  };
  continuationMessageId?: string;
}

export interface PublicApproval {
  id: string;
  status: ApprovalStatus;
  summary: string;
  requestDigest: string;
  originSessionId: string;
  originRunId?: string;
  createdAt: string;
  expiresAt: string;
  decision?: ApprovalRecord["decision"];
  execution?: ApprovalRecord["execution"];
}

interface ApprovalFile {
  schemaVersion: 1;
  approvals: ApprovalRecord[];
}

const terminalStatuses = new Set<TerminalApprovalStatus>([
  "denied",
  "expired",
  "stale",
  "succeeded",
  "failed",
]);

export function isTerminalApproval(
  record: ApprovalRecord,
): record is ApprovalRecord & { status: TerminalApprovalStatus } {
  return terminalStatuses.has(record.status as TerminalApprovalStatus);
}

export function publicApproval(record: ApprovalRecord): PublicApproval {
  return {
    id: record.id,
    status: record.status,
    summary: record.summary,
    requestDigest: record.requestDigest,
    originSessionId: record.origin.sessionId,
    ...(record.origin.runId ? { originRunId: record.origin.runId } : {}),
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    ...(record.decision ? { decision: structuredClone(record.decision) } : {}),
    ...(record.execution
      ? { execution: structuredClone(record.execution) }
      : {}),
  };
}

export class ApprovalStore {
  private approvals: ApprovalRecord[] = [];
  constructor(
    private readonly paths: IntegralPaths,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = randomUUID,
  ) {}

  async load(): Promise<void> {
    const raw = await readText(this.paths.approvals);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as ApprovalFile;
      if (
        parsed.schemaVersion !== 1 ||
        !Array.isArray(parsed.approvals) ||
        parsed.approvals.some((record) => !validRecord(record))
      )
        throw new Error("invalid approval state");
      this.approvals = structuredClone(parsed.approvals);
    } catch {
      throw new IntegralError(`invalid approval file: ${this.paths.approvals}`);
    }
  }

  snapshot(): PublicApproval[] {
    return this.approvals.map(publicApproval);
  }

  records(): ApprovalRecord[] {
    return structuredClone(this.approvals);
  }

  get(id: string): ApprovalRecord {
    const record = this.approvals.find((candidate) => candidate.id === id);
    if (!record) throw new IntegralError(`approval ${id} was not found`, 404);
    return structuredClone(record);
  }

  async create(input: {
    request: PackageApprovalRequest;
    sessionId: string;
    runId?: string;
    selection: ModelSelection;
    deadlineMs?: number;
  }): Promise<ApprovalRecord> {
    const created = this.now(),
      packages = [...input.request.packages].sort(),
      request = { ...input.request, packages },
      canonical = JSON.stringify(request),
      record: ApprovalRecord = {
        schemaVersion: 1,
        id: this.newId(),
        status: "pending",
        summary: `${request.operation} Debian packages: ${packages.join(", ")}`,
        requestDigest: createHash("sha256").update(canonical).digest("hex"),
        request,
        origin: {
          sessionId: input.sessionId,
          ...(input.runId ? { runId: input.runId } : {}),
          selection: structuredClone(input.selection),
        },
        createdAt: new Date(created).toISOString(),
        expiresAt: new Date(
          created + (input.deadlineMs ?? 600_000),
        ).toISOString(),
      };
    this.approvals.push(record);
    await this.persistTransition(record);
    return structuredClone(record);
  }

  async decide(
    id: string,
    outcome: "approved" | "denied",
    terminalId: string,
  ): Promise<ApprovalRecord> {
    const record = this.mutable(id);
    if (record.status !== "pending")
      throw new IntegralError(
        `approval ${id} is already ${record.status}`,
        409,
      );
    record.status = outcome;
    record.decision = {
      outcome,
      terminalId,
      at: new Date(this.now()).toISOString(),
    };
    await this.persistTransition(record);
    return structuredClone(record);
  }

  async resolveExecution(
    id: string,
    outcome:
      | { status: "succeeded"; result: Record<string, unknown> }
      | { status: "failed" | "stale"; error: string },
  ): Promise<ApprovalRecord> {
    const record = this.mutable(id);
    if (record.status !== "approved")
      throw new IntegralError(`approval ${id} is not approved`, 409);
    record.status = outcome.status;
    record.execution = {
      at: new Date(this.now()).toISOString(),
      ...(outcome.status === "succeeded"
        ? { result: structuredClone(outcome.result) }
        : { error: outcome.error }),
    };
    await this.persistTransition(record);
    return structuredClone(record);
  }

  async expireDue(): Promise<ApprovalRecord[]> {
    const now = this.now(),
      expired = this.approvals.filter(
        (record) =>
          record.status === "pending" && Date.parse(record.expiresAt) <= now,
      );
    for (const record of expired) {
      record.status = "expired";
      record.execution = {
        at: new Date(now).toISOString(),
        error: "human approval expired",
      };
      await this.persistTransition(record);
    }
    return structuredClone(expired);
  }

  async setContinuation(id: string, messageId: string): Promise<void> {
    const record = this.mutable(id);
    if (!isTerminalApproval(record))
      throw new IntegralError(`approval ${id} is not resolved`, 409);
    if (record.continuationMessageId === messageId) return;
    if (record.continuationMessageId)
      throw new IntegralError(`approval ${id} already has a continuation`, 409);
    record.continuationMessageId = messageId;
    await this.persistTransition(record);
  }

  private mutable(id: string): ApprovalRecord {
    const record = this.approvals.find((candidate) => candidate.id === id);
    if (!record) throw new IntegralError(`approval ${id} was not found`, 404);
    return record;
  }

  private async persistTransition(record: ApprovalRecord): Promise<void> {
    await atomicWrite(
      this.paths.approvals,
      `${JSON.stringify({ schemaVersion: 1, approvals: this.approvals })}\n`,
    );
    await ensureDir(dirname(this.paths.approvalAudit));
    await appendFile(
      this.paths.approvalAudit,
      `${JSON.stringify({
        schemaVersion: 1,
        approvalId: record.id,
        status: record.status,
        summary: record.summary,
        requestDigest: record.requestDigest,
        originSessionId: record.origin.sessionId,
        ...(record.origin.runId ? { originRunId: record.origin.runId } : {}),
        decision: record.decision,
        execution: record.execution,
        at: new Date(this.now()).toISOString(),
      })}\n`,
      { mode: 0o600 },
    );
    const handle = await open(this.paths.approvalAudit, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

function validRecord(value: unknown): value is ApprovalRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ApprovalRecord>;
  return (
    record.schemaVersion === 1 &&
    typeof record.id === "string" &&
    typeof record.summary === "string" &&
    typeof record.requestDigest === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.expiresAt === "string" &&
    typeof record.status === "string" &&
    [
      "pending",
      "approved",
      "denied",
      "expired",
      "stale",
      "succeeded",
      "failed",
    ].includes(record.status) &&
    record.request?.kind === "container-packages" &&
    (record.request.operation === "install" ||
      record.request.operation === "upgrade") &&
    Array.isArray(record.request.packages) &&
    Number.isInteger(record.request.expectedRevision) &&
    record.request.expectedRevision >= 0 &&
    typeof record.origin?.sessionId === "string" &&
    record.origin.sessionId.length > 0 &&
    typeof record.origin.selection?.piImage === "string"
  );
}
