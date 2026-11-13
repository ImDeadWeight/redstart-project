import { resolveApiPath } from '$lib/utils/api-fetch';
import { uuid, filterByLeafNodeId } from '$lib/utils';
import { AUTH_TOKEN_LOCALSTORAGE_KEY } from '$lib/constants/storage';
import type { DatabaseConversation, DatabaseMessage, McpServerOverride } from '$lib/types/database';

const DEVICE_ID_KEY = 'redstart-device-id';

// The /conversations routes require a valid session when auth is enabled. Read
// the token straight from localStorage (where the auth store persists it,
// JSON-stringified) rather than importing getAuthHeaders — this service reads
// storage directly by design to avoid a circular dependency with the stores.
function getAuthHeader(): Record<string, string> {
  try {
    const raw = localStorage.getItem(AUTH_TOKEN_LOCALSTORAGE_KEY);
    const token = raw ? (JSON.parse(raw) as string | null) : null;
    if (token) return { Authorization: `Bearer ${token}` };
  } catch {
    /* fall through — unauthenticated request */
  }
  return {};
}

function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = uuid();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

/**
 * The headers every conversation-scoped route takes: the session, and the
 * device id that is the conversations scope with auth off. The task routes
 * (task.service.ts) use the same scope, so they share this.
 */
export function conversationHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json', 'X-Redstart-Device-Id': getDeviceId(), ...getAuthHeader() };
}

/**
 * A conversation write refused because a background task holds the
 * conversation (agent-runtime Phase 3.4, D25: the daemon is its only writer
 * then). The client's copy is stale by definition: reload it.
 */
export class TaskActiveError extends Error {
  constructor(readonly conversationId: string | null) {
    super('A background task is writing this conversation. It was reloaded; cancel the task to edit it.');
    this.name = 'TaskActiveError';
  }
}

let taskActiveHandler: ((conversationId: string | null) => void) | null = null;

