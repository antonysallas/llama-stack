# UI Migration Plan: Agents API to Responses API

## Problem Statement

The Llama Stack UI currently uses the deprecated Agents API (`client.agents.*`) which no longer exists in llama-stack v0.4.0+. The backend has migrated to the OpenAI-style Responses API (`/v1/responses`) and Conversations API (`/v1/conversations`).

### Current State

- **UI Client**: llama-stack-client@0.3.5 (has `client.agents.*`)
- **Backend**: llama-stack v0.4.0.dev0 (has `/v1/responses`, no `/v1/agents`)
- **Result**: 404 errors when creating agents

### API Comparison

| Old Agents API | New Responses API |
|----------------|-------------------|
| `POST /v1/agents` | N/A (stateless - config per request) |
| `GET /v1/agents` | N/A |
| `DELETE /v1/agents/{id}` | N/A |
| `POST /v1/agents/{id}/sessions` | `POST /v1/conversations` |
| `GET /v1/agents/{id}/sessions` | `GET /v1/conversations` |
| `DELETE /v1/agents/{id}/sessions/{sid}` | `DELETE /v1/conversations/{id}` |
| `POST /v1/agents/{id}/sessions/{sid}/turns` | `POST /v1/responses` |

## Proposed Solution

### Architecture Change

**Before (Agent-centric):**

```
Agent (persistent config) -> Session -> Turn -> Response
```

**After (Conversation-centric):**

```
Conversation -> Response (with inline config)
```

### Key Differences

1. **No persistent agents**: Agent config (model, instructions, tools) is passed with each response request
2. **Conversations replace sessions**: Use `/v1/conversations` for state management
3. **Responses replace turns**: Use `/v1/responses` with `conversation` parameter

## Implementation Details

### Phase 1: Update Client Library

**File**: `package.json`

```json
"llama-stack-client": "0.4.0-rc2"
```

The 0.4.0-rc2 client has:

- `client.responses.create()` - Create responses with streaming
- `client.conversations.create()` - Create conversations
- `client.conversations.retrieve()` - Get conversation with items
- `client.conversations.delete()` - Delete conversation

### Phase 2: Create Agent Config Store (LocalStorage)

Since agents are no longer persistent on the backend, store configurations locally.

**New File**: `lib/agent-config-store.ts`

```typescript
interface AgentConfig {
  id: string;
  name: string;
  model: string;
  instructions: string;
  tools: ToolConfig[];
  createdAt: number;
  updatedAt: number;
}

interface ToolConfig {
  type: "mcp";
  server_label: string;
  // or other tool types
}

export const AgentConfigStore = {
  list(): AgentConfig[];
  get(id: string): AgentConfig | null;
  create(config: Omit<AgentConfig, 'id' | 'createdAt' | 'updatedAt'>): AgentConfig;
  update(id: string, config: Partial<AgentConfig>): AgentConfig;
  delete(id: string): void;
};
```

### Phase 3: Update API Calls

#### 3.1 Replace Agent CRUD

**Before:**

```typescript
const agentList = await client.agents.list();
const response = await client.agents.create({ agent_config: {...} });
await client.agents.delete(agentId);
```

**After:**

```typescript
const agentList = AgentConfigStore.list();
const agent = AgentConfigStore.create({ name, model, instructions, tools });
AgentConfigStore.delete(agentId);
```

#### 3.2 Replace Session Management

**Before:**

```typescript
const session = await client.agents.session.create(agentId, { session_name });
const sessions = await client.agents.session.list(agentId);
const sessionData = await client.agents.session.retrieve(agentId, sessionId);
await client.agents.session.delete(agentId, sessionId);
```

**After:**

```typescript
const conversation = await client.conversations.create({
  metadata: { agent_id: agentId, name: sessionName }
});
// List conversations (filter by agent_id in metadata)
const conversations = await client.conversations.list();
const conversationData = await client.conversations.retrieve(conversationId);
await client.conversations.delete(conversationId);
```

#### 3.3 Replace Turn Creation with Response Creation

**Before:**

