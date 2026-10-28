import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { DefaultLogger, Runtime, Worker, bundleWorkflowCode, type WorkflowBundle } from "@temporalio/worker";
import { temporal } from "@temporalio/proto";
import type { WorkflowHandle } from "@temporalio/client";

type Bundle = "main" | "legacy" | "maintenance" | "mutation";
type History = Awaited<ReturnType<WorkflowHandle["fetchHistory"]>>;
export type ActivityTable = Record<string, (...args: any[]) => unknown>;
const source = {
  main: "workflows.ts", legacy: "workflows.ts",
  maintenance: "memory-maintenance-workflows.ts", mutation: "memory-mutation-workflows.ts"
};
const queues = {
  main: "sandbox-60-main", legacy: "sandbox-60-legacy",
  maintenance: "space-memory-maintenance", mutation: "space-memory-mutations"
};
const activityNames = [
  "recordDummyTurnStarted", "recordDummyTurnCompleted", "runOpenCodeAgentTurn", "runCliAgentTurn", "runCodexAppServerTurn",
  "dotGoalStep", "dotGoalObserve", "markRoomAgentMissionStarted", "markRoomAgentMissionFinished", "markRoomAgentMissionContinued",
  "checkRoomAgentSupervisorTurn", "discardRoomAgentSupervisorTurn", "finishRoomAgentSupervisorTurn",
  "prepareRoomAgentBackgroundContinuation", "settleRoomAgentBackgroundMission", "runRoomAgentBackgroundAction", "failRoomAgentBackgroundAction",
  "refreshMemoryGraphSnapshot", "refreshAllMonthsMemoryGraphSnapshot", "reconcileStaleSpaceAgentSessions",
  "createScheduledMemoryAudit", "prepareMemoryConsolidation", "finalizeMemoryRepair", "executePersistedMemoryChangeSet"
];
export const historyRoot = fileURLToPath(new URL("../fixtures/workflow-histories/", import.meta.url));
// Preserve one replay baseline per workflow plus continuation and pre-patch branches.
// The 250-poll and 300-iteration cases remain live sandbox tests; recording every
// event from those runs would make each patch version too large to review.
const baselineHistoryNames = new Set([
  "dummy-retry--0.json", "turn-retry--0.json", "goal-timeout--0.json",
  "goal-continued--0.json", "goal-continued--1.json",
  "supervisor-main-50--0.json", "supervisor-main-50--1.json",
  "supervisor-legacy-50--0.json", "supervisor-legacy-50--1.json",
  "supervisor-prepared-carried--0.json", "supervisor-prepared-carried--1.json",
  "action-failure--0.json", "memory-mutation--0.json",
  "memory-consolidation-repair--0.json", "memory-maintenance--0.json"
]);

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

export async function until(predicate: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 15_000;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function inputFromHistory(history: History) {
  const payload = history.events?.[0]?.workflowExecutionStartedEventAttributes?.input?.payloads?.[0];
  if (!payload?.data) throw new Error("History lacks its synthetic input");
  return JSON.parse(Buffer.from(payload.data).toString("utf8"));
}

export async function fixtureFiles(root = historyRoot): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const children = await Promise.all(entries.map(async (entry) => entry.isDirectory()
    ? fixtureFiles(join(root, entry.name)) : entry.name.endsWith(".json") ? [join(root, entry.name)] : []));
  return children.flat().sort();
}

export class WorkflowSandbox {
  env!: TestWorkflowEnvironment;
  activities: ActivityTable = {};
  readonly bundles = new Map<Bundle, WorkflowBundle>();
  readonly snapshots = new Map<string, History>();
  private readonly workers: Worker[] = [];
  private readonly running: Promise<void>[] = [];
  private readonly handles = new Set<WorkflowHandle>();
  private closed = false;
  private activeActivities = 0;

  async open() {
    Runtime.install({ logger: new DefaultLogger("ERROR") });
    this.env = await TestWorkflowEnvironment.createTimeSkipping({ client: { identity: "space-synthetic-tests" } });
    try {
      for (const key of Object.keys(source) as Bundle[]) this.bundles.set(key, await this.bundle(key));
      const existing = await fixtureFiles();
      if (!existing.length && !process.env.SPACE_TEMPORAL_RECORD_DIR) throw new Error("Missing committed Temporal histories; see fixtures/workflow-histories/README.md");
      const activities = Object.fromEntries(activityNames.map((name) => [name, async (...args: any[]) => {
        const implementation = this.activities[name];
        if (!implementation) throw new Error(`Unexpected test activity: ${name}`);
        this.activeActivities++;
        try { return await implementation(...args); } finally { this.activeActivities--; }
      }]));
      for (const key of Object.keys(source) as Bundle[]) {
        const worker = await Worker.create({ connection: this.env.nativeConnection, workflowBundle: this.bundles.get(key)!,
          taskQueue: queues[key], activities, identity: "space-synthetic-worker", maxCachedWorkflows: 40,
          maxConcurrentWorkflowTaskExecutions: 20, shutdownGraceTime: "1 second", shutdownForceTime: "5 seconds" });
        this.workers.push(worker);
        const running = worker.run();
        void running.catch(() => {});
        this.running.push(running);
      }
    } catch (error) { await this.close(); throw error; }
  }