/** Registered once by the tasks store: reload and say why. */
export function setTaskActiveHandler(handler: ((conversationId: string | null) => void) | null): void {
  taskActiveHandler = handler;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(resolveApiPath(path), {
    ...init,
    headers: {
      ...conversationHeaders(),
      ...(init?.headers || {})
    }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 409 && /"task_active"/.test(text)) {
      const conversationId = /^\/conversations\/([^/?]+)/.exec(path)?.[1] ?? null;
      taskActiveHandler?.(conversationId);
      throw new TaskActiveError(conversationId);
    }
    throw new Error(`API error ${res.status}: ${text || res.statusText}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

/**
 * One write at a time, in the order they were asked for.
 *
 * Every write below is a read-modify-write of a WHOLE conversation: GET it,
 * change its message list, PUT the list back. Two in flight at once lose the
 * first one's change, silently. That happened (2026-11-10): a steered agentic
 * flow saves its final timings with an un-awaited updateMessage while the
 * steering re-send adds the user's new message; the timings save read before
 * the message existed and wrote after, erasing it, and the reply then failed
 * with "Parent message not found". tests/unit/database-write-order.test.ts.
 *
 * Queued here, so each write reads what the previous one wrote. Reads are not
 * queued. This covers one tab; two tabs or two devices writing the same
 * conversation can still collide (the server takes whole records), which is
 * the daemon-as-sole-writer design in the agent-runtime plan (D25).
 *
 * Not reentrant: a queued function must not call another queued method, or
 * it waits for itself. Use the unqueued helpers (putConversation) inside.
 */
let writeChain: Promise<unknown> = Promise.resolve();

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  // The chain carries on whether this write succeeds or fails.
  writeChain = run.catch(() => undefined);
  return run;
}

async function putConversation(
  id: string,
  updates: Partial<Omit<DatabaseConversation, 'id'>>
): Promise<void> {
  await apiFetch(`/conversations/${id}`, {
    method: 'PUT',
    body: JSON.stringify(updates),
    headers: { 'X-Redstart-Device-Id': getDeviceId() }
  });
}

export class DatabaseService {
  static async createConversation(
    name: string,
    { projectId = null }: { projectId?: string | null } = {}
  ): Promise<DatabaseConversation> {
    const conv = await apiFetch<DatabaseConversation>('/conversations', {
      method: 'POST',
      body: JSON.stringify({
        ...(projectId ? { projectId } : {}),
        id: uuid(),
        name,
        currNode: '',
        lastModified: Date.now(),
        mcpServerOverrides: [],
        thinkingEnabled: false,
        reasoningEffort: null,
        forkedFromConversationId: null,
        pinned: false,
        contextSummary: null,
        messages: []
      })
    });
    return conv;
  }

  /**
   * `parent` is excluded deliberately: this function sets it from `parentId`
   * below, so a caller-supplied value would be silently discarded. Requiring
   * a field the implementation ignores made ten call sites either pass a lie
   * or omit it and fail typecheck.
   */
  static async createMessageBranch(
    message: Omit<DatabaseMessage, 'id' | 'parent'>,
    parentId: string | null
  ): Promise<DatabaseMessage> {
    const conv = await apiFetch<DatabaseConversation>(`/conversations/${message.convId}`, {
      method: 'GET',
      headers: { 'X-Redstart-Device-Id': getDeviceId() }
    });

    if (!conv) throw new Error('Conversation not found');

    const allMessages = conv.messages || [];
    const newMessage: DatabaseMessage = {
      ...message,
      id: uuid(),
      parent: parentId,
      toolCalls: message.toolCalls ?? '',
      children: []
    };

    if (parentId !== null) {
      const parent = allMessages.find(m => m.id === parentId);
      if (!parent) throw new Error('Parent message not found');
      parent.children = [...parent.children, newMessage.id];
    }

    allMessages.push(newMessage);

    await apiFetch(`/conversations/${message.convId}`, {
      method: 'PUT',
      body: JSON.stringify({
        currNode: newMessage.id,
        messages: allMessages,
        lastModified: Date.now()
      }),
      headers: { 'X-Redstart-Device-Id': getDeviceId() }
    });

    return newMessage;
  }

  static async createRootMessage(convId: string): Promise<string> {
    const conv = await apiFetch<DatabaseConversation>(`/conversations/${convId}`, {
      method: 'GET',
      headers: { 'X-Redstart-Device-Id': getDeviceId() }
    });
    if (!conv) throw new Error('Conversation not found');

    const rootMessage: DatabaseMessage = {
      id: uuid(),
      convId,
      type: 'root',
      timestamp: Date.now(),
      role: 'system',
      content: '',
      parent: null,
      toolCalls: '',
      children: []
    };

    const messages = conv.messages || [];
    messages.push(rootMessage);

    await apiFetch(`/conversations/${convId}`, {
      method: 'PUT',
      body: JSON.stringify({ messages, lastModified: Date.now() }),
      headers: { 'X-Redstart-Device-Id': getDeviceId() }
    });

    return rootMessage.id;
  }

  static async createSystemMessage(
    convId: string,
    systemPrompt: string,
    parentId: string
  ): Promise<DatabaseMessage> {
    const conv = await apiFetch<DatabaseConversation>(`/conversations/${convId}`, {
      method: 'GET',
      headers: { 'X-Redstart-Device-Id': getDeviceId() }
    });
    if (!conv) throw new Error('Conversation not found');

    const systemMessage: DatabaseMessage = {
      id: uuid(),
      convId,
      type: 'system',
      timestamp: Date.now(),
      role: 'system',
      content: systemPrompt,
      parent: parentId,
      children: []
    };

    const messages = conv.messages || [];
    const parent = messages.find(m => m.id === parentId);
    if (parent) {
      parent.children = [...parent.children, systemMessage.id];
    }
    messages.push(systemMessage);

    await apiFetch(`/conversations/${convId}`, {
      method: 'PUT',
      body: JSON.stringify({ messages, lastModified: Date.now() }),
      headers: { 'X-Redstart-Device-Id': getDeviceId() }
    });

    return systemMessage;
  }

  static async deleteConversation(
    id: string,
    options?: { deleteWithForks?: boolean }
  ): Promise<void> {
    // Through apiFetch like every other call: it resolves the path against the
    // server base (relative in the web build, absolute in the app), carries
    // the session token (with auth on, a bare fetch was refused) and throws on
    // a failed status, so a delete that did not happen is not shown as one.
    // This used to parse the path against a dummy origin and fetch the
    // result, which in the web build sent the delete to http://x/…, without
    // auth, and the chat never went away. (Fixed on this branch and on main
    // in PR #39 alike; merged as one.)
    const query = options?.deleteWithForks ? '?deleteWithForks=true' : '';
    await apiFetch<void>(`/conversations/${encodeURIComponent(id)}${query}`, {
      method: 'DELETE'
    });
  }

  static async deleteMessage(messageId: string): Promise<void> {
    // Find which conversation contains this message
    const convs = await apiFetch<DatabaseConversation[]>('/conversations', {
      headers: { 'X-Redstart-Device-Id': getDeviceId() }
    });

    for (const conv of convs) {
      const messages = conv.messages || [];
      const msgIdx = messages.findIndex(m => m.id === messageId);
      if (msgIdx === -1) continue;

      const msg = messages[msgIdx];
      if (msg.parent) {
        const parent = messages.find(m => m.id === msg.parent);
        if (parent) {
          parent.children = parent.children.filter((cid: string) => cid !== messageId);
        }
      }

      messages.splice(msgIdx, 1);

      await apiFetch(`/conversations/${conv.id}`, {
        method: 'PUT',
        body: JSON.stringify({ messages, lastModified: Date.now() }),
        headers: { 'X-Redstart-Device-Id': getDeviceId() }
      });
      return;
    }
  }

  static async deleteMessageCascading(
    conversationId: string,
    messageId: string
  ): Promise<string[]> {
    const conv = await apiFetch<DatabaseConversation>(`/conversations/${conversationId}`, {
      method: 'GET',
      headers: { 'X-Redstart-Device-Id': getDeviceId() }
    });
    if (!conv) return [];

    const messages = conv.messages || [];
    const allIds = new Set<string>([messageId]);

    function collectDescendants(parentId: string) {
      for (const m of messages) {
        if (m.parent === parentId) {
          allIds.add(m.id);
          collectDescendants(m.id);
        }
      }
    }
    collectDescendants(messageId);

    const msg = messages.find(m => m.id === messageId);
    if (msg?.parent) {
      const parent = messages.find(m => m.id === msg.parent);
      if (parent) {
        parent.children = parent.children.filter((cid: string) => !allIds.has(cid));
      }
    }

    const remaining = messages.filter(m => !allIds.has(m.id));

    await apiFetch(`/conversations/${conversationId}`, {
      method: 'PUT',
      body: JSON.stringify({ messages: remaining, lastModified: Date.now() }),
      headers: { 'X-Redstart-Device-Id': getDeviceId() }
    });

    return Array.from(allIds);
  }

  static async getAllConversations(): Promise<DatabaseConversation[]> {
    return apiFetch<DatabaseConversation[]>('/conversations', {
      headers: { 'X-Redstart-Device-Id': getDeviceId() }
    });
  }

  static async getConversation(id: string): Promise<DatabaseConversation | undefined> {
    const conv = await apiFetch<DatabaseConversation>(`/conversations/${id}`, {
      headers: { 'X-Redstart-Device-Id': getDeviceId() }
    });
    return conv || undefined;
  }

  static async getConversationMessages(convId: string): Promise<DatabaseMessage[]> {
    const conv = await apiFetch<DatabaseConversation>(`/conversations/${convId}`, {
      headers: { 'X-Redstart-Device-Id': getDeviceId() }
    });
    if (!conv) return [];
    return (conv.messages || []).sort((a, b) => a.timestamp - b.timestamp);
  }

  static async updateConversation(
    id: string,
    updates: Partial<Omit<DatabaseConversation, 'id'>>
  ): Promise<void> {
    await putConversation(id, updates);
  }

  static async toggleConversationPin(id: string): Promise<boolean> {
    const conv = await apiFetch<DatabaseConversation>(`/conversations/${id}`, {
      method: 'GET',
      headers: { 'X-Redstart-Device-Id': getDeviceId() }
    });
    if (!conv) throw new Error(`Conversation ${id} not found`);
    const newPinnedState = !conv.pinned;
    // putConversation, not updateConversation: this already holds the write
    // queue, and the queued updateConversation would wait for it forever.
    await putConversation(id, { pinned: newPinnedState });
    return newPinnedState;
  }

  static async updateCurrentNode(convId: string, nodeId: string): Promise<void> {
    await this.updateConversation(convId, { currNode: nodeId });
  }

  static async updateMessage(
    id: string,
    updates: Partial<Omit<DatabaseMessage, 'id'>>
  ): Promise<void> {
    const convs = await apiFetch<DatabaseConversation[]>('/conversations', {
      headers: { 'X-Redstart-Device-Id': getDeviceId() }
    });

    for (const conv of convs) {
      const messages = conv.messages || [];
      const idx = messages.findIndex(m => m.id === id);
      if (idx === -1) continue;

      messages[idx] = { ...messages[idx], ...updates };

      await apiFetch(`/conversations/${conv.id}`, {
        method: 'PUT',
        body: JSON.stringify({ messages, lastModified: Date.now() }),
        headers: { 'X-Redstart-Device-Id': getDeviceId() }
      });
      return;
    }
  }

  static async importConversations(
    data: { conv: DatabaseConversation; messages: DatabaseMessage[] }[]
  ): Promise<{ imported: number; skipped: number }> {
    let importedCount = 0;
    let skippedCount = 0;

    for (const item of data) {
      const { conv, messages } = item;

      try {
        const existing = await apiFetch<DatabaseConversation>(`/conversations/${conv.id}`, {
          headers: { 'X-Redstart-Device-Id': getDeviceId() }
        });
        if (existing) {
          console.warn(`Conversation "${conv.name}" already exists, skipping...`);
          skippedCount++;
          continue;
        }

        await apiFetch('/conversations', {
          method: 'POST',
          body: JSON.stringify({
            ...conv,
            messages
          }),
          headers: { 'X-Redstart-Device-Id': getDeviceId() }
        });

        importedCount++;
      } catch (err) {
        console.error('Failed to import conversation:', err);
      }
    }

    return { imported: importedCount, skipped: skippedCount };
  }

  static async forkConversation(
    sourceConvId: string,
    atMessageId: string,
    options: { name: string; includeAttachments: boolean }
  ): Promise<DatabaseConversation> {
    const sourceConv = await apiFetch<DatabaseConversation>(`/conversations/${sourceConvId}`, {
      method: 'GET',
      headers: { 'X-Redstart-Device-Id': getDeviceId() }
    });
    if (!sourceConv) throw new Error('Source conversation not found');

    const allMessages = sourceConv.messages || [];
    const pathMessages = filterByLeafNodeId(allMessages, atMessageId, true) as DatabaseMessage[];
    if (pathMessages.length === 0) throw new Error(`Could not resolve message path to ${atMessageId}`);

    const idMap = new Map<string, string>();
    for (const msg of pathMessages) {
      idMap.set(msg.id, uuid());
    }

    const newConvId = uuid();
    const clonedMessages: DatabaseMessage[] = pathMessages.map((msg) => {
      const newId = idMap.get(msg.id)!;
      const newParent = msg.parent ? (idMap.get(msg.parent) ?? null) : null;
      const newChildren = msg.children
        .filter((childId: string) => idMap.has(childId))
        .map((childId: string) => idMap.get(childId)!);

      return {
        ...msg,
        id: newId,
        convId: newConvId,
        parent: newParent,
        children: newChildren,
        extra: options.includeAttachments ? msg.extra : undefined
      };
    });

    const lastClonedMessage = clonedMessages[clonedMessages.length - 1];
    const newConv: DatabaseConversation = {
      id: newConvId,
      name: options.name,
      lastModified: Date.now(),
      currNode: lastClonedMessage.id,
      forkedFromConversationId: sourceConvId,
      mcpServerOverrides: sourceConv.mcpServerOverrides
        ? sourceConv.mcpServerOverrides.map((o: McpServerOverride) => ({
            serverId: o.serverId,
            enabled: o.enabled
          }))
        : undefined,
      messages: clonedMessages
    };

    await apiFetch('/conversations', {
      method: 'POST',
      body: JSON.stringify(newConv),
      headers: { 'X-Redstart-Device-Id': getDeviceId() }
    });

    return newConv;
  }
}

// Every method that changes a stored conversation goes through the write
// queue (see `serialized` above). Wrapped here, once, rather than inside each
// body, so the list of queued writes is one line to read. None of these may
// call another of them; toggleConversationPin uses putConversation for that.
const QUEUED_WRITES = [
  'createMessageBranch',
  'createRootMessage',
  'createSystemMessage',
  'deleteConversation',
  'deleteMessage',
  'deleteMessageCascading',
  'updateConversation',
  'toggleConversationPin',
  'updateMessage'
] as const;

for (const name of QUEUED_WRITES) {
  const original = DatabaseService[name] as (...args: unknown[]) => Promise<unknown>;
  (DatabaseService as unknown as Record<string, unknown>)[name] = (...args: unknown[]) =>
    serialized(() => original.apply(DatabaseService, args));
}
