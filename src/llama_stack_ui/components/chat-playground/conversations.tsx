"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Trash2 } from "lucide-react";
import type { Message } from "@/components/chat-playground/chat-message";
import { useAuthClient } from "@/hooks/use-auth-client";
import { cleanMessageContent } from "@/lib/message-content-utils";

/**
 * ChatSession represents a conversation in the new Responses API model
 * Previously was tied to an Agent, now tied to a PromptTemplate
 */
export interface ChatSession {
  id: string; // conversation_id from backend
  name: string;
  messages: Message[];
  selectedModel: string;
  systemMessage: string;
  templateId: string; // Reference to PromptTemplate (formerly agentId)
  agentId?: string; // Backward compat alias for templateId
  createdAt: number;
  updatedAt: number;
}

interface ConversationManagerProps {
  currentSession: ChatSession | null;
  onSessionChange: (session: ChatSession) => void;
  onNewSession: () => void;
  selectedTemplateId: string; // Changed from selectedAgentId
}

const CURRENT_SESSION_KEY = "chat-playground-current-session";
const CURRENT_TEMPLATE_KEY = "chat-playground-current-template";

// ensures this only happens client side
const safeLocalStorage = {
  getItem: (key: string): string | null => {
    if (typeof window === "undefined") return null;
    try {
      return localStorage.getItem(key);
    } catch (err) {
      console.error("Error accessing localStorage:", err);
      return null;
    }
  },
  setItem: (key: string, value: string): void => {
    if (typeof window === "undefined") return;
    try {
      localStorage.setItem(key, value);
    } catch (err) {
      console.error("Error writing to localStorage:", err);
    }
  },
  removeItem: (key: string): void => {
    if (typeof window === "undefined") return;
    try {
      localStorage.removeItem(key);
    } catch (err) {
      console.error("Error removing from localStorage:", err);
    }
  },
};

const generateSessionId = (): string => {
  return globalThis.crypto.randomUUID();
};

/**
 * Conversations component - manages chat conversations
 *
 * Updated for the Responses API:
 * - Uses /v1/conversations instead of /v1/agents/{id}/sessions
 * - Conversations are linked to PromptTemplates via metadata
 */
