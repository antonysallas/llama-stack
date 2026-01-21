// check if content contains function call JSON
export const containsToolCall = (content: string): boolean => {
  return (
    content.includes('"type": "function"') ||
    content.includes('"name": "knowledge_search"') ||
    content.includes('"parameters":') ||
    !!content.match(/\{"type":\s*"function".*?\}/)
  );
};

export const extractCleanText = (content: string): string | null => {
  // Strip MCP tool metadata like {"question": "..."} from the start of responses
  // This is commonly returned by GraphRAG and other MCP tools
  let cleanedContent = content;
  const questionJsonMatch = cleanedContent.match(/^\s*\{"question":\s*"[^"]*"\}\s*/);
  if (questionJsonMatch) {
    cleanedContent = cleanedContent.substring(questionJsonMatch[0].length);
  }

  if (containsToolCall(cleanedContent)) {
    try {
      // parse and extract non-function call parts
      const jsonMatch = cleanedContent.match(/\{"type":\s*"function"[^}]*\}[^}]*\}/);
      if (jsonMatch) {
        const jsonPart = jsonMatch[0];
        const parsedJson = JSON.parse(jsonPart);

        // if function call, extract text after JSON
        if (parsedJson.type === "function") {
          const textAfterJson = cleanedContent
            .substring(cleanedContent.indexOf(jsonPart) + jsonPart.length)
            .trim();
          return textAfterJson || null;
        }
      }
      return null;
    } catch {
      return null;
    }
  }
  return cleanedContent || null;
};

// removes function call JSON handling different content types
export const cleanMessageContent = (
  content: string | unknown[] | unknown
): string => {
  if (typeof content === "string") {
    const cleaned = extractCleanText(content);
    return cleaned || "";
  } else if (Array.isArray(content)) {
    return content
      .filter((item: { type: string }) => item.type === "text")
      .map((item: { text: string }) => item.text)
      .join("");
  } else {
    return JSON.stringify(content);
  }
};
