import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Context } from "@temporalio/activity";
import { ApplicationFailure, TimeoutFailure } from "@temporalio/client";
import { DeterminismViolationError } from "@temporalio/workflow";
import { Worker } from "@temporalio/worker";
import { DOT_GOAL_SIGNAL, ROOM_AGENT_ENQUEUE_SIGNAL, ROOM_AGENT_STOP_SIGNAL, roomAgentSupervisorInputSchema,
  roomAgentSupervisorQueueItemSchema } from "@space/contracts";
import { continuationFixture } from "./room-continuation-fixture.js";
import { discardSupervisorTurn, finishSupervisorTurn, prepareBackgroundContinuation, supervisorTurnState } from "../src/room-background-continuation.js";
import { WorkflowSandbox, deferred, inputFromHistory, until } from "./support/workflow-sandbox.js";

const sandbox = new WorkflowSandbox();
vi.setConfig({ testTimeout: 45_000, hookTimeout: 90_000 });
const completed = { status: "COMPLETED", message: "Synthetic result", roomAgentOutcome: {
  status: "VERIFIED", executedActionCount: 1, statusReason: "Synthetic evidence verified."
} };
const roomId = "room:synthetic";
const turn = (suffix: string) => roomAgentSupervisorQueueItemSchema.parse({ missionId: `mission:${suffix}`, turn: {
  roomId, paneId: "pane:synthetic", prompt: `Synthetic request ${suffix}`, traceId: `trace:${suffix}`,
  agentRunId: `agent_run:${suffix}`, roomAgentMissionId: `mission:${suffix}`
} });

function defaults() {
  const noop = () => vi.fn(async () => undefined);
  return {
    recordDummyTurnStarted: noop(), recordDummyTurnCompleted: vi.fn(async () => completed),
    runOpenCodeAgentTurn: vi.fn(async () => completed), runCliAgentTurn: vi.fn(async () => completed),
    runCodexAppServerTurn: vi.fn(async () => completed), dotGoalStep: vi.fn(async () => ({ state: "DONE", runId: null, goalStatus: "COMPLETED" })),
    dotGoalObserve: vi.fn(async () => ({ run: "COMPLETED", goalStatus: "COMPLETED" })),
    markRoomAgentMissionStarted: noop(), markRoomAgentMissionFinished: noop(), markRoomAgentMissionContinued: noop(),
    checkRoomAgentSupervisorTurn: vi.fn(async () => "RUN"), discardRoomAgentSupervisorTurn: noop(), finishRoomAgentSupervisorTurn: noop(),
    prepareRoomAgentBackgroundContinuation: vi.fn(async () => ({ state: "DONE" })), settleRoomAgentBackgroundMission: vi.fn(async () => true),
    runRoomAgentBackgroundAction: vi.fn(async () => completed), failRoomAgentBackgroundAction: noop(),
    refreshMemoryGraphSnapshot: vi.fn(async () => ({ status: "REFRESHED", sourceHash: "a".repeat(64) })),
    refreshAllMonthsMemoryGraphSnapshot: noop(), reconcileStaleSpaceAgentSessions: noop(),
    createScheduledMemoryAudit: vi.fn(async () => ({ id: "audit:synthetic", workflowId: "consolidation:synthetic" })),
    prepareMemoryConsolidation: vi.fn(async () => ({ run: { id: "audit:synthetic", status: "COMPLETED" }, changeSetId: null as string | null })),
    finalizeMemoryRepair: vi.fn(async () => ({ id: "audit:synthetic", status: "COMPLETED" })),
    executePersistedMemoryChangeSet: vi.fn(async () => ({ status: "APPLIED", changeSetId: "change:synthetic", resultingSourceHash: "b".repeat(64), reason: null }))
  };
}
let activities = defaults();

