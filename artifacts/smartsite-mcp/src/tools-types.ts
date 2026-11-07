export type ToolResult = {
  content: Array<
    | { type: "text"; text: string }
    | {
        type: "resource_link";
        uri: string;
        name: string;
        mimeType?: string;
        description?: string;
      }
  >;
  isError?: boolean;
  /**
   * P-243: the full data a text-shaped content[0] no longer spells out.
   * MCP-spec field (CallToolResultSchema), consumed by a host/panel that
   * wants the whole record without re-parsing content[0]'s prose.
   */
  structuredContent?: Record<string, unknown>;
};
