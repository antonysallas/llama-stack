"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { flushSync } from "react-dom";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Trash2 } from "lucide-react";
import { Chat } from "@/components/chat-playground/chat";
import { type Message } from "@/components/chat-playground/chat-message";
import { VectorDBCreator } from "@/components/chat-playground/vector-db-creator";
import { useAuthClient } from "@/hooks/use-auth-client";
import type { Model } from "llama-stack-client/resources/models";
import type { ResponseCreateParams } from "llama-stack-client/resources/responses";
import {
  PromptTemplateStore,
  type PromptTemplate,
} from "@/lib/prompt-template-store";
import {
  isTextDeltaEvent,
  isCompletedEvent,
  isMCPCallInProgressEvent,
  isMCPCallCompletedEvent,
} from "@/types/responses";

// Extended Model type to include properties from API response
type ModelWithMetadata = Model & {
  id: string;
  custom_metadata?: {
    model_type?: string;
    [key: string]: unknown;
  };
};
import {
  SessionUtils,
  type ChatSession,
} from "@/components/chat-playground/conversations";
import {
  cleanMessageContent,
  extractCleanText,
} from "@/lib/message-content-utils";
import {
  extractThinkTags,
  extractStreamingThinking,
  sanitizeThinkingContent,
} from "@/lib/xml-parser";
import type { ThinkingPart } from "@/components/chat-playground/thinking-block";
export default function ChatPlaygroundPage() {
  const [currentSession, setCurrentSession] = useState<ChatSession | null>(
    null
  );
  const [input, setInput] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState<string | null>(null);
  // Prompt Templates (formerly Agents) - stored in localStorage
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<PromptTemplate | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [showCreateTemplate, setShowCreateTemplate] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState("");
  const [newTemplateInstructions, setNewTemplateInstructions] = useState(
    "You are a helpful assistant."
  );

  // Backward compatibility aliases for code that still uses agent terminology
  const agents = templates.map(t => ({
    agent_id: t.id,
    agent_config: { agent_name: t.name, name: t.name, instructions: t.instructions },
  }));
  const selectedAgentId = selectedTemplateId;
  const setSelectedAgentId = setSelectedTemplateId;
  const selectedAgentConfig = selectedTemplate ? { toolgroups: selectedTemplate.tools } : null;
  const setSelectedAgentConfig = (config: typeof selectedAgentConfig) => {
    // No-op: config is derived from selectedTemplate
    void config;
  };
  const agentsLoading = templatesLoading;
  const setAgentsLoading = setTemplatesLoading;
  const showCreateAgent = showCreateTemplate;
  const setShowCreateAgent = setShowCreateTemplate;
  const newAgentName = newTemplateName;
  const setNewAgentName = setNewTemplateName;
  const newAgentInstructions = newTemplateInstructions;
  const setNewAgentInstructions = setNewTemplateInstructions;
  const [selectedToolgroups, setSelectedToolgroups] = useState<string[]>([]);
  const [availableToolgroups, setAvailableToolgroups] = useState<
    Array<{
      identifier: string;
      provider_id: string;
      type: string;
      provider_resource_id?: string;
      mcp_endpoint?: { uri: string };
    }>
  >([]);
  const [showCreateVectorDB, setShowCreateVectorDB] = useState(false);
  const [availableVectorDBs, setAvailableVectorDBs] = useState<
    Array<{
      identifier: string;
      vector_db_name?: string;
      embedding_model: string;
    }>
  >([]);
  const [uploadNotification, setUploadNotification] = useState<{
    show: boolean;
    message: string;
    type: "success" | "error" | "loading";
  }>({ show: false, message: "", type: "success" });
  const [selectedVectorDBs, setSelectedVectorDBs] = useState<string[]>([]);
  const client = useAuthClient();
  const abortControllerRef = useRef<AbortController | null>(null);

  const isModelsLoading = modelsLoading ?? true;

  // Load template config from localStorage (no longer from backend)
  const loadTemplateConfig = useCallback(
    (templateId: string) => {
      try {
        const template = PromptTemplateStore.get(templateId);
        if (template) {
          setSelectedTemplate(template);
        } else {
          setSelectedTemplate(null);
        }
      } catch (error) {
        console.error("Error loading template config:", error);
        setSelectedTemplate(null);
      }
    },
    []
  );

  // Backward compatibility alias
  const loadAgentConfig = loadTemplateConfig;

  const createDefaultSession = useCallback(
    async (templateId: string) => {
      try {
        let conversationId: string;

        // Try to create a conversation via the API if available
        try {
          const response = await client.conversations.create({
            metadata: {
              template_id: templateId,
              name: "Default Conversation",
            },
          });
          conversationId = (response as { conversation_id?: string; id?: string }).conversation_id ||
            (response as { id?: string }).id ||
            crypto.randomUUID();
        } catch {
          // API might not be available, generate a local ID
          conversationId = `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        }

        const defaultSession: ChatSession = {
          id: conversationId,
          name: "Default Conversation",
          messages: [],
          selectedModel: selectedModel,
          systemMessage: "You are a helpful assistant.",
          templateId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };

        setCurrentSession(defaultSession);
        SessionUtils.saveCurrentSessionId(defaultSession.id, templateId);
        SessionUtils.saveSessionData(templateId, defaultSession);
      } catch (error) {
        console.error("Error creating default conversation:", error);
      }
    },
    [client, selectedModel]
  );

  // Load messages from a conversation
  // Since we cache sessions locally, this primarily serves as a fallback
  const loadConversationMessages = useCallback(
    async (conversationId: string): Promise<Message[]> => {
      try {
        // Try to retrieve from API if available
        const conversation = await client.conversations.retrieve(conversationId);

        if (!conversation) {
          return [];
        }

        // Handle different response formats
        const messagesArray = (conversation as { messages?: unknown[] }).messages;
        if (!messagesArray || !Array.isArray(messagesArray)) {
          return [];
        }

        const messages: Message[] = [];
        for (const msg of messagesArray) {
          const msgObj = msg as { role?: string; content?: unknown; created_at?: string };
          if (msgObj.role === "user" && msgObj.content) {
            messages.push({
              id: `${conversationId}-user-${messages.length}`,
              role: "user",
              content:
                typeof msgObj.content === "string"
                  ? msgObj.content
                  : JSON.stringify(msgObj.content),
              createdAt: new Date(msgObj.created_at || Date.now()),
            });
          } else if (msgObj.role === "assistant" && msgObj.content) {
            const cleanContent = cleanMessageContent(msgObj.content);
            messages.push({
              id: `${conversationId}-assistant-${messages.length}`,
              role: "assistant",
              content: cleanContent,
              createdAt: new Date(msgObj.created_at || Date.now()),
            });
          }
        }

        return messages;
      } catch (error) {
        console.error("Error loading conversation messages:", error);
        return [];
      }
    },
    [client]
  );

  // Backward compatibility alias
  const loadSessionMessages = loadConversationMessages;

  // Load conversations for a template
  // Templates are stored locally, so we primarily use cached sessions
  const loadTemplateConversations = useCallback(
    async (templateId: string) => {
      try {
        // First, try to load from local cache (primary source)
        const savedConversationId = SessionUtils.loadCurrentSessionId(templateId);
        if (savedConversationId) {
          const cachedSession = SessionUtils.loadSessionData(templateId, savedConversationId);
          if (cachedSession) {
            setCurrentSession(cachedSession);
            SessionUtils.saveCurrentSessionId(cachedSession.id, templateId);
            return;
          }
        }

        // No cached session, create a new conversation
        await createDefaultSession(templateId);
      } catch (error) {
        console.error("Error loading template conversations:", error);
        // Fallback to creating a new conversation
        await createDefaultSession(templateId);
      }
    },
    [createDefaultSession]
  );

  // Backward compatibility alias
  const loadAgentSessions = loadTemplateConversations;

  useEffect(() => {
    // Load templates from localStorage (no longer from backend)
    const loadTemplates = () => {
      try {
        setTemplatesLoading(true);
        const templateList = PromptTemplateStore.list();
        setTemplates(templateList);

        if (templateList.length > 0) {
          // Check if there's a previously selected template
          const savedTemplateId = PromptTemplateStore.getCurrentTemplateId() ||
            SessionUtils.loadCurrentAgentId(); // Backward compat

          let templateToSelect = templateList[0];

          // If we have a saved template ID, find it
          if (savedTemplateId) {
            const foundTemplate = templateList.find(t => t.id === savedTemplateId);
            if (foundTemplate) {
              templateToSelect = foundTemplate;
            } else {
              console.log("Previously selected template not found");
            }
          }

          setSelectedTemplateId(templateToSelect.id);
          PromptTemplateStore.setCurrentTemplateId(templateToSelect.id);
          SessionUtils.saveCurrentAgentId(templateToSelect.id); // Backward compat
          // Load template config immediately
          loadTemplateConfig(templateToSelect.id);
          // Note: loadTemplateConversations will be called after models are loaded
        }
      } catch (error) {
        console.error("Error loading templates:", error);
      } finally {
        setTemplatesLoading(false);
      }
    };

    loadTemplates();

    const fetchToolgroups = async () => {
      try {
        const toolgroups = await client.toolgroups.list();

        const toolGroupsArray = Array.isArray(toolgroups)
          ? toolgroups
          : toolgroups &&
              typeof toolgroups === "object" &&
              "data" in toolgroups &&
              Array.isArray((toolgroups as { data: unknown }).data)
            ? (
                toolgroups as {
                  data: Array<{
                    identifier: string;
                    provider_id: string;
                    type: string;
                    provider_resource_id?: string;
                  }>;
                }
              ).data
            : [];

        if (toolGroupsArray && Array.isArray(toolGroupsArray)) {
          // Cast to the expected type, including MCP endpoint URI
          const mappedToolgroups = toolGroupsArray.map((tg: unknown) => {
            const item = tg as {
              identifier?: string;
              provider_id?: string;
              type?: string;
              provider_resource_id?: string;
              mcp_endpoint?: { uri: string };
            };
            return {
              identifier: item.identifier || "",
              provider_id: item.provider_id || "",
              type: item.type || "",
              provider_resource_id: item.provider_resource_id,
              mcp_endpoint: item.mcp_endpoint,
            };
          });
          setAvailableToolgroups(mappedToolgroups);
        } else {
          console.error("Invalid toolgroups data format:", toolgroups);
        }
      } catch (error) {
        console.error("Error fetching toolgroups:", error);
        if (error instanceof Error) {
          console.error("Error details:", {
            name: error.name,
            message: error.message,
            stack: error.stack,
          });
        }
      }
    };

    fetchToolgroups();

    const fetchVectorStores = async () => {
      try {
        const vectorStores = await client.vectorStores.list();
        const vectorStoresData = Array.isArray(vectorStores)
          ? vectorStores
          : (vectorStores as { data?: unknown[] })?.data || [];

        setAvailableVectorDBs(vectorStoresData.map((vs: unknown) => {
          const store = vs as { id?: string; identifier?: string; name?: string; embedding_model?: string };
          return {
            identifier: store.id || store.identifier || "",
            vector_db_name: store.name,
            embedding_model: store.embedding_model || "",
          };
        }));
      } catch (error) {
        console.error("Error fetching vector stores:", error);
      }
    };

    fetchVectorStores();
  }, [client, loadAgentSessions, loadAgentConfig]);

  // Create a new prompt template (stored in localStorage)
  const createNewTemplate = useCallback(
    async (
      name: string,
      instructions: string,
      model: string,
      toolgroups: string[] = [],
      vectorDBs: string[] = []
    ) => {
      try {
        // Convert toolgroups to ToolConfig format for the Responses API
        const tools = toolgroups.map(toolgroup => {
          if (toolgroup === "builtin::rag" && vectorDBs.length > 0) {
            // RAG tools use file_search with vector store IDs
            return {
              type: "file_search" as const,
              vector_store_ids: vectorDBs,
            };
          }
          // MCP tools require both server_label and server_url
          if (toolgroup.startsWith("mcp::")) {
            const serverLabel = toolgroup.replace("mcp::", "");
            // Look up the server_url from availableToolgroups
            const toolgroupInfo = availableToolgroups.find(
              tg => tg.identifier === toolgroup
            );
            const serverUrl = toolgroupInfo?.mcp_endpoint?.uri || "";
            return {
              type: "mcp" as const,
              server_label: serverLabel,
              server_url: serverUrl,
            };
          }
          // Default to MCP tool format - try to find endpoint info
          const toolgroupInfo = availableToolgroups.find(
            tg => tg.identifier === toolgroup
          );
          return {
            type: "mcp" as const,
            server_label: toolgroup,
            server_url: toolgroupInfo?.mcp_endpoint?.uri || "",
          };
        });

        // Create template in localStorage
        const template = PromptTemplateStore.create({
          name: name || "New Template",
          model,
          instructions,
          tools,
        });

        // Refresh template list
        const templateList = PromptTemplateStore.list();
        setTemplates(templateList);

        // Select the new template
        setSelectedTemplateId(template.id);
        PromptTemplateStore.setCurrentTemplateId(template.id);
        loadTemplateConfig(template.id);

        // Create a new conversation for this template
        await createDefaultSession(template.id);

        return template.id;
      } catch (error) {
        console.error("Error creating template:", error);
        throw error;
      }
    },
    [loadTemplateConfig, createDefaultSession, availableToolgroups]
  );

  // Backward compatibility alias
  const createNewAgent = createNewTemplate;

  const handleVectorDBCreated = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async (_vectorStoreId: string) => {
      setShowCreateVectorDB(false);

      try {
        const vectorStores = await client.vectorStores.list();
        const vectorStoresData = Array.isArray(vectorStores)
          ? vectorStores
          : (vectorStores as { data?: unknown[] })?.data || [];

        setAvailableVectorDBs(vectorStoresData.map((vs: unknown) => {
          const store = vs as { id?: string; identifier?: string; name?: string; embedding_model?: string };
          return {
            identifier: store.id || store.identifier || "",
            vector_db_name: store.name,
            embedding_model: store.embedding_model || "",
          };
        }));
      } catch (error) {
        console.error("Error refreshing vector stores:", error);
      }
    },
    [client]
  );

  // Delete a prompt template (from localStorage)
  const deleteTemplate = useCallback(
    async (templateId: string) => {
      if (
        confirm(
          "Are you sure you want to delete this template? This action cannot be undone."
        )
      ) {
        try {
          // Delete from localStorage
          const deleted = PromptTemplateStore.delete(templateId);
          if (!deleted) {
            console.error("Template not found:", templateId);
            return;
          }

          // Clear cached session data
          SessionUtils.clearAgentCache(templateId);

          // Refresh template list
          const templateList = PromptTemplateStore.list();
          setTemplates(templateList);

          // If we deleted the current template, switch to another
          if (selectedTemplateId === templateId) {
            if (templateList.length > 0) {
              const newTemplate = templateList[0];
              setSelectedTemplateId(newTemplate.id);
              PromptTemplateStore.setCurrentTemplateId(newTemplate.id);
              loadTemplateConfig(newTemplate.id);
              await loadTemplateConversations(newTemplate.id);
            } else {
              // No templates left
              setSelectedTemplateId("");
              setCurrentSession(null);
              setSelectedTemplate(null);
            }
          }

          console.log("Template deleted successfully:", templateId);
        } catch (error) {
          console.error("Error deleting template:", error);
          if (error instanceof Error) {
            alert(`Failed to delete template: ${error.message}`);
          }
        }
      }
    },
    [selectedTemplateId, loadTemplateConfig, loadTemplateConversations]
  );

  // Backward compatibility alias
  const deleteAgent = deleteTemplate;

  const handleModelChange = useCallback((newModel: string) => {
    setSelectedModel(newModel);
    setCurrentSession(prev =>
      prev
        ? {
            ...prev,
            selectedModel: newModel,
            updatedAt: Date.now(),
          }
        : prev
    );
  }, []);

  useEffect(() => {
    if (currentSession) {
      // Use templateId (new) or agentId (backward compat) for session storage
      const storageId = currentSession.templateId || currentSession.agentId;
      if (storageId) {
        SessionUtils.saveCurrentSessionId(currentSession.id, storageId);
        // Cache session data
        SessionUtils.saveSessionData(storageId, currentSession);
      }
      // Only update selectedModel if the session has a valid model and it's different from current
      if (
        currentSession.selectedModel &&
        currentSession.selectedModel !== selectedModel
      ) {
        setSelectedModel(currentSession.selectedModel);
      }
    }
  }, [currentSession, selectedModel]);

  useEffect(() => {
    const fetchModels = async () => {
      try {
        setModelsLoading(true);
        setModelsError(null);
        const modelList = await client.models.list();

        // store all models (including embedding models for vector DB creation)
        setModels(modelList);

        // set default LLM model for chat
        const llmModels = modelList.filter(
          (model): model is ModelWithMetadata =>
            (model as ModelWithMetadata).custom_metadata?.model_type === "llm"
        );
        if (llmModels.length > 0) {
          handleModelChange(llmModels[0].id);
        }
      } catch (err) {
        console.error("Error fetching models:", err);
        setModelsError("Failed to fetch available models");
      } finally {
        setModelsLoading(false);
      }
    };

    fetchModels();
  }, [client, handleModelChange]);

  // load agent sessions after both agents and models are ready
  useEffect(() => {
    if (
      selectedAgentId &&
      !agentsLoading &&
      !modelsLoading &&
      selectedModel &&
      !currentSession
    ) {
      loadAgentSessions(selectedAgentId);
    }
  }, [
    selectedAgentId,
    agentsLoading,
    modelsLoading,
    selectedModel,
    currentSession,
    loadAgentSessions,
  ]);

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
  };

  const handleSubmit = async (event?: { preventDefault?: () => void }) => {
    event?.preventDefault?.();
    if (!input.trim()) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: "user",
      content: input.trim(),
      createdAt: new Date(),
    };

    setCurrentSession(prev => {
      if (!prev) return prev;
      const updatedSession = {
        ...prev,
        messages: [...prev.messages, userMessage],
        updatedAt: Date.now(),
      };
      // Update cache with new message
      const storageId = prev.templateId || prev.agentId;
      if (storageId) {
        SessionUtils.saveSessionData(storageId, updatedSession);
      }
      return updatedSession;
    });
    setInput("");

    await handleSubmitWithContent(userMessage.content);
  };

  const handleSubmitWithContent = async (content: string) => {
    if (!currentSession || !selectedTemplateId) return;

    setIsGenerating(true);
    setError(null);

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      // Get the current template for model, instructions, and tools
      const template = selectedTemplate || PromptTemplateStore.get(selectedTemplateId);
      if (!template) {
        throw new Error("No template selected");
      }

      // Build the response request params using the Responses API
      const responseParams: ResponseCreateParams = {
        model: template.model || selectedModel,
        input: content,
        stream: true,
      };

      // Add instructions if available
      if (template.instructions) {
        responseParams.instructions = template.instructions;
      }

      // Add conversation ID to maintain context
      // Note: 'conversation' is for the conversation ID, 'previous_response_id' is for chaining responses
      if (currentSession.id) {
        responseParams.conversation = currentSession.id;
      }

      // Add tools from template (MCP tools, etc.)
      if (template.tools && template.tools.length > 0) {
        // Cast to the expected type - our ToolConfig is compatible
        responseParams.tools = template.tools as ResponseCreateParams["tools"];
      }

      // Create response using the Responses API
      const response = await client.responses.create(responseParams, {
        signal: abortController.signal,
        timeout: 300000, // 5 minutes timeout for RAG queries
      } as { signal: AbortSignal; timeout: number });

      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: "",
        createdAt: new Date(),
      };

      // Process streaming events from the Responses API
      const processStreamEvent = (
        event: unknown
      ): { text: string | null; isToolCall: boolean } => {
        const eventObj = event as Record<string, unknown>;

        // Skip completed events to avoid duplicate content
        if (isCompletedEvent(eventObj)) {
          return { text: null, isToolCall: false };
        }

        // Handle MCP tool calls - skip them from text display
        if (isMCPCallInProgressEvent(eventObj) || isMCPCallCompletedEvent(eventObj)) {
          return { text: null, isToolCall: true };
        }

        // Handle text delta events - this is the main streaming content
        if (isTextDeltaEvent(eventObj)) {
          const delta = (eventObj as { delta?: unknown }).delta;
          if (typeof delta === "string") {
            return { text: extractCleanText(delta), isToolCall: false };
          }
        }

        // Fallback: try to extract text from various event structures
        let text: string | null = null;

        // Check for delta property (common in streaming)
        if (eventObj.delta && typeof eventObj.delta === "string") {
          text = extractCleanText(eventObj.delta);
        }

        // Check for type-specific handling
        if (!text && eventObj.type === "response.output_text.delta") {
          if (typeof eventObj.delta === "string") {
            text = extractCleanText(eventObj.delta);
          }
        }

        // Handle OpenAI-compatible format (choices array)
        const rawEvent = event as Record<string, unknown>;
        const choices = rawEvent.choices;
        if (
          !text &&
          choices &&
          Array.isArray(choices) &&
          choices.length > 0
        ) {
          const choice = choices[0] as Record<string, unknown>;
          if (
            choice.delta &&
            typeof choice.delta === "object" &&
            choice.delta !== null
          ) {
            const delta = choice.delta as Record<string, unknown>;
            if (typeof delta.content === "string") {
              text = extractCleanText(delta.content);
            }
          }
        }

        return { text, isToolCall: false };
      };

      // Add assistant message placeholder
      const storageId = currentSession.templateId || currentSession.agentId;
      setCurrentSession(prev => {
        if (!prev) return null;
        const updatedSession = {
          ...prev,
          messages: [...prev.messages, assistantMessage],
          updatedAt: Date.now(),
        };
        // Update cache with assistant message
        if (storageId) {
          SessionUtils.saveSessionData(storageId, updatedSession);
        }
        return updatedSession;
      });

      let fullContent = "";
      let thinkingBuffer = "";
      const thinkingParts: ThinkingPart[] = [];
      let currentThinkingStartTime: number | null = null;

      for await (const event of response) {
        const { text: deltaText } = processStreamEvent(event);

        if (deltaText) {
          // Add to buffer for thinking extraction
          thinkingBuffer += deltaText;

          // Try to extract thinking content from buffer
          const streamingResult = extractStreamingThinking(thinkingBuffer);

          if (streamingResult.isComplete && streamingResult.thinking) {
            // We have a complete thinking block
            const endTime = Date.now();
            const thinkingPart: ThinkingPart = {
              type: "thinking",
              content: sanitizeThinkingContent(streamingResult.thinking),
              startTime: currentThinkingStartTime || endTime,
              endTime: endTime,
            };
            thinkingParts.push(thinkingPart);
            thinkingBuffer = streamingResult.remainingBuffer;
            currentThinkingStartTime = null;
          } else if (
            !streamingResult.isComplete &&
            streamingResult.thinking &&
            !currentThinkingStartTime
          ) {
            // Start of a thinking block
            currentThinkingStartTime = Date.now();
          }

          // Update full content with text that doesn't include thinking tags
          fullContent += deltaText;
          const extracted = extractThinkTags(fullContent);
          let cleanedFullContent = extracted.cleanText;

          // Remove any incomplete thinking tags from the display text during streaming
          if (extracted.hasIncompleteTag) {
            // Strip incomplete thinking block from the end
            cleanedFullContent = cleanedFullContent.replace(/<think>[\s\S]*$/, '').trim();
          }

          flushSync(() => {
            setCurrentSession(prev => {
              if (!prev) return null;
              const newMessages = [...prev.messages];
              const last = newMessages[newMessages.length - 1];
              if (last.role === "assistant") {
                // Update content with cleaned text (without thinking tags)
                last.content = cleanedFullContent;

                // Add thinking parts to the message
                // Always set parts when we have thinking content to ensure proper rendering
                if (thinkingParts.length > 0) {
                  last.parts = [
                    ...thinkingParts,
                    { type: "text", text: cleanedFullContent },
                  ];
                } else {
                  // Clear parts if no thinking blocks yet
                  last.parts = undefined;
                }
              }
              const updatedSession = {
                ...prev,
                messages: newMessages,
                updatedAt: Date.now(),
              };
              // Update cache with streaming content
              const sid = prev.templateId || prev.agentId;
              if (fullContent.length % 100 === 0 && sid) {
                // Only cache every 100 characters
                SessionUtils.saveSessionData(sid, updatedSession);
              }
              return updatedSession;
            });
          });
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        console.log("Request aborted");
        return;
      }

      console.error("Error sending message:", err);
      setError("Failed to send message. Please try again.");
      setCurrentSession(prev =>
        prev
          ? {
              ...prev,
              messages: prev.messages.slice(0, -1),
              updatedAt: Date.now(),
            }
          : prev
      );
    } finally {
      setIsGenerating(false);
      abortControllerRef.current = null;
      // Cache final session state after streaming completes
      setCurrentSession(prev => {
        if (prev) {
          const storageId = prev.templateId || prev.agentId;
          if (storageId) {
            SessionUtils.saveSessionData(storageId, prev);
          }
        }
        return prev;
      });
    }
  };
  const suggestions = [
    "Write a Python function that prints 'Hello, World!'",
    "Explain step-by-step how to solve this math problem: If x² + 6x + 9 = 25, what is x?",
    "Design a simple algorithm to find the longest palindrome in a string.",
  ];

  const append = (message: { role: "user"; content: string }) => {
    const newMessage: Message = {
      id: Date.now().toString(),
      role: message.role,
      content: message.content,
      createdAt: new Date(),
    };
    setCurrentSession(prev =>
      prev
        ? {
            ...prev,
            messages: [...prev.messages, newMessage],
            updatedAt: Date.now(),
          }
        : prev
    );
    handleSubmitWithContent(newMessage.content);
  };

  const clearChat = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      setIsGenerating(false);
    }

    setCurrentSession(prev =>
      prev ? { ...prev, messages: [], updatedAt: Date.now() } : prev
    );
    setError(null);
  };

  const handleRAGFileUpload = async (file: File) => {
    if (!selectedTemplate?.tools || !selectedTemplateId) {
      setError("No template selected or template has no RAG tools configured");
      return;
    }

    // Find file_search tools that have vector_store_ids configured (new format)
    // Also support legacy toolgroups format for backward compatibility
    const vectorStoreIds: string[] = [];

    for (const tool of selectedTemplate.tools) {
      if (tool.type === "file_search" && "vector_store_ids" in tool) {
        const ids = (tool as { vector_store_ids?: string[] }).vector_store_ids;
        if (ids) {
          vectorStoreIds.push(...ids);
        }
      }
    }

    // Note: Legacy toolgroups format is no longer supported
    // All tools should be in the new ToolConfig format

    if (vectorStoreIds.length === 0) {
      setError("Current template has no vector databases configured for RAG");
      return;
    }

    try {
      setError(null);
      console.log("Uploading file using RAG tool...");

      setUploadNotification({
        show: true,
        message: `📄 Uploading and indexing "${file.name}"...`,
        type: "loading",
      });

      // Determine mime type from file extension
      const getContentType = (filename: string): string => {
        const ext = filename.toLowerCase().split(".").pop();
        switch (ext) {
          case "pdf":
            return "application/pdf";
          case "txt":
            return "text/plain";
          case "md":
            return "text/markdown";
          case "html":
            return "text/html";
          case "csv":
            return "text/csv";
          case "json":
            return "application/json";
          case "docx":
            return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
          case "doc":
            return "application/msword";
          default:
            return "application/octet-stream";
        }
      };

      const mimeType = getContentType(file.name);
      let fileContent: string;

      // handle text files vs binary files differently
      const isTextFile =
        mimeType.startsWith("text/") ||
        mimeType === "application/json" ||
        mimeType === "text/markdown" ||
        mimeType === "text/html" ||
        mimeType === "text/csv";

      if (isTextFile) {
        fileContent = await file.text();
      } else {
        // for PDFs and other binary files, create a data URL
        // use FileReader for efficient base64 conversion
        fileContent = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        });
      }

      for (const vectorStoreId of vectorStoreIds) {
        // Try the new VectorStores file API first, fallback to legacy ragTool
        try {
          // New API: vectorStores.files.create
          await client.vectorStores.files.create(vectorStoreId, {
            file_id: `${file.name}-${Date.now()}`,
            attributes: {
              filename: file.name,
              file_size: file.size,
              uploaded_at: new Date().toISOString(),
              template_id: selectedTemplateId,
            },
            chunking_strategy: {
              type: "auto",
            },
          });
        } catch {
          // Fallback to legacy ragTool API if available
          const toolRuntime = client.toolRuntime as {
            ragTool?: {
              insert: (params: unknown) => Promise<unknown>;
            };
          };
          if (toolRuntime.ragTool) {
            await toolRuntime.ragTool.insert({
              documents: [
                {
                  content: fileContent,
                  document_id: `${file.name}-${Date.now()}`,
                  metadata: {
                    filename: file.name,
                    file_size: file.size,
                    uploaded_at: new Date().toISOString(),
                    template_id: selectedTemplateId,
                  },
                  mime_type: mimeType,
                },
              ],
              vector_db_id: vectorStoreId,
              chunk_size_in_tokens: 512,
            });
          } else {
            throw new Error("RAG file upload API not available");
          }
        }
      }

      console.log("✅ File successfully uploaded using RAG tool");

      setUploadNotification({
        show: true,
        message: `📄 File "${file.name}" uploaded and indexed successfully!`,
        type: "success",
      });

      setTimeout(() => {
        setUploadNotification(prev => ({ ...prev, show: false }));
      }, 4000);
    } catch (err) {
      console.error("Error uploading file using RAG tool:", err);
      const errorMessage =
        err instanceof Error
          ? `Failed to upload file: ${err.message}`
          : "Failed to upload file using RAG tool";

      setUploadNotification({
        show: true,
        message: errorMessage,
        type: "error",
      });

      setTimeout(() => {
        setUploadNotification(prev => ({ ...prev, show: false }));
      }, 6000);
    }
  };

  return (
    <div className="flex flex-col h-full w-full max-w-7xl mx-auto">
      {/* Upload Notification */}
      {uploadNotification.show && (
        <div
          className={`fixed top-4 right-4 z-50 p-4 rounded-lg shadow-lg transition-all duration-300 ${
            uploadNotification.type === "success"
              ? "bg-green-100 border border-green-300 text-green-800"
              : uploadNotification.type === "error"
                ? "bg-red-100 border border-red-300 text-red-800"
                : "bg-blue-100 border border-blue-300 text-blue-800"
          }`}
        >
          <div className="flex items-center gap-2">
            {uploadNotification.type === "loading" && (
              <div className="animate-spin rounded-full h-4 w-4 border-2 border-blue-600 border-t-transparent"></div>
            )}
            <span className="text-sm font-medium">
              {uploadNotification.message}
            </span>
            {uploadNotification.type !== "loading" && (
              <button
                onClick={() =>
                  setUploadNotification(prev => ({ ...prev, show: false }))
                }
                className="ml-2 text-gray-400 hover:text-gray-600"
              >
                ✕
              </button>
            )}
          </div>
        </div>
      )}

      {/* Header */}
      <div className="mb-6">
        <div className="flex justify-between items-center mb-4">
          <h1 className="text-3xl font-bold">Agent Session</h1>
          <div className="flex items-center gap-3">
            {!agentsLoading && agents.length > 0 && (
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium">Agent Session:</label>
                <Select
                  value={selectedAgentId}
                  onValueChange={agentId => {
                    setSelectedAgentId(agentId);
                    SessionUtils.saveCurrentAgentId(agentId);
                    loadAgentConfig(agentId);
                    loadAgentSessions(agentId);
                  }}
                  disabled={agentsLoading}
                >
                  <SelectTrigger className="w-[200px]">
                    <SelectValue
                      placeholder={
                        agentsLoading ? "Loading..." : "Select Agent Session"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {agents.map(agent => (
                      <SelectItem key={agent.agent_id} value={agent.agent_id}>
                        {(() => {
                          if (
                            agent.agent_config &&
                            "name" in agent.agent_config &&
                            typeof agent.agent_config.name === "string"
                          ) {
                            return agent.agent_config.name;
                          }
                          if (
                            agent.agent_config &&
                            "agent_name" in agent.agent_config &&
                            typeof agent.agent_config.agent_name === "string"
                          ) {
                            return agent.agent_config.agent_name;
                          }
                          return `Agent ${agent.agent_id.slice(0, 8)}...`;
                        })()}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedAgentId && (
                  <Button
                    onClick={() => deleteAgent(selectedAgentId)}
                    variant="outline"
                    size="sm"
                    className="text-destructive hover:text-destructive hover:bg-destructive/10"
                    title="Delete current agent"
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                )}
              </div>
            )}
            <Button
              onClick={() => setShowCreateAgent(true)}
              variant="outline"
              size="sm"
            >
              + New Agent
            </Button>
            {!agentsLoading && agents.length > 0 && (
              <Button
                variant="outline"
                onClick={clearChat}
                disabled={isGenerating}
              >
                Clear Chat
              </Button>
            )}
          </div>
        </div>
      </div>
      {/* Main Two-Column Layout */}
      <div className="flex flex-1 gap-6 min-h-0 flex-col lg:flex-row">
        {/* Left Column - Configuration Panel */}
        <div className="w-full lg:w-80 lg:flex-shrink-0 space-y-6 p-4 border border-border rounded-lg bg-muted/30">
          <h2 className="text-lg font-semibold border-b pb-2 text-left">
            Settings
          </h2>

          {/* Model Configuration */}
          <div className="space-y-4 text-left">
            <h3 className="text-lg font-semibold border-b pb-2 text-left">
              Model Configuration
            </h3>
            <div className="space-y-3">
              <div>
                <label className="text-sm font-medium block mb-2">Model</label>
                <Select
                  value={selectedModel}
                  onValueChange={handleModelChange}
                  disabled={isModelsLoading || isGenerating}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue
                      placeholder={
                        isModelsLoading ? "Loading..." : "Select Model"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {models
                      .filter(
                        (model): model is ModelWithMetadata =>
                          (model as ModelWithMetadata).custom_metadata
                            ?.model_type === "llm"
                      )
                      .map(model => (
                        <SelectItem key={model.id} value={model.id}>
                          {model.id}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                {modelsError && (
                  <p className="text-destructive text-xs mt-1">{modelsError}</p>
                )}
              </div>

              <div>
                <label className="text-sm font-medium block mb-2">
                  Agent Instructions
                </label>
                <div className="w-full h-24 px-3 py-2 text-sm border border-input rounded-md bg-muted text-muted-foreground overflow-y-auto">
                  {(selectedAgentId &&
                    agents.find(a => a.agent_id === selectedAgentId)
                      ?.agent_config?.instructions) ||
                    "No agent selected"}
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Instructions are set when creating an agent and cannot be
                  changed.
                </p>
              </div>
            </div>
          </div>

          {/* Agent Tools */}
          <div className="space-y-4 text-left">
            <h3 className="text-lg font-semibold border-b pb-2 text-left">
              Agent Tools
            </h3>
            <div className="space-y-3">
              <div>
                <label className="text-sm font-medium block mb-2 text-muted-foreground">
                  Configured Tools (Coming Soon)
                </label>
                <div className="space-y-2">
                  {selectedTemplate?.tools && selectedTemplate.tools.length > 0 ? (
                    selectedTemplate.tools.map((tool, index: number) => {
                      // Determine tool display based on type
                      let displayName: string;
                      let displayIcon: string;
                      let toolDetails: React.ReactNode = null;

                      switch (tool.type) {
                        case "mcp":
                          displayName = `MCP: ${(tool as { server_label?: string }).server_label || "Unknown"}`;
                          displayIcon = "🔌";
                          break;
                        case "file_search":
                          displayName = "RAG Search";
                          displayIcon = "🔍";
                          const vectorIds = (tool as { vector_store_ids?: string[] }).vector_store_ids;
                          if (vectorIds && vectorIds.length > 0) {
                            toolDetails = (
                              <div className="mt-2 text-xs text-muted-foreground">
                                <span className="font-medium">Vector Stores:</span>
                                <div className="mt-1 flex flex-wrap gap-1">
                                  {vectorIds.map((storeId: string, idx: number) => (
                                    <code
                                      key={idx}
                                      className="px-1.5 py-0.5 bg-muted-foreground/10 rounded text-xs"
                                    >
                                      {storeId}
                                    </code>
                                  ))}
                                </div>
                              </div>
                            );
                          }
                          break;
                        case "web_search":
                          displayName = "Web Search";
                          displayIcon = "🌐";
                          break;
                        case "function":
                          displayName = (tool as { name?: string }).name || "Function";
                          displayIcon = "🔧";
                          break;
                        default:
                          displayName = "Unknown Tool";
                          displayIcon = "❓";
                      }

                      return (
                        <div
                          key={index}
                          className="p-3 border border-input rounded-md bg-muted text-muted-foreground"
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <span className="text-sm">{displayIcon}</span>
                              <span className="text-sm font-medium text-primary">
                                {displayName}
                              </span>
                            </div>
                          </div>
                          {toolDetails}
                        </div>
                      );
                    })
                  ) : (
                    <div className="p-3 border border-input rounded-md bg-muted text-center">
                      <p className="text-sm text-muted-foreground">
                        No tools configured
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        This agent only has text generation capabilities
                      </p>
                    </div>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  Tools are configured when creating an agent and provide
                  additional capabilities like web search, math calculations, or
                  RAG document retrieval.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Right Column - Chat Interface */}
        <div className="flex-1 flex flex-col min-h-0 p-4 border border-border rounded-lg bg-background">
          {error && (
            <div className="mb-4 p-3 bg-destructive/10 border border-destructive/20 rounded-md">
              <p className="text-destructive text-sm">{error}</p>
            </div>
          )}

          {!agentsLoading && agents.length === 0 ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center space-y-4 max-w-md">
                <div className="text-6xl mb-4">🦙</div>
                <h2 className="text-2xl font-semibold text-muted-foreground">
                  Create an Agent with Llama Stack
                </h2>
                <p className="text-muted-foreground">
                  To get started, create your first agent. Each agent is
                  configured with specific instructions, models, and tools to
                  help you with different tasks.
                </p>
                <Button
                  onClick={() => setShowCreateAgent(true)}
                  size="lg"
                  className="mt-4"
                >
                  Create Your First Agent
                </Button>
              </div>
            </div>
          ) : (
            <Chat
              className="flex-1"
              messages={currentSession?.messages || []}
              handleSubmit={handleSubmit}
              input={input}
              handleInputChange={handleInputChange}
              isGenerating={isGenerating}
              append={append}
              suggestions={suggestions}
              setMessages={messages =>
                setCurrentSession(prev =>
                  prev ? { ...prev, messages, updatedAt: Date.now() } : prev
                )
              }
              onRAGFileUpload={handleRAGFileUpload}
            />
          )}
        </div>
      </div>

      {/* Create Agent Modal */}
      {showCreateAgent && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Card className="w-[500px] p-6 space-y-4">
            <h3 className="text-lg font-semibold">Create New Agent</h3>

            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium block mb-2">
                  Agent Name (optional)
                </label>
                <Input
                  value={newAgentName}
                  onChange={e => setNewAgentName(e.target.value)}
                  placeholder="My Custom Agent"
                />
              </div>

              <div>
                <label className="text-sm font-medium block mb-2">Model</label>
                <Select value={selectedModel} onValueChange={setSelectedModel}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select Model" />
                  </SelectTrigger>
                  <SelectContent>
                    {models
                      .filter(
                        (model): model is ModelWithMetadata =>
                          (model as ModelWithMetadata).custom_metadata
                            ?.model_type === "llm"
                      )
                      .map(model => (
                        <SelectItem key={model.id} value={model.id}>
                          {model.id}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <label className="text-sm font-medium block mb-2">
                  System Instructions
                </label>
                <textarea
                  value={newAgentInstructions}
                  onChange={e => setNewAgentInstructions(e.target.value)}
                  placeholder="You are a helpful assistant."
                  className="w-full h-32 px-3 py-2 text-sm border border-input rounded-md resize-none focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                />
              </div>

              <div>
                <label className="text-sm font-medium block mb-2">
                  Tools (optional)
                </label>
                <label className="text-sm font-small block mb-2">
                  NOTE: Tools are not yet implemented
                </label>
                <p className="text-xs text-muted-foreground mb-2">
                  Available toolgroups: {availableToolgroups.length} found
                </p>
                <div className="space-y-2">
                  {availableToolgroups.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      Loading toolgroups...
                    </p>
                  ) : (
                    availableToolgroups.map(toolgroup => (
                      <label
                        key={toolgroup.identifier}
                        className="flex items-center space-x-2"
                      >
                        <input
                          type="checkbox"
                          checked={selectedToolgroups.includes(
                            toolgroup.identifier
                          )}
                          onChange={e => {
                            if (e.target.checked) {
                              setSelectedToolgroups(prev => {
                                const newSelection = [
                                  ...prev,
                                  toolgroup.identifier,
                                ];
                                return newSelection;
                              });
                            } else {
                              setSelectedToolgroups(prev => {
                                const newSelection = prev.filter(
                                  id => id !== toolgroup.identifier
                                );
                                return newSelection;
                              });
                            }
                          }}
                          className="rounded border-input"
                        />
                        <span className="text-sm">
                          <code className="bg-muted px-1 rounded text-xs">
                            {toolgroup.identifier}
                          </code>
                          <span className="text-muted-foreground ml-2">
                            ({toolgroup.provider_id})
                          </span>
                        </span>
                      </label>
                    ))
                  )}
                </div>
                {selectedToolgroups.length === 0 && (
                  <p className="text-xs text-muted-foreground mt-1">
                    No tools selected - agent will only have text generation
                    capabilities.
                  </p>
                )}
                <p className="text-xs text-muted-foreground mt-2 p-2 bg-muted/50 border border-border rounded">
                  <strong>Note:</strong> Selected tools will be configured for
                  the agent. Some tools like RAG may require additional vector
                  DB configuration, and web search tools need API keys. Basic
                  text generation agents work without tools.
                </p>
              </div>

              {/* Vector DB Configuration for RAG */}
              {selectedToolgroups.includes("builtin::rag") && (
                <div>
                  <label className="text-sm font-medium block mb-2">
                    Vector Databases for RAG
                  </label>
                  <div className="flex items-center gap-2 mb-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setShowCreateVectorDB(true)}
                    >
                      + Create Vector DB
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      {availableVectorDBs.length} available
                    </span>
                  </div>
                  <div className="space-y-2 max-h-32 overflow-y-auto">
                    {availableVectorDBs.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No vector databases available. Create one to use RAG
                        tools.
                      </p>
                    ) : (
                      availableVectorDBs.map(vectorDB => (
                        <label
                          key={vectorDB.identifier}
                          className="flex items-center space-x-2"
                        >
                          <input
                            type="checkbox"
                            checked={selectedVectorDBs.includes(
                              vectorDB.identifier
                            )}
                            onChange={e => {
                              if (e.target.checked) {
                                setSelectedVectorDBs(prev => [
                                  ...prev,
                                  vectorDB.identifier,
                                ]);
                              } else {
                                setSelectedVectorDBs(prev =>
                                  prev.filter(id => id !== vectorDB.identifier)
                                );
                              }
                            }}
                            className="rounded border-input"
                          />
                          <span className="text-sm">
                            <code className="bg-muted px-1 rounded text-xs">
                              {vectorDB.identifier}
                            </code>
                            {vectorDB.vector_db_name && (
                              <span className="text-muted-foreground ml-2">
                                ({vectorDB.vector_db_name})
                              </span>
                            )}
                          </span>
                        </label>
                      ))
                    )}
                  </div>
                  {selectedVectorDBs.length === 0 &&
                    selectedToolgroups.includes("builtin::rag") && (
                      <p className="text-xs text-muted-foreground mt-1">
                        ⚠️ RAG tool selected but no vector databases chosen.
                        Create or select a vector database.
                      </p>
                    )}
                </div>
              )}
            </div>

            <div className="flex gap-2 pt-4">
              <Button
                onClick={async () => {
                  try {
                    await createNewAgent(
                      newAgentName,
                      newAgentInstructions,
                      selectedModel,
                      selectedToolgroups,
                      selectedVectorDBs
                    );
                    setShowCreateAgent(false);
                    setNewAgentName("");
                    setNewAgentInstructions("You are a helpful assistant.");
                    setSelectedToolgroups([]);
                    setSelectedVectorDBs([]);
                  } catch (error) {
                    console.error("Failed to create agent:", error);
                  }
                }}
                className="flex-1"
                disabled={!selectedModel || !newAgentInstructions.trim()}
              >
                Create Agent
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setShowCreateAgent(false);
                  setNewAgentName("");
                  setNewAgentInstructions("You are a helpful assistant.");
                  setSelectedToolgroups([]);
                  setSelectedVectorDBs([]);
                }}
                className="flex-1"
              >
                Cancel
              </Button>
            </div>
          </Card>
        </div>
      )}

      {/* Create Vector DB Modal */}
      {showCreateVectorDB && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <VectorDBCreator
            models={models}
            onVectorDBCreated={handleVectorDBCreated}
            onCancel={() => setShowCreateVectorDB(false)}
          />
        </div>
      )}
    </div>
  );
}