function continuationDriver() {
  const fixture = continuationFixture();
  const child = vi.fn(async (input: any) => {
    fixture.store.updateSpaceAgentRun(input.agentRunId, { status: "COMPLETED" });
    return completed;
  });
  Object.assign(activities, {
    prepareRoomAgentBackgroundContinuation: vi.fn((input) => prepareBackgroundContinuation(input, fixture.store)),
    checkRoomAgentSupervisorTurn: vi.fn((item) => supervisorTurnState(item, fixture.store)),
    discardRoomAgentSupervisorTurn: vi.fn(({ item, reason, errorCode }) => discardSupervisorTurn(item, reason, fixture.store, errorCode)),
    finishRoomAgentSupervisorTurn: vi.fn((input) => finishSupervisorTurn(input, fixture.store)),
    runCodexAppServerTurn: child
  });
  return { ...fixture, child, input: roomAgentSupervisorInputSchema.parse({ roomId: fixture.room.id,
    monitoringMissionIds: [fixture.initial.mission.id] }) };
}

describe.sequential("real Temporal sandbox and immutable replay gate", () => {
  beforeAll(() => sandbox.open(), 90_000);
  beforeEach(() => { activities = defaults(); sandbox.activities = activities; });
  afterAll(async () => { try { await sandbox.writeRecording(); } finally { await sandbox.close(); } }, 90_000);

  it("runs the dummy turn in order and retries an activity failure", async () => {
    const order: string[] = [];
    activities.recordDummyTurnStarted.mockImplementation(async () => {
      order.push("start"); if (order.length === 1) throw Error("Synthetic transient start failure");
    });
    activities.recordDummyTurnCompleted.mockImplementation(async () => { order.push("complete"); return completed; });
    const handle = await sandbox.start("main", "dummyTurnWorkflow", turn("dummy").turn);
    expect(await handle.result()).toEqual(completed);
    expect(order).toEqual(["start", "start", "complete"]);
    await sandbox.archive(handle, "dummy-retry");
  });

  it.each([
    ["opencode", { providerId: "opencode" }, "runOpenCodeAgentTurn", 1],
    ["cli", { providerId: "cli:claude" }, "runCliAgentTurn", 1],
    ["room", {}, "runCodexAppServerTurn", 5],
    ["native", { agentSessionId: "session:synthetic", agentAssistantMessageId: "message:synthetic", roomAgentMissionId: undefined }, "runCodexAppServerTurn", 5]
  ] as const)("uses the production %s turn route and retry policy", async (name, overrides, activity, maximumAttempts) => {
    const handle = await sandbox.start("main", "codexAppServerTurnWorkflow", { ...turn(`route-${name}`).turn, ...overrides });
    expect(await handle.result()).toEqual(completed);
    const history = await sandbox.firstHistory(handle);
    const scheduled = history.events!.find((event) => event.activityTaskScheduledEventAttributes)!.activityTaskScheduledEventAttributes!;
    expect(scheduled.activityType?.name).toBe(activity);
    expect(scheduled.retryPolicy?.maximumAttempts).toBe(maximumAttempts);
    await sandbox.archive(handle, `turn-${name}`);
  });

  it("fires the real 30-second goal timer when no wake arrives", async () => {
    activities.dotGoalStep.mockResolvedValueOnce({ state: "WAITING", runId: null, goalStatus: "ACTIVE" });
    const handle = await sandbox.start("main", "dotGoalWorkflow", { goalId: "goal:timeout" });
    expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
    const history = await sandbox.firstHistory(handle);
    expect(history.events!.some((event) => event.timerStartedEventAttributes?.startToFireTimeout?.seconds?.toString() === "30")).toBe(true);
    expect(history.events!.some((event) => event.timerFiredEventAttributes)).toBe(true);
    await sandbox.archive(handle, "goal-timeout");
  });

  it("retries a room turn activity before returning the successful result", async () => {
    activities.runCodexAppServerTurn.mockRejectedValueOnce(Error("Synthetic transient turn failure"));
    const handle = await sandbox.start("main", "codexAppServerTurnWorkflow", turn("retried").turn);
    expect(await handle.result()).toEqual(completed);
    expect(activities.runCodexAppServerTurn).toHaveBeenCalledTimes(2);
    await sandbox.archive(handle, "turn-retry");
  });

  it("observes an active goal after the real 15-second timer and retries observation", async () => {
    activities.dotGoalStep.mockResolvedValueOnce({ state: "STARTED", runId: "run:synthetic", goalStatus: "ACTIVE" });
    activities.dotGoalObserve.mockRejectedValueOnce(Error("Synthetic transient observation failure"));
    const handle = await sandbox.start("main", "dotGoalWorkflow", { goalId: "goal:observe" });
    expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
    expect(activities.dotGoalObserve).toHaveBeenCalledTimes(2);
    expect(activities.dotGoalObserve).toHaveBeenCalledWith("goal:observe", "run:synthetic");
    const history = await sandbox.firstHistory(handle);
    expect(history.events!.some((event) => event.timerStartedEventAttributes?.startToFireTimeout?.seconds?.toString() === "15")).toBe(true);
    await sandbox.archive(handle, "goal-observe-retry");
  });

  it("keeps a wake that arrives during the activity and avoids the next timer", async () => {
    const entered = deferred(); const release = deferred();
    activities.dotGoalStep.mockImplementationOnce(async () => { entered.resolve(); await release.promise;
      return { state: "WAITING", runId: null, goalStatus: "ACTIVE" }; });
    const handle = await sandbox.start("main", "dotGoalWorkflow", { goalId: "goal:wake" });
    try {
      await entered.promise;
      await handle.signal(DOT_GOAL_SIGNAL);
      await sandbox.flush(handle);
    } finally { release.resolve(); }
    expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
    expect(activities.dotGoalStep).toHaveBeenCalledTimes(2);
    const history = await sandbox.firstHistory(handle);
    expect(history.events!.filter((event) => event.timerStartedEventAttributes)).toHaveLength(0);
    await sandbox.archive(handle, "goal-wake");
  });

  it("continues an unfinished goal after 300 iterations with the same goal ID", async () => {
    let steps = 0;
    activities.dotGoalStep.mockImplementation(async () => (++steps > 300
      ? { state: "DONE", runId: null, goalStatus: "COMPLETED" }
      : { state: "WAITING", runId: null, goalStatus: "ACTIVE" }));
    const handle = await sandbox.start("main", "dotGoalWorkflow", { goalId: "goal:continued" });
    expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
    expect(steps).toBe(301);
    const first = await sandbox.firstHistory(handle);
    const continuation = first.events!.find((event) => event.workflowExecutionContinuedAsNewEventAttributes)!.workflowExecutionContinuedAsNewEventAttributes!;
    expect(JSON.parse(Buffer.from(continuation.input!.payloads![0]!.data!).toString())).toEqual({ goalId: "goal:continued" });
    await sandbox.archive(handle, "goal-continued");
  }, 45_000);

  it.each(["main", "legacy"] as const)("carries pending work and monitoring at the 50-item %s boundary", async (bundle) => {
    const input = roomAgentSupervisorInputSchema.parse({ roomId, pending: [turn(`${bundle}-first`), turn(`${bundle}-next`)],
      monitoringMissionIds: ["mission:monitor"], processedCount: 49 });
    const handle = await sandbox.start(bundle, "roomAgentSupervisorWorkflow", input);
    await until(async () => (await sandbox.firstHistory(handle)).events!.some((event) => event.workflowExecutionContinuedAsNewEventAttributes), "supervisor continuation");
    const first = await sandbox.firstHistory(handle);
    const continued = first.events!.find((event) => event.workflowExecutionContinuedAsNewEventAttributes)!.workflowExecutionContinuedAsNewEventAttributes!;
    const carried = JSON.parse(Buffer.from(continued.input!.payloads![0]!.data!).toString());
    expect(carried.pending).toEqual([turn(`${bundle}-next`)]);
    expect(carried.monitoringMissionIds).toEqual(["mission:monitor"]);
    expect(carried.processedCount).toBe(0);
    const finished = bundle === "main" ? activities.finishRoomAgentSupervisorTurn : activities.markRoomAgentMissionFinished;
    await until(() => finished.mock.calls.length === 2, "both completed child turns");
    await sandbox.archive(handle, `supervisor-${bundle}-50`);
  });

  it.each(["main", "legacy"] as const)("continues after 250 real one-second %s monitoring polls", async (bundle) => {
    let polls = 0;
    if (bundle === "main") activities.prepareRoomAgentBackgroundContinuation.mockImplementation(async () => ({ state: ++polls > 250 ? "DONE" : "WAITING" }));
    else activities.settleRoomAgentBackgroundMission.mockImplementation(async () => ++polls > 250);
    const handle = await sandbox.start(bundle, "roomAgentSupervisorWorkflow", roomAgentSupervisorInputSchema.parse({ roomId,
      monitoringMissionIds: ["mission:poll"] }));
    // result() unlocks automatic time skipping until this deliberately infinite
    // supervisor is terminated. A single manual 251-second jump can outrun the
    // workflow's newly scheduled timers and does not exercise 250 polls.
    const execution = handle.result().catch(() => undefined);
    try {
      await until(() => polls >= 251, "250-poll continuation").catch((cause) => {
        throw new Error(`${bundle}: only ${polls} monitoring polls completed`, { cause });
      });
      const first = await sandbox.firstHistory(handle);
      const calls = first.events!.filter((event) => event.activityTaskScheduledEventAttributes);
      expect(calls).toHaveLength(250);
      expect(first.events!.filter((event) => event.timerFiredEventAttributes)).toHaveLength(250);
      const continued = first.events!.find((event) => event.workflowExecutionContinuedAsNewEventAttributes)!.workflowExecutionContinuedAsNewEventAttributes!;
      const next = await sandbox.env.client.workflow.getHandle(handle.workflowId, continued.newExecutionRunId!).fetchHistory();
      expect(inputFromHistory(next).monitoringMissionIds).toEqual(["mission:poll"]);
    } finally { await sandbox.archive(handle, `supervisor-${bundle}-250`); await execution; }
  }, 45_000);

  it.each(["main", "legacy"] as const)("interrupts active and queued work through real %s stop signals", async (bundle) => {
    activities.runCodexAppServerTurn.mockImplementation(async () => {
      const context = Context.current(); const heartbeat = setInterval(() => context.heartbeat(), 20);
      try { return await context.cancelled; } finally { clearInterval(heartbeat); }
    });
    const handle = await sandbox.start(bundle, "roomAgentSupervisorWorkflow", roomAgentSupervisorInputSchema.parse({ roomId,
      pending: [turn(`${bundle}-active`), turn(`${bundle}-queued`)] }));
    await until(() => activities.runCodexAppServerTurn.mock.calls.length === 1, "running child");
    await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: null, reason: "Synthetic operator stop" });
    const finished = bundle === "main" ? activities.finishRoomAgentSupervisorTurn : activities.markRoomAgentMissionFinished;
    await until(() => finished.mock.calls.length === 2, "both interrupted outcomes");
    expect(finished.mock.calls.map(([value]) => value.status)).toEqual(["INTERRUPTED", "INTERRUPTED"]);
    expect(activities.runCodexAppServerTurn).toHaveBeenCalledOnce();
    await sandbox.archive(handle, `supervisor-${bundle}-stop`);
  });

  it("executes allocation, send and verification in the real sandbox with the in-memory store", async () => {
    const fixture = continuationDriver();
    fixture.child.mockImplementationOnce(async (input) => {
      expect(input.prompt).toContain("Open CLI and Chat, then send a story");
      fixture.store.createRoomAgentAction({ ...fixture.action, actionId: "action:send", idempotencyKey: "send-once", actionType: "SEND",
        evidence: { cli: "Story complete", chat: "Story complete" }, statusReason: "Both tasks completed." });
      fixture.store.updateSpaceAgentRun(input.agentRunId, { status: "COMPLETED" });
      return { ...completed, roomAgentOutcome: { ...completed.roomAgentOutcome, pendingActionIds: ["action:send"] } };
    });
    const handle = await sandbox.start("main", "roomAgentSupervisorWorkflow", fixture.input);
    await sandbox.advanceUntil(() => fixture.store.getRoomAgentMission(fixture.room.id, fixture.initial.mission.id)?.status === "COMPLETED", "allocation/send completion");
    expect(fixture.child).toHaveBeenCalledTimes(2);
    expect(fixture.store.listRoomAgentActions(fixture.initial.mission.id).filter((action) => action.actionType === "SEND")).toHaveLength(1);
    expect(activities.finishRoomAgentSupervisorTurn).toHaveBeenCalledOnce();
    await sandbox.archive(handle, "supervisor-allocation-send");
  });

  it.each([
    ["generic", new ApplicationFailure("Synthetic child failure", "Error", true), "ROOM_AGENT_SUPERVISOR_FAILED"],
    ["timeout-cause", new ApplicationFailure("Synthetic child timeout", "Error", true, [],
      new TimeoutFailure("Synthetic timeout", undefined, 1)), "ROOM_AGENT_SUPERVISOR_TIMEOUT"],
    ["application-code", new ApplicationFailure("Synthetic provider failure", "CODEX_APP_SERVER_TURN_TIMEOUT", true), "CODEX_APP_SERVER_TURN_TIMEOUT"]
  ] as const)("persists a serialized %s child failure on both the run and mission", async (name, error, errorCode) => {
    const fixture = continuationDriver();
    fixture.child.mockRejectedValueOnce(error);
    const handle = await sandbox.start("main", "roomAgentSupervisorWorkflow", fixture.input);
    const execution = handle.result().catch(() => undefined);
    try {
      await until(() => fixture.store.getRoomAgentMission(fixture.room.id, fixture.initial.mission.id)?.status === "FAILED", "failed mission persisted");
      const failed = activities.finishRoomAgentSupervisorTurn.mock.calls[0]![0];
      expect(failed).toMatchObject({ status: "FAILED", errorCode });
      expect(fixture.store.getRoomAgentTurn(fixture.initial.mission.id, failed.item.turn.agentRunId)?.run)
        .toMatchObject({ status: "FAILED", errorCode });
      expect(fixture.child).toHaveBeenCalledOnce();
    } finally { await sandbox.archive(handle, `supervisor-failure-${name}`); await execution; }
  });

  it.each(["stop", "follow-up"] as const)("retires prepared work when %s arrives before the activity reply", async (kind) => {
    const fixture = continuationDriver(); const prepared = deferred<any>(); const release = deferred();
    activities.prepareRoomAgentBackgroundContinuation.mockImplementationOnce(async (input) => {
      const result = await prepareBackgroundContinuation(input, fixture.store);
      prepared.resolve(result); await release.promise; return result;
    });
    const handle = await sandbox.start("main", "roomAgentSupervisorWorkflow", fixture.input);
    await sandbox.env.sleep("1 second");
    const result = await prepared.promise;
    expect(result.state).toBe("READY");
    try {
      if (kind === "stop") {
        fixture.store.updateRoomAgentMission(fixture.initial.mission.id, { status: "INTERRUPTED" });
        await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: null, reason: "Synthetic stop" });
      } else await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, fixture.enqueue("follow-up", "Only inspect the room.").queueItem);
      await sandbox.flush(handle);
    } finally { release.resolve(); }
    await until(() => fixture.store.getRoomAgentTurn(fixture.initial.mission.id, result.item.turn.agentRunId)?.run.status === "INTERRUPTED", "stale prepared run retired");
    if (kind === "stop") expect(fixture.child).not.toHaveBeenCalled();
    else {
      await until(() => fixture.child.mock.calls.length === 1, "operator follow-up");
      expect(fixture.child.mock.calls[0]![0].roomAgentOperatorRequest).toBe("Only inspect the room.");
    }
    await sandbox.archive(handle, `supervisor-prepared-${kind}`);
  });

  it("carries a prepared continuation into the new run and executes it exactly once", async () => {
    const fixture = continuationDriver();
    const handle = await sandbox.start("main", "roomAgentSupervisorWorkflow", { ...fixture.input, processedCount: 50 });
    await sandbox.advanceUntil(() => fixture.store.getRoomAgentMission(fixture.room.id, fixture.initial.mission.id)?.status === "COMPLETED", "continued prepared work");
    const first = await sandbox.firstHistory(handle);
    const next = first.events!.find((event) => event.workflowExecutionContinuedAsNewEventAttributes)!.workflowExecutionContinuedAsNewEventAttributes!;
    const carried = JSON.parse(Buffer.from(next.input!.payloads![0]!.data!).toString());
    expect(carried.pending).toHaveLength(1);
    expect(fixture.child).toHaveBeenCalledOnce();
    expect(fixture.child.mock.calls[0]![0].agentRunId).toBe(carried.pending[0].turn.agentRunId);
    await sandbox.archive(handle, "supervisor-prepared-carried");
  });

  it("drains the excess instead of carrying an invalid 105-item queue", async () => {
    let checks = 0; const release = deferred();
    let handle: Awaited<ReturnType<typeof sandbox.start>>;
    activities.checkRoomAgentSupervisorTurn.mockImplementation(async () => {
      if (++checks === 1) for (let i = 1; i <= 105; i++) await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, turn(`bounded-${i}`));
      if (checks > 6) await release.promise;
      return "SKIP";
    });
    handle = await sandbox.start("main", "roomAgentSupervisorWorkflow", roomAgentSupervisorInputSchema.parse({ roomId,
      pending: [turn("bounded-0")], processedCount: 49 }));
    try {
      await until(async () => (await sandbox.firstHistory(handle)).events!.some((event) => event.workflowExecutionContinuedAsNewEventAttributes), "bounded queue rollover");
      const first = await sandbox.firstHistory(handle);
      const next = first.events!.find((event) => event.workflowExecutionContinuedAsNewEventAttributes)!.workflowExecutionContinuedAsNewEventAttributes!;
      const carried = JSON.parse(Buffer.from(next.input!.payloads![0]!.data!).toString());
      expect(roomAgentSupervisorInputSchema.parse(carried).pending).toHaveLength(100);
      expect(first.events!.filter((event) => event.activityTaskScheduledEventAttributes?.activityType?.name === "checkRoomAgentSupervisorTurn")).toHaveLength(6);
      release.resolve();
      await until(() => checks === 106, "every queued request drained without loss");
      await sandbox.archive(handle, "supervisor-bounded-carry");
    } finally { release.resolve(); }
  }, 30_000);

  it("records background failure once after five execution attempts", async () => {
    activities.runRoomAgentBackgroundAction.mockRejectedValue(Error("Synthetic action failure"));
    const handle = await sandbox.start("main", "roomAgentActionWorkflow", {
      bridge: { roomId, missionId: "mission:action" }, traceId: "trace:action"
    }, "space-room-action:action:synthetic");
    await expect(handle.result()).rejects.toThrow();
    expect(activities.runRoomAgentBackgroundAction).toHaveBeenCalledTimes(5);
    expect(activities.failRoomAgentBackgroundAction).toHaveBeenCalledExactlyOnceWith({ roomId,
      missionId: "mission:action", actionId: "action:synthetic", cancelled: false });
    await sandbox.archive(handle, "action-failure");
  });

  it("retries a mutation activity and returns its applied result", async () => {
    activities.executePersistedMemoryChangeSet.mockRejectedValueOnce(Error("Synthetic mutation retry"));
    const input = { changeSetId: "change:synthetic", traceId: "trace:mutation" };
    const handle = await sandbox.start("mutation", "memoryMutationWorkflow", input);
    expect(await handle.result()).toMatchObject({ status: "APPLIED", changeSetId: input.changeSetId });
    expect(activities.executePersistedMemoryChangeSet).toHaveBeenCalledTimes(2);
    await sandbox.archive(handle, "memory-mutation");
  });

  it.each([false, true])("consolidates with change set present=%s", async (hasChangeSet) => {
    activities.prepareMemoryConsolidation.mockResolvedValue({ run: { id: "audit:synthetic", status: "COMPLETED" }, changeSetId: hasChangeSet ? "change:synthetic" : null });
    if (hasChangeSet) activities.executePersistedMemoryChangeSet.mockRejectedValueOnce(Error("Synthetic repair retry"));
    const handle = await sandbox.start("maintenance", "memoryConsolidationWorkflow", { runId: "audit:synthetic", traceId: "trace:consolidation" });
    expect(await handle.result()).toEqual({ id: "audit:synthetic", status: "COMPLETED" });
    expect(activities.executePersistedMemoryChangeSet).toHaveBeenCalledTimes(hasChangeSet ? 2 : 0);
    expect(activities.finalizeMemoryRepair).toHaveBeenCalledTimes(hasChangeSet ? 1 : 0);
    await sandbox.archive(handle, `memory-consolidation-${hasChangeSet ? "repair" : "empty"}`);
  });

  it("continues maintenance after both optional activities exhaust retries and completes its real child", async () => {
    activities.refreshAllMonthsMemoryGraphSnapshot.mockRejectedValue(Error("Synthetic optional refresh failure"));
    activities.reconcileStaleSpaceAgentSessions.mockRejectedValue(Error("Synthetic optional reconciliation failure"));
    const input = { scheduledAt: "2026-01-01T00:00:00.000Z", traceId: "trace:maintenance" };
    const handle = await sandbox.start("maintenance", "memoryMaintenanceWorkflow", input);
    expect(await handle.result()).toEqual({ status: "REFRESHED", sourceHash: "a".repeat(64) });
    expect(activities.refreshAllMonthsMemoryGraphSnapshot).toHaveBeenCalledTimes(3);
    expect(activities.reconcileStaleSpaceAgentSessions).toHaveBeenCalledTimes(3);
    expect(activities.createScheduledMemoryAudit).toHaveBeenCalledExactlyOnceWith({ ...input, sourceHash: "a".repeat(64) });
    expect(activities.prepareMemoryConsolidation).toHaveBeenCalledExactlyOnceWith({ runId: "audit:synthetic", traceId: input.traceId });
    const history = await sandbox.firstHistory(handle);
    expect(history.events!.some((event) => event.childWorkflowExecutionCompletedEventAttributes)).toBe(true);
    await sandbox.archive(handle, "memory-maintenance");
  });

  it("rejects an added durable timer with DeterminismViolationError", async () => {
    const original = sandbox.snapshots.get("goal-timeout--0.json");
    expect(original).toBeDefined();
    const mutated = await sandbox.bundle("main", true);
    await expect(Worker.runReplayHistory({ workflowBundle: mutated }, original!)).rejects.toBeInstanceOf(DeterminismViolationError);
  }, 30_000);

  it("records every workflow type, including a pre-patch supervisor history", () => {
    const types = new Set([...sandbox.snapshots.values()].map((history) => history.events![0]!.workflowExecutionStartedEventAttributes!.workflowType!.name));
    expect([...types].sort()).toEqual(["codexAppServerTurnWorkflow", "dotGoalWorkflow", "dummyTurnWorkflow", "memoryConsolidationWorkflow",
      "memoryMaintenanceWorkflow", "memoryMutationWorkflow", "roomAgentActionWorkflow", "roomAgentSupervisorWorkflow"].sort());
    expect(sandbox.snapshots.has("supervisor-legacy-50--0.json")).toBe(true);
  });
});