  async bundle(key: Bundle, extraTimer = false) {
    return bundleWorkflowCode({ workflowsPath: fileURLToPath(new URL(`../../src/${source[key]}`, import.meta.url)),
      logger: new DefaultLogger("ERROR"),
      webpackConfigHook(config) {
        if (key === "legacy" || extraTimer) config.module!.rules!.push({ test: /[\\/]src[\\/]workflows\.ts$/,
          enforce: "pre", use: [{ loader: fileURLToPath(new URL("./workflow-fixture-loader.cjs", import.meta.url)),
            options: { legacy: key === "legacy", extraTimer } }] });
        return config;
      }
    });
  }

  async start(key: Bundle, workflowType: string, argument: unknown, workflowId = `synthetic-${randomUUID()}`) {
    const handle = await this.env.client.workflow.start(workflowType, { workflowId, taskQueue: queues[key], args: [argument] });
    this.handles.add(handle);
    return handle;
  }

  async flush(handle: WorkflowHandle) { await handle.query("__stack_trace"); }

  async advanceUntil(predicate: () => boolean, label: string) {
    for (let step = 0; step < 30 && !predicate(); step++) await this.env.sleep("1 second");
    if (!predicate()) throw new Error(`Virtual-time wait failed: ${label}`);
  }

  async archive(handle: WorkflowHandle, name: string) {
    // Terminating while a child/activity is still completing can strand a
    // time-skipping-server activity lock and also truncate the asserted result.
    await until(async () => {
      const description = await handle.describe();
      return this.activeActivities === 0 && !(description.raw.pendingActivities?.length) &&
        !(description.raw.pendingChildren?.length) && !description.raw.pendingWorkflowTask;
    }, `settled workflow ${name}`);
    if ((await handle.describe()).status.name === "RUNNING") await handle.terminate("Synthetic test complete");
    let runId = handle.firstExecutionRunId;
    if (!runId) throw new Error("Expected the first run ID from workflow.start");
    for (let part = 0; part < 10; part++) {
      const history = await this.env.client.workflow.getHandle(handle.workflowId, runId).fetchHistory();
      this.snapshots.set(`${name}--${part}.json`, history);
      const next = history.events?.find((event) => event.workflowExecutionContinuedAsNewEventAttributes)
        ?.workflowExecutionContinuedAsNewEventAttributes?.newExecutionRunId;
      if (!next) { this.handles.delete(handle); return; }
      runId = next;
    }
    throw new Error("Unexpectedly unbounded synthetic continuation chain");
  }

  async firstHistory(handle: WorkflowHandle) {
    return this.env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId).fetchHistory();
  }

  async replay(files: string[]) {
    const byBundle = new Map<Bundle, Array<{ workflowId: string; history: unknown }>>();
    const types = new Map<string, string>();
    for (const file of files) {
      const history = JSON.parse(await readFile(file, "utf8"));
      const type = history.events[0].workflowExecutionStartedEventAttributes.workflowType.name as string;
      types.set(file, type);
      const key: Bundle = type.startsWith("memoryMutation") ? "mutation" : type.startsWith("memory") ? "maintenance" : "main";
      const group = byBundle.get(key) ?? [];
      group.push({ workflowId: file, history: temporal.api.history.v1.History.fromObject(history) });
      byBundle.set(key, group);
    }
    for (const [key, histories] of byBundle) {
      let count = 0;
      for await (const result of Worker.runReplayHistories({ workflowBundle: this.bundles.get(key)! }, histories)) {
        count++;
        if (result.error) throw new Error(`Replay failed for ${types.get(result.workflowId)} in ${result.workflowId}`, { cause: result.error });
      }
      if (count !== histories.length) throw new Error("Replay did not visit every history");
    }
  }

  async writeRecording() {
    const directory = process.env.SPACE_TEMPORAL_RECORD_DIR;
    if (!directory) return;
    await mkdir(directory, { recursive: true });
    for (const [name, history] of this.snapshots) {
      if (!baselineHistoryNames.has(name)) continue;
      // Host identities and exception source paths have no role in determinism.
      const object = temporal.api.history.v1.History.toObject(temporal.api.history.v1.History.fromObject(history), {
        longs: String, enums: String, bytes: String
      });
      const portable = JSON.parse(JSON.stringify(object), (key, value) =>
        key === "identity" ? "space-synthetic-tests" : key === "stackTrace" ? "Synthetic test failure" : value);
      await writeFile(join(directory, name), formatHistory(portable), { flag: "wx" });
    }
    await this.replay(await fixtureFiles(directory));
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    try {
      for (const handle of this.handles) if ((await handle.describe()).status.name === "RUNNING")
        await handle.terminate("Synthetic test cleanup");
      for (const worker of this.workers) if (worker.getState() === "RUNNING") worker.shutdown();
      const results = await Promise.allSettled(this.running);
      for (const result of results) if (result.status === "rejected") throw result.reason;
    } finally { if (this.env) await this.env.teardown(); }
  }
}

export function formatHistory(history: Record<string, unknown>): string {
  const fields = Object.entries(history).map(([key, value]) => {
    if (key !== "events" || !Array.isArray(value)) return `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`;
    const lines = value.map(event => `    ${JSON.stringify(event)}`).join(",\n");
    return `  "events": [\n${lines}\n  ]`;
  });
  return `{\n${fields.join(",\n")}\n}\n`;
}
