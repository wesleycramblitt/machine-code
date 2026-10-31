/**
 * machine_code — one-way notifications on terminal states (M4).
 *
 * Webhook (HTTP POST JSON) and a generic command (payload via env). Email is
 * left to the command hook (e.g. a sendmail wrapper) to keep deps minimal.
 */
import { spawnSync } from "node:child_process";

export interface NotifyConfig {
  webhookUrl?: string;
  command?: string;
}

export interface NotifyPayload {
  event: "run_terminal";
  status: string;
  runId: string;
  repoRoot: string;
  agent: string;
  request: string;
  tokens: number;
  cost: number;
  error?: string;
}

export async function notify(config: NotifyConfig, payload: NotifyPayload): Promise<void> {
  const tasks: Promise<void>[] = [];
  if (config.webhookUrl) {
    tasks.push(
      fetch(config.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      })
        .then(() => undefined)
        .catch(() => undefined),
    );
  }
  if (config.command) {
    tasks.push(
      new Promise<void>((resolve) => {
        try {
          spawnSync(config.command!, [], {
            input: JSON.stringify(payload),
            env: { ...process.env, MACHINE_CODE_NOTIFY: JSON.stringify(payload) },
            stdio: ["pipe", "ignore", "ignore"],
            timeout: 30_000,
          });
        } catch {
          // ignore
        }
        resolve();
      }),
    );
  }
  await Promise.all(tasks);
}
