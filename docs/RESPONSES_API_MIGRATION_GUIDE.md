# Llama Stack API Migration Guide: Agents to Responses API

## Overview

This document describes the migration from the deprecated Agents API (`/v1/agents`) to the new
OpenAI-compatible Responses API (`/v1/responses`) and Conversations API (`/v1/conversations`)
in Llama Stack v0.4.0+.

## Why This Migration?

### Industry Alignment

The AI industry is moving toward simpler, more flexible APIs:

- **OpenAI deprecated their Assistants API** in favor of the Responses API (announced March 2025)
- **Single-request model**: All configuration is passed per-request rather than requiring
  persistent server-side objects
- **Reduced complexity**: No need to manage agent lifecycle, sessions, or server-side state

### Benefits

1. **Simpler architecture**: No persistent agents on the server
2. **Faster cold starts**: No agent initialization required
3. **Better flexibility**: Change model/instructions per request
4. **Improved caching**: More efficient request-response caching
5. **OpenAI compatibility**: Easier migration between providers

## Architecture Changes

### Old Model (Agents API)

```text
Agent (persistent) --> Session --> Turn --> Response
     |
     +-- agent_id (server-side)
     +-- model, instructions, tools (fixed)
```

### New Model (Responses API)

```text
Conversation (optional) --> Response (with inline config)
     |
     +-- conversation_id (for context)
     +-- model, instructions, tools (per-request)
```

## Concept Mapping

| Old Concept | New Concept | Storage Location |
|-------------|-------------|------------------|
| Agent | Prompt Template | LocalStorage (browser) |
| Session | Conversation | Backend `/v1/conversations` |
| Turn | Response | Backend `/v1/responses` |
| agent_id | template_id | LocalStorage |
| session_id | conversation_id | Backend |
| turn_id | response_id | Backend |
| agent_config | inline params | Per-request |

## API Changes

### Creating Responses (Previously: Creating Turns)

**Old (Agents API):**

```python
# Create an agent first
agent = client.agents.create(
    agent_config={
        "model": "llama-3.1-8b-instruct",
        "instructions": "You are a helpful assistant.",
        "tools": [{"type": "web_search"}],
    }
)

# Create a session
session = client.agents.session.create(agent.agent_id)

# Create a turn (chat message)
response = client.agents.turn.create(
    agent_id=agent.agent_id,
    session_id=session.session_id,
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True
)
```

**New (Responses API):**

```python
# Everything in one request - no agent creation needed
response = client.responses.create(
    model="llama-3.1-8b-instruct",
    instructions="You are a helpful assistant.",
    input="Hello!",
    tools=[{"type": "web_search"}],
    stream=True
)
```

### Using Conversations for Multi-Turn Context

**Old (Agents API):**

```python
# Session automatically maintained context
response = client.agents.turn.create(
    agent_id=agent.agent_id,
    session_id=session.session_id,
    messages=[{"role": "user", "content": "What's the weather?"}],
)
```

**New (Responses API):**

```python
# Create a conversation (optional)
conversation = client.conversations.create(
    metadata={"name": "Weather Chat"}
)

# Reference the previous response for context
response = client.responses.create(
    model="llama-3.1-8b-instruct",
    input="What's the weather?",
    previous_response_id=previous_response.id,  # For context
    # OR use conversation_id
    conversation=conversation.id,
)
```

### MCP Tool Configuration

**Old (Agents API):**

```python
agent = client.agents.create(
    agent_config={
        "model": "llama-3.1-8b-instruct",
        "toolgroups": ["mcp::graphrag"],
    }
)
```

**New (Responses API):**

```python
response = client.responses.create(
    model="llama-3.1-8b-instruct",
    input="Query the knowledge graph",
    tools=[
        {
            "type": "mcp",
            "server_label": "graphrag",  # MCP server label
        }
    ],
    stream=True
)
```

### Vector Stores (Previously: VectorDBs)

**Old:**

```python
client.vectorDBs.register(
    vector_db_id="my-vectors",
    embedding_model="all-MiniLM-L6-v2",
    embedding_dimension=384,
)
```

**New:**

