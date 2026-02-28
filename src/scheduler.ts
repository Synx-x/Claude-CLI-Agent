import CronExpression from 'cron-parser';
import { getDueTasks, updateTaskAfterRun } from './db.js';
import { runAgent } from './agent.js';
import { logger } from './logger.js';

type Sender = (chatId: string, text: string) => Promise<void>;

let sender: Sender | null = null;
let pollInterval: ReturnType<typeof setInterval> | null = null;

export function computeNextRun(cronExpression: string): number {
  const interval = CronExpression.parseExpression(cronExpression);
  return Math.floor(interval.next().getTime() / 1000);
}

export async function runDueTasks(): Promise<void> {
  const tasks = getDueTasks();

  for (const task of tasks) {
    logger.info({ taskId: task.id, prompt: task.prompt }, 'Running scheduled task');

    if (sender) {
      await sender(task.chat_id, `Running scheduled task: ${task.prompt.slice(0, 100)}...`);
    }

    try {
      const { text } = await runAgent(task.prompt);
      const result = text ?? '(no output)';
      const nextRun = computeNextRun(task.schedule);
      updateTaskAfterRun(task.id, nextRun, result);

      if (sender) {
        await sender(task.chat_id, `Scheduled task result:\n\n${result}`);
      }
    } catch (err) {
      logger.error({ err, taskId: task.id }, 'Scheduled task failed');
      if (sender) {
        await sender(task.chat_id, `Scheduled task failed: ${String(err)}`);
      }
    }
  }
}

export function initScheduler(send: Sender): void {
  sender = send;
  pollInterval = setInterval(() => {
    runDueTasks().catch(err => logger.error({ err }, 'Scheduler poll error'));
  }, 60_000);
  logger.info('Scheduler initialized (polling every 60s)');
}

export function stopScheduler(): void {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}
