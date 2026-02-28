import { query } from '@anthropic-ai/claude-agent-sdk';
import { PROJECT_ROOT } from './config.js';
import { logger } from './logger.js';

export type AgentEvent =
  | { kind: 'tool_start'; tool: string; input: Record<string, unknown> }
  | { kind: 'tool_progress'; tool: string; elapsed: number };

export async function runAgent(
  message: string,
  sessionId?: string,
  onTyping?: () => void,
  onEvent?: (event: AgentEvent) => void
): Promise<{ text: string | null; newSessionId?: string }> {
  let responseText: string | null = null;
  let newSessionId: string | undefined;

  // Keep typing indicator alive
  let typingInterval: ReturnType<typeof setInterval> | undefined;
  if (onTyping) {
    onTyping();
    typingInterval = setInterval(onTyping, 4000);
  }

  try {
    const options: Record<string, unknown> = {
      cwd: PROJECT_ROOT,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
    };

    if (sessionId) {
      options.resume = sessionId;
    }

    const events = query({
      prompt: message,
      options: options as Parameters<typeof query>[0]['options'],
    });

    for await (const event of events) {
      if (event.type === 'system' && 'subtype' in event && event.subtype === 'init') {
        const initEvent = event as unknown as { session_id?: string };
        if (initEvent.session_id) {
          newSessionId = initEvent.session_id;
        }
      }

      if (event.type === 'assistant') {
        const msg = event as unknown as { message: { content: Array<{ type: string; name?: string; input?: Record<string, unknown> }> } };
        for (const block of msg.message.content) {
          if (block.type === 'tool_use' && block.name) {
            logger.debug({ tool: block.name, input: block.input }, 'Tool use');
            onEvent?.({ kind: 'tool_start', tool: block.name, input: block.input ?? {} });
          }
        }
      }

      if (event.type === 'tool_progress') {
        const prog = event as unknown as { tool_name: string; elapsed_time_seconds: number };
        logger.debug({ tool: prog.tool_name, elapsed: prog.elapsed_time_seconds }, 'Tool progress');
        onEvent?.({ kind: 'tool_progress', tool: prog.tool_name, elapsed: prog.elapsed_time_seconds });
      }

      if ('result' in event) {
        responseText = (event as unknown as { result: string }).result;
      }
    }
  } catch (err) {
    logger.error({ err }, 'Agent error');
    responseText = 'Something went wrong running that command. Check the logs.';
  } finally {
    if (typingInterval) clearInterval(typingInterval);
  }

  return { text: responseText, newSessionId };
}
