/**
 * Writes that outlive their tool call, and the reminder that says how they ended.
 *
 * VoiceOS 0.1.40 runs every tool call, background ones included, with the MCP SDK's default 60 s request timeout
 * and no progress token, so nothing can extend it. At 60 s it cancels the call and closes the connection (the
 * server's stdin ends and it exits). An upload on a slow uplink takes longer than that, so a write runs as a
 * detached job (writes.ts): the call answers "working" after a soft deadline (45 s), the job carries on, and when
 * it ends VoiceOS gets a `voiceos/reminders/trigger` request (manifest permission `notify`). The reminder's
 * Show button comes back as `voiceos/reminders/action` and opens the job's completion card.
 *
 * Best effort and honest: a reminder that's refused or fails is logged by its code only, and "did it go up?"
 * still answers from the ledger. Nothing here logs the message text (it carries file names).
 */
import { z } from "zod";
import { log } from "./proc.ts";
import type { Widget } from "./types.ts";

export const TRIGGER_METHOD = "voiceos/reminders/trigger";
export const ACTION_METHOD = "voiceos/reminders/action";
/** The one reminder button: opens the post's completion card. */
export const SHOW_POST = { id: "show_post", label: "Show" } as const;

export interface ReminderRequest {
  message: string;
  speak?: boolean;
  actions?: Array<{ id: string; label: string }>;
  data?: Record<string, unknown>;
}

const TriggerResult = z.object({ notificationId: z.string() }).passthrough();

/** Something that can send a request to VoiceOS (the connected McpServer's `server.server.request`). */
export type RequestSender = (request: { method: string; params: Record<string, unknown> }, schema: typeof TriggerResult) => Promise<{ notificationId: string }>;

/** 1–2,000 trimmed characters, as VoiceOS takes them. */
export function reminderMessage(text: string): string {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "Your TikTok upload finished. Ask 'did it go up?' for the details.";
  return t.length > 2000 ? `${t.slice(0, 1999)}…` : t;
}

/** The reminder channel to VoiceOS. Attached to the server when it's created (mcpServer.ts). */
export class Reminders {
  private send?: RequestSender;

  attach(send: RequestSender): void {
    this.send = send;
  }

  /** Queue a reminder. The notification id, or undefined when VoiceOS refused it or couldn't be asked. Never throws. */
  async trigger(r: ReminderRequest): Promise<string | undefined> {
    if (!this.send) {
      log("reminder not queued: no_connection");
      return undefined;
    }
    try {
      const params: Record<string, unknown> = { message: reminderMessage(r.message), speak: r.speak ?? false };
      if (r.actions?.length) params.actions = r.actions.slice(0, 3);
      if (r.data) params.data = r.data;
      const res = await this.send({ method: TRIGGER_METHOD, params }, TriggerResult);
      log("reminder queued");
      return res.notificationId;
    } catch (e) {
      const code = (e as { code?: unknown })?.code;
      log(`reminder not queued: ${typeof code === "number" || typeof code === "string" ? code : ((e as Error)?.name ?? "error")}`);
      return undefined;
    }
  }
}

/**
 * Detached write jobs: which are still running, and the completion card of the ones that finished (the last 20,
 * like the ledger), for the reminder's Show button.
 */
export class DetachedJobs {
  private readonly running = new Map<string, Promise<void>>();
  private readonly cards = new Map<string, { card: Widget; text: string }>();

  constructor(private readonly max = 20) {}

  /** Follow a job that outlived its tool call; `done` must not reject. */
  track(taskId: string, done: Promise<void>): void {
    const p = done.catch(() => {}).finally(() => this.running.delete(taskId));
    this.running.set(taskId, p);
  }

  isRunning(taskId: string): boolean {
    return this.running.has(taskId);
  }

  /** Keep a finished job's completion card and its one-line summary. */
  finished(taskId: string, card: Widget, text: string): void {
    this.cards.delete(taskId);
    this.cards.set(taskId, { card, text });
    while (this.cards.size > this.max) {
      const oldest = this.cards.keys().next().value;
      if (oldest === undefined) break;
      this.cards.delete(oldest);
    }
  }

  card(taskId: string): { card: Widget; text: string } | undefined {
    return this.cards.get(taskId);
  }

  /** Tests: resolves once every detached job has ended. */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running.values()]);
  }
}

export const ActionRequest = z.object({
  method: z.literal(ACTION_METHOD),
  params: z
    .object({
      notificationId: z.string().min(1).max(200),
      actionId: z.string().min(1).max(64),
      data: z.record(z.unknown()).optional(),
    })
    .passthrough(),
});
export type ActionParams = z.infer<typeof ActionRequest>["params"];

export interface ActionResult {
  [key: string]: unknown;
  ok: true;
  view?: { blocks: Widget[] };
  responseText?: string;
}

/**
 * The handler for a reminder's button: a fixed map of action ids (never anything the request names beyond it),
 * and one answer per notificationId + actionId (a repeated click gets the same answer).
 */
export function actionHandler(handlers: Record<string, (data: Record<string, unknown>) => ActionResult>) {
  const answered = new Map<string, ActionResult>();
  return async (params: ActionParams): Promise<ActionResult> => {
    const key = `${params.notificationId}\u0000${params.actionId}`;
    const seen = answered.get(key);
    if (seen) return seen;
    if (!Object.prototype.hasOwnProperty.call(handlers, params.actionId)) throw new Error(`Unknown action ${JSON.stringify(params.actionId.slice(0, 64))}`);
    const result = handlers[params.actionId](params.data ?? {});
    answered.set(key, result);
    while (answered.size > 200) {
      const oldest = answered.keys().next().value;
      if (oldest === undefined) break;
      answered.delete(oldest);
    }
    return result;
  };
}
