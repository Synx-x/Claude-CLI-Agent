import { randomUUID } from 'crypto';
import { initDatabase, createTask, listTasks, deleteTask, pauseTask, resumeTask } from './db.js';
import { computeNextRun } from './scheduler.js';

function usage(): void {
  console.log(`
Usage: node dist/schedule-cli.js <command> [args]

Commands:
  create "<prompt>" "<cron>" <chat_id>   Create a new scheduled task
  list [chat_id]                         List all tasks
  delete <id>                            Delete a task
  pause <id>                             Pause a task
  resume <id>                            Resume a paused task
  `);
}

function main(): void {
  initDatabase();

  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd) {
    usage();
    process.exit(1);
  }

  switch (cmd) {
    case 'create': {
      const [, prompt, cron, chatId] = args;
      if (!prompt || !cron || !chatId) {
        console.error('Usage: create "<prompt>" "<cron>" <chat_id>');
        process.exit(1);
      }
      try {
        const nextRun = computeNextRun(cron);
        const id = randomUUID().slice(0, 8);
        createTask(id, chatId, prompt, cron, nextRun);
        console.log(`Task created: ${id}`);
        console.log(`Next run: ${new Date(nextRun * 1000).toISOString()}`);
      } catch (err) {
        console.error('Invalid cron expression:', String(err));
        process.exit(1);
      }
      break;
    }
    case 'list': {
      const chatId = args[1];
      const tasks = listTasks(chatId);
      if (tasks.length === 0) {
        console.log('No scheduled tasks.');
        return;
      }
      console.log('ID       | Status | Schedule      | Next Run                  | Prompt');
      console.log('-'.repeat(90));
      for (const t of tasks) {
        const next = new Date(t.next_run * 1000).toISOString();
        console.log(`${t.id.padEnd(8)} | ${t.status.padEnd(6)} | ${t.schedule.padEnd(13)} | ${next} | ${t.prompt.slice(0, 30)}`);
      }
      break;
    }
    case 'delete': {
      const id = args[1];
      if (!id) { console.error('Usage: delete <id>'); process.exit(1); }
      if (deleteTask(id)) console.log(`Deleted: ${id}`);
      else console.log('Task not found.');
      break;
    }
    case 'pause': {
      const id = args[1];
      if (!id) { console.error('Usage: pause <id>'); process.exit(1); }
      pauseTask(id);
      console.log(`Paused: ${id}`);
      break;
    }
    case 'resume': {
      const id = args[1];
      if (!id) { console.error('Usage: resume <id>'); process.exit(1); }
      resumeTask(id);
      console.log(`Resumed: ${id}`);
      break;
    }
    default:
      console.error(`Unknown command: ${cmd}`);
      usage();
      process.exit(1);
  }
}

main();