```python
client.vectorStores.create(
    name="my-vectors",
    embedding_model="all-MiniLM-L6-v2",
    embedding_dimension=384,
)
```

## Streaming Event Changes

### Event Type Mapping

| Old Event Type | New Event Type |
|---------------|----------------|
| `turn_start` | `response.created` |
| `step_start` | `response.output_item.added` |
| `step_progress` (text) | `response.output_text.delta` |
| `step_progress` (tool) | `response.mcp_call.arguments.delta` |
| `step_complete` | `response.output_item.done` |
| `turn_complete` | `response.completed` |

### Handling Streaming Events

**Old:**

```python
for chunk in response:
    if chunk.event.payload.event_type == "step_progress":
        text = chunk.event.payload.text_delta_payload.text
        print(text, end="")
```

**New:**

```python
for event in response:
    if event.type == "response.output_text.delta":
        print(event.delta, end="")
```

## Frontend Migration

### Prompt Template Storage

Since agents are no longer stored on the server, we use localStorage:

```typescript
// lib/prompt-template-store.ts
export interface PromptTemplate {
  id: string;
  name: string;
  model: string;
  instructions: string;
  tools: ToolConfig[];
  temperature?: number;
  createdAt: number;
  updatedAt: number;
}

export const PromptTemplateStore = {
  list(): PromptTemplate[];
  get(id: string): PromptTemplate | null;
  create(template: Omit<PromptTemplate, 'id' | 'createdAt' | 'updatedAt'>): PromptTemplate;
  update(id: string, updates: Partial<PromptTemplate>): PromptTemplate | null;
  delete(id: string): boolean;
};
```

### Tool Configuration Types

```typescript
// types/responses.ts
export interface MCPToolConfig {
  type: "mcp";
  server_label: string;
  allowed_tools?: string[];
}

export interface FileSearchToolConfig {
  type: "file_search";
  vector_store_ids?: string[];
}

export interface WebSearchToolConfig {
  type: "web_search";
}

export interface FunctionToolConfig {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type ToolConfig =
  | MCPToolConfig
  | FileSearchToolConfig
  | WebSearchToolConfig
  | FunctionToolConfig;
```

## Data Migration

The prompt-template-store includes automatic migration from old agent configs:

```typescript
// Automatic migration runs on first access
function migrateFromAgentConfigs(): void {
  const oldData = localStorage.getItem("llama-stack-agent-configs");
  if (oldData && !localStorage.getItem("llama-stack-prompt-templates")) {
    const agents = JSON.parse(oldData);
    const templates = agents.map(agent => ({
      ...agent,
      id: agent.id.replace(/^agent_/, "template_"),
    }));
    localStorage.setItem("llama-stack-prompt-templates", JSON.stringify(templates));
  }
}
```

## Client Library Updates

Ensure you're using the latest client:

```json
{
  "dependencies": {
    "llama-stack-client": "^0.4.0"
  }
}
```

## Common Issues

### Error: `client.agents is undefined`

This means you're using llama-stack-client 0.4.0+ which removed the agents API.
Migrate to the Responses API as described above.

### Error: `404 /v1/agents`

The backend no longer has the `/v1/agents` endpoint. Use `/v1/responses` instead.

### Error: `client.vectorDBs is undefined`

Use `client.vectorStores` instead. The API has been renamed for OpenAI compatibility.

## Testing the Migration

1. **Create a prompt template**: Use the UI to create a new template with your model and instructions
2. **Start a conversation**: The UI will create a conversation via the Conversations API
3. **Send a message**: Messages use the Responses API with streaming
4. **Verify MCP tools**: If using MCP tools like GraphRAG, verify they're called correctly

## Rollback (Not Recommended)

If you must rollback temporarily:

1. Downgrade client: `npm install llama-stack-client@0.3.5`
2. Ensure your backend is running an older version with `/v1/agents` support
3. Note: This is a temporary solution as the Agents API is deprecated

## Resources

- [Llama Stack Documentation](https://llamastack.github.io/)
- [OpenAI Responses API](https://platform.openai.com/docs/api-reference/responses)
- [MCP Protocol](https://modelcontextprotocol.io/)