export function Conversations({
  currentSession,
  onSessionChange,
  selectedTemplateId,
}: ConversationManagerProps) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newSessionName, setNewSessionName] = useState("");
  const [loading, setLoading] = useState(false);
  const client = useAuthClient();

  /**
   * Load conversations for the selected template
   * Conversations are filtered by template_id in metadata
   */
  const loadConversations = useCallback(async () => {
    if (!selectedTemplateId) return;

    setLoading(true);
    try {
      // Get conversation list from the backend
      const response = await client.conversations.list();
      console.log("Conversations response:", response);

      // Handle both array and paginated response formats
      const conversationList = Array.isArray(response)
        ? response
        : response.data || [];

      // Filter conversations by template_id in metadata
      const templateConversations: ChatSession[] = conversationList
        .filter((conv: { metadata?: { template_id?: string } }) => {
          // Include conversations that belong to this template
          return conv.metadata?.template_id === selectedTemplateId;
        })
        .map((conv: {
          conversation_id?: string;
          id?: string;
          metadata?: { name?: string; template_id?: string };
          created_at?: string | number;
        }) => ({
          id: conv.conversation_id || conv.id || "",
          name: conv.metadata?.name || "Untitled Conversation",
          messages: [],
          selectedModel: currentSession?.selectedModel || "",
          systemMessage:
            currentSession?.systemMessage || "You are a helpful assistant.",
          templateId: selectedTemplateId,
          createdAt: conv.created_at
            ? new Date(conv.created_at).getTime()
            : Date.now(),
          updatedAt: conv.created_at
            ? new Date(conv.created_at).getTime()
            : Date.now(),
        }));

      setSessions(templateConversations);
    } catch (error) {
      console.error("Error loading conversations:", error);
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, [
    selectedTemplateId,
    client,
    currentSession?.selectedModel,
    currentSession?.systemMessage,
  ]);

  useEffect(() => {
    if (selectedTemplateId) {
      loadConversations();
    }
  }, [selectedTemplateId, loadConversations]);

  /**
   * Create a new conversation
   * Uses /v1/conversations endpoint with metadata linking to template
   */
  const createNewConversation = async () => {
    if (!selectedTemplateId) return;

    const conversationName =
      newSessionName.trim() || `Conversation ${sessions.length + 1}`;
    setLoading(true);

    try {
      const response = await client.conversations.create({
        metadata: {
          template_id: selectedTemplateId,
          name: conversationName,
        },
      });

      const newSession: ChatSession = {
        id: response.conversation_id || response.id || generateSessionId(),
        name: conversationName,
        messages: [],
        selectedModel: currentSession?.selectedModel || "",
        systemMessage:
          currentSession?.systemMessage || "You are a helpful assistant.",
        templateId: selectedTemplateId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      setSessions((prev) => [...prev, newSession]);
      SessionUtils.saveCurrentSessionId(newSession.id, selectedTemplateId);
      onSessionChange(newSession);

      setNewSessionName("");
      setShowCreateForm(false);
    } catch (error) {
      console.error("Error creating conversation:", error);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Load messages from a conversation
   * Uses /v1/conversations/{id} to retrieve conversation items
   */
  const loadConversationMessages = useCallback(
    async (conversationId: string): Promise<Message[]> => {
      try {
        const conversation = await client.conversations.retrieve(conversationId);

        // Handle different response formats
        const items = conversation.items || [];

        const messages: Message[] = [];
        for (const item of items) {
          // Handle message items
          if (item.type === "message") {
            const content =
              typeof item.content === "string"
                ? item.content
                : Array.isArray(item.content)
                  ? item.content
                      .map((c: { text?: string }) => c.text || "")
                      .join("")
                  : JSON.stringify(item.content);

            messages.push({
              id: item.id || `msg-${messages.length}`,
              role: item.role || "assistant",
              content: cleanMessageContent(content),
              createdAt: item.created_at
                ? new Date(item.created_at)
                : new Date(),
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

  /**
   * Switch to a different conversation
   */
  const switchToSession = useCallback(
    async (sessionId: string) => {
      const session = sessions.find((s) => s.id === sessionId);
      if (session) {
        setLoading(true);
        try {
          // Load messages for this conversation
          const messages = await loadConversationMessages(sessionId);
          const sessionWithMessages = {
            ...session,
            messages,
          };

          SessionUtils.saveCurrentSessionId(sessionId, selectedTemplateId);
          onSessionChange(sessionWithMessages);
        } catch (error) {
          console.error("Error switching to conversation:", error);
          // Fallback to session without messages
          SessionUtils.saveCurrentSessionId(sessionId, selectedTemplateId);
          onSessionChange(session);
        } finally {
          setLoading(false);
        }
      }
    },
    [sessions, selectedTemplateId, loadConversationMessages, onSessionChange]
  );

  /**
   * Delete a conversation
   */
  const deleteConversation = async (sessionId: string) => {
    if (!selectedTemplateId) {
      return;
    }

    if (
      confirm(
        "Are you sure you want to delete this conversation? This action cannot be undone."
      )
    ) {
      setLoading(true);
      try {
        await client.conversations.delete(sessionId);

        const updatedSessions = sessions.filter((s) => s.id !== sessionId);
        setSessions(updatedSessions);

        if (currentSession?.id === sessionId) {
          const newCurrentSession = updatedSessions[0] || null;
          if (newCurrentSession) {
            SessionUtils.saveCurrentSessionId(
              newCurrentSession.id,
              selectedTemplateId
            );
            onSessionChange(newCurrentSession);
          } else {
            SessionUtils.clearCurrentSession(selectedTemplateId);
            onNewSession();
          }
        }
      } catch (error) {
        console.error("Error deleting conversation:", error);
      } finally {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    if (currentSession) {
      setSessions((prevSessions) => {
        const updatedSessions = prevSessions.map((session) =>
          session.id === currentSession.id ? currentSession : session
        );

        if (!prevSessions.find((s) => s.id === currentSession.id)) {
          updatedSessions.push(currentSession);
        }

        return updatedSessions;
      });
    }
  }, [currentSession]);

  if (!selectedTemplateId) {
    return null;
  }

  return (
    <div className="relative">
      <div className="flex items-center gap-2">
        <Select
          value={currentSession?.id || ""}
          onValueChange={switchToSession}
        >
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="Select Conversation" />
          </SelectTrigger>
          <SelectContent>
            {sessions.map((session) => (
              <SelectItem key={session.id} value={session.id}>
                {session.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          onClick={() => setShowCreateForm(true)}
          variant="outline"
          size="sm"
          disabled={loading || !selectedTemplateId}
        >
          + New
        </Button>

        {currentSession && (
          <Button
            onClick={() => deleteConversation(currentSession.id)}
            variant="outline"
            size="sm"
            className="text-destructive hover:text-destructive hover:bg-destructive/10"
            title="Delete current conversation"
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        )}
      </div>

      {showCreateForm && (
        <Card className="absolute top-full left-0 mt-2 p-4 space-y-3 w-80 z-50 bg-background border shadow-lg">
          <h3 className="text-md font-semibold">Create New Conversation</h3>

          <Input
            value={newSessionName}
            onChange={(e) => setNewSessionName(e.target.value)}
            placeholder="Conversation name (optional)"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                createNewConversation();
              } else if (e.key === "Escape") {
                setShowCreateForm(false);
                setNewSessionName("");
              }
            }}
          />

          <div className="flex gap-2">
            <Button
              onClick={createNewConversation}
              className="flex-1"
              disabled={loading}
            >
              {loading ? "Creating..." : "Create"}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setShowCreateForm(false);
                setNewSessionName("");
              }}
              className="flex-1"
            >
              Cancel
            </Button>
          </div>
        </Card>
      )}

      {currentSession && sessions.length > 1 && (
        <div className="absolute top-full left-0 mt-1 text-xs text-gray-500 whitespace-nowrap">
          {sessions.length} conversations - Current: {currentSession.name}
          {currentSession.messages.length > 0 &&
            ` - ${currentSession.messages.length} messages`}
        </div>
      )}
    </div>
  );
}

/**
 * SessionUtils - Utility functions for managing conversation state
 *
 * Updated for Responses API:
 * - Uses templateId instead of agentId
 * - Maintains backward compatibility with migration support
 */
export const SessionUtils = {
  loadCurrentSessionId: (templateId?: string): string | null => {
    const key = templateId
      ? `${CURRENT_SESSION_KEY}-${templateId}`
      : CURRENT_SESSION_KEY;
    return safeLocalStorage.getItem(key);
  },

  saveCurrentSessionId: (sessionId: string, templateId?: string) => {
    const key = templateId
      ? `${CURRENT_SESSION_KEY}-${templateId}`
      : CURRENT_SESSION_KEY;
    safeLocalStorage.setItem(key, sessionId);
  },

  createDefaultSession: (
    templateId: string,
    inheritModel?: string
  ): ChatSession => ({
    id: generateSessionId(),
    name: "Default Conversation",
    messages: [],
    selectedModel: inheritModel || "",
    systemMessage: "You are a helpful assistant.",
    templateId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }),

  clearCurrentSession: (templateId?: string) => {
    const key = templateId
      ? `${CURRENT_SESSION_KEY}-${templateId}`
      : CURRENT_SESSION_KEY;
    safeLocalStorage.removeItem(key);
  },

  // Template management (replaces agent management)
  loadCurrentTemplateId: (): string | null => {
    return safeLocalStorage.getItem(CURRENT_TEMPLATE_KEY);
  },

  saveCurrentTemplateId: (templateId: string) => {
    safeLocalStorage.setItem(CURRENT_TEMPLATE_KEY, templateId);
  },

  // Backward compatibility aliases
  loadCurrentAgentId: (): string | null => {
    // Try new key first, fall back to old key for migration
    const templateId = safeLocalStorage.getItem(CURRENT_TEMPLATE_KEY);
    if (templateId) return templateId;
    return safeLocalStorage.getItem("chat-playground-current-agent");
  },

  saveCurrentAgentId: (agentId: string) => {
    // Save to new key
    safeLocalStorage.setItem(CURRENT_TEMPLATE_KEY, agentId);
  },

  // Comprehensive session caching
  saveSessionData: (templateId: string, sessionData: ChatSession) => {
    const key = `chat-playground-session-data-${templateId}-${sessionData.id}`;
    safeLocalStorage.setItem(
      key,
      JSON.stringify({
        ...sessionData,
        cachedAt: Date.now(),
      })
    );
  },

  loadSessionData: (
    templateId: string,
    sessionId: string
  ): ChatSession | null => {
    const key = `chat-playground-session-data-${templateId}-${sessionId}`;
    const cached = safeLocalStorage.getItem(key);
    if (!cached) return null;

    try {
      const data = JSON.parse(cached);
      // Check if cache is fresh (less than 1 hour old)
      const cacheAge = Date.now() - (data.cachedAt || 0);
      if (cacheAge > 60 * 60 * 1000) {
        safeLocalStorage.removeItem(key);
        return null;
      }

      // Convert date strings back to Date objects
      return {
        ...data,
        messages: data.messages.map(
          (msg: { createdAt: string; [key: string]: unknown }) => ({
            ...msg,
            createdAt: new Date(msg.createdAt),
          })
        ),
      };
    } catch (error) {
      console.error("Error parsing cached session data:", error);
      safeLocalStorage.removeItem(key);
      return null;
    }
  },

  // Template config caching (replaces agent config caching)
  saveTemplateConfig: (
    templateId: string,
    config: {
      tools?: Array<{ type: string; server_label?: string }>;
      [key: string]: unknown;
    }
  ) => {
    const key = `chat-playground-template-config-${templateId}`;
    safeLocalStorage.setItem(
      key,
      JSON.stringify({
        config,
        cachedAt: Date.now(),
      })
    );
  },

  loadTemplateConfig: (
    templateId: string
  ): {
    tools?: Array<{ type: string; server_label?: string }>;
    [key: string]: unknown;
  } | null => {
    const key = `chat-playground-template-config-${templateId}`;
    const cached = safeLocalStorage.getItem(key);
    if (!cached) return null;

    try {
      const data = JSON.parse(cached);
      // Check if cache is fresh (less than 30 minutes old)
      const cacheAge = Date.now() - (data.cachedAt || 0);
      if (cacheAge > 30 * 60 * 1000) {
        safeLocalStorage.removeItem(key);
        return null;
      }
      return data.config;
    } catch (error) {
      console.error("Error parsing cached template config:", error);
      safeLocalStorage.removeItem(key);
      return null;
    }
  },

  // Backward compatibility for agent config
  saveAgentConfig: (
    agentId: string,
    config: {
      toolgroups?: Array<
        string | { name: string; args: Record<string, unknown> }
      >;
      [key: string]: unknown;
    }
  ) => {
    // Convert toolgroups to tools format
    const tools = config.toolgroups?.map((tg) => {
      if (typeof tg === "string") {
        // Extract server label from toolgroup string like "mcp::graphrag"
        const serverLabel = tg.includes("::")
          ? tg.split("::")[1]
          : tg;
        return { type: "mcp", server_label: serverLabel };
      }
      return { type: "mcp", server_label: tg.name };
    });

    SessionUtils.saveTemplateConfig(agentId, { ...config, tools });
  },

  loadAgentConfig: (
    agentId: string
  ): {
    toolgroups?: Array<
      string | { name: string; args: Record<string, unknown> }
    >;
    [key: string]: unknown;
  } | null => {
    return SessionUtils.loadTemplateConfig(agentId);
  },

  // Clear all cached data for a template
  clearTemplateCache: (templateId: string) => {
    if (typeof window === "undefined") return;

    const keys = Object.keys(localStorage).filter(
      (key) =>
        key.includes(`chat-playground-session-data-${templateId}`) ||
        key.includes(`chat-playground-template-config-${templateId}`)
    );
    keys.forEach((key) => safeLocalStorage.removeItem(key));
  },

  // Backward compatibility alias
  clearAgentCache: (agentId: string) => {
    SessionUtils.clearTemplateCache(agentId);
  },
};
