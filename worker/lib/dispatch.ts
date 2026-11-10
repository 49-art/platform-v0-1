/**
 * Background work (spec 11 "Async": scans, notifications, deletion).
 *
 * With Cloudflare Queues bound (Workers Paid), a job is enqueued and the consumer in jobs.ts runs it with retries.
 * On the free plan there are no Queues (decision D-014), so the same job runs inline, right now, through the same
 * code path. Nothing about the job's behaviour changes; only its delivery guarantee does (inline = at most once).
 */
import type { Env, Job } from "../env";
import { runJob } from "../jobs";

type QueueName = "Q_SCAN" | "Q_NOTIFY" | "Q_MAINT";

const queueFor: Record<Job["kind"], QueueName> = { scan_photo: "Q_SCAN", archive_message: "Q_MAINT", notify: "Q_NOTIFY", purge_user_chat: "Q_MAINT" };

export async function dispatch(env: Env, job: Job): Promise<"queued" | "inline"> {
  const queue = env[queueFor[job.kind]];
  if (queue) {
    await queue.send(job);
    return "queued";
  }
  try {
    await runJob(env, job);
  } catch (err) {
    // A failed inline job must never break the request that triggered it (a chat message, a photo upload).
    console.error("inline job failed", job.kind, err);
  }
  return "inline";
}