```typescript
const response = await client.agents.turn.create(agentId, sessionId, {
  messages: [{ role: "user", content: userMessage }],
  stream: true,
});

for await (const chunk of response) {
  if (chunk.event.payload.event_type === "step_progress") {
    // Handle delta
  }
  if (chunk.event.payload.event_type === "turn_complete") {
    // Handle completion
  }
}
```

**After:**

```typescript
const agentConfig = AgentConfigStore.get(agentId);

const response = await client.responses.create({
  model: agentConfig.model,
  instructions: agentConfig.instructions,
  input: userMessage, // or array of messages
  conversation: conversationId,
  tools: agentConfig.tools.map(t => ({
    type: "mcp",
    server_label: t.server_label,
  })),
  stream: true,
});

for await (const event of response) {
  if (event.type === "response.output_text.delta") {
    // Handle text delta
  }
  if (event.type === "response.completed") {
    // Handle completion
  }
}
```

### Phase 4: Update Stream Event Handling

#### Event Type Mapping

| Old Event | New Event |
|-----------|-----------|
| `turn_start` | `response.created` |
| `step_start` | `response.output_item.added` |
| `step_progress` (text) | `response.output_text.delta` |
| `step_progress` (tool) | `response.function_call_arguments.delta` |
| `step_complete` | `response.output_item.done` |
| `turn_complete` | `response.completed` |

### Phase 5: Update UI Components

#### Files to Modify

1. **`app/chat-playground/page.tsx`** (~2000 lines)
   - Replace all `client.agents.*` calls
   - Update state management for agent configs
   - Update stream processing logic

2. **`components/chat-playground/conversations.tsx`** (~566 lines)
   - Replace session API calls with conversation API calls
   - Update session loading logic

3. **`hooks/use-auth-client.ts`**
   - Verify client initialization works with new version

4. **`lib/session-utils.ts`**
   - Update to work with conversation IDs instead of agent+session IDs

### Phase 6: MCP Tool Integration

The new Responses API has native MCP support:

```typescript
const response = await client.responses.create({
  model: "model-id",
  input: "Query the codebase for all playbooks",
  tools: [
    {
      type: "mcp",
      server_label: "graphrag",  // Matches toolgroup_id prefix
    }
  ],
  stream: true,
});
```

This will automatically use the `mcp::graphrag` toolgroup configured in `run.yaml`.

## Files to Create/Modify

### New Files

| File | Purpose |
|------|---------|
| `lib/agent-config-store.ts` | LocalStorage-based agent config management |
| `lib/responses-api.ts` | Helper functions for Responses API |
| `types/responses.ts` | TypeScript types for Responses API |

### Modified Files

| File | Changes |
|------|---------|
| `package.json` | Update llama-stack-client to 0.4.0-rc2 |
| `app/chat-playground/page.tsx` | Major refactor - replace agents API |
| `components/chat-playground/conversations.tsx` | Replace sessions with conversations |
| `hooks/use-auth-client.ts` | Verify compatibility |
| `lib/session-utils.ts` | Update for conversation IDs |

## Migration Steps

1. Update `llama-stack-client` to `0.4.0-rc2`
2. Create `AgentConfigStore` for local agent management
3. Create type definitions for Responses API
4. Update `page.tsx` to use new APIs
5. Update `conversations.tsx` for conversation management
6. Update stream event handling
7. Test with GraphRAG MCP tools
8. Update any remaining components

## Testing Plan

1. **Agent Management**
   - Create new agent config
   - List agent configs
   - Delete agent config
   - Edit agent config

2. **Conversation Management**
   - Create new conversation
   - List conversations
   - Load conversation history
   - Delete conversation

3. **Chat Functionality**
   - Send message and receive streaming response
   - Verify MCP tool calls work (GraphRAG)
   - Verify conversation context is maintained

4. **Edge Cases**
   - Handle network errors
   - Handle empty conversations
   - Handle tool call failures

## Rollback Plan

If issues arise, revert to:

1. `llama-stack-client@0.3.5`
2. Original `page.tsx` and `conversations.tsx`
3. Run an older llama-stack backend version with `/v1/agents`
