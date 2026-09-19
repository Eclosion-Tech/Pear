import type { McpToolEntry } from './types';
import { encodeU64 } from './encode';

export const requestHumanInputTool: McpToolEntry = {
  name: 'request_human_input',
  description: 'Ask a human participant for input in this Pear conversation. Use this when blocked on a question, not for progress updates or tool permissions. Reuse request_key when retrying the same question. After success, finish your turn and wait; their answer is posted to this conversation and wakes you. Do not poll or repeat the question.',
  inputSchema: {
    type: 'object',
    properties: {
      conversation_id: { type: 'number', description: 'The conversation you are working in.' },
      recipient: { type: 'string', description: 'Exact display name of the human participant.' },
      request_key: { type: 'string', description: 'Unique stable key for this question within the conversation, up to 128 bytes.' },
      question: { type: 'string', description: 'The question and context needed to answer it.' },
    },
    required: ['conversation_id', 'recipient', 'request_key', 'question'],
  },
  async execute(ctx, input) {
    try {
      const conversation = encodeU64(Number(input.conversation_id));
      const name = String(input.recipient ?? '').trim().toLowerCase();
      const people = await ctx.transport.sql<{ identity: unknown; name: string }>('SELECT identity, name FROM user');
      const matches = people.filter(p => p.name.toLowerCase() === name);
      if (matches.length !== 1) throw new Error('Recipient must match exactly one human display name.');
      const rawIdentity = matches[0].identity;
      const identity = typeof rawIdentity === 'string' ? rawIdentity : Array.isArray(rawIdentity) ? rawIdentity[0] : (rawIdentity as { __identity__?: string })?.__identity__;
      if (typeof identity !== 'string' || !/^(?:0x)?[0-9a-f]{64}$/i.test(identity)) throw new Error('Invalid recipient identity.');
      await ctx.transport.call('request_human_input', [conversation, [`0x${identity.replace(/^0x/, "")}`], String(input.request_key ?? ''), String(input.question ?? '')]);
      return JSON.stringify({ ok: true, conversation_id: conversation, awaiting_input: true, next_step: 'Finish your turn. The human reply will wake you in this conversation.' });
    } catch (error) {
      return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  },
};
