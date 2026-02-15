import { NOTION_TOKEN } from "../constants";
import logger from "../logger";

const log = logger.child({ module: "notion" });

if (!NOTION_TOKEN) {
    log.warn("Missing NOTION_TOKEN — Notion tools will be unavailable");
}

export const NOTION_TOOL_NAMES: string[] = [
    "mcp__notion__get-user",
    "mcp__notion__get-users",
    "mcp__notion__get-self",
    "mcp__notion__post-search",
    "mcp__notion__get-block-children",
    "mcp__notion__patch-block-children",
    "mcp__notion__retrieve-a-block",
    "mcp__notion__update-a-block",
    "mcp__notion__delete-a-block",
    "mcp__notion__retrieve-a-page",
    "mcp__notion__patch-page",
    "mcp__notion__post-page",
    "mcp__notion__retrieve-a-page-property",
    "mcp__notion__retrieve-a-comment",
    "mcp__notion__create-a-comment",
    "mcp__notion__query-data-source",
    "mcp__notion__retrieve-a-data-source",
    "mcp__notion__update-a-data-source",
    "mcp__notion__create-a-data-source",
    "mcp__notion__list-data-source-templates",
    "mcp__notion__retrieve-a-database",
    "mcp__notion__move-page",
];

export const notionMcpServer = NOTION_TOKEN
    ? {
          command: "npx",
          args: ["-y", "@notionhq/notion-mcp-server"],
          env: {
              OPENAPI_MCP_HEADERS: JSON.stringify({
                  Authorization: `Bearer ${NOTION_TOKEN}`,
                  "Notion-Version": "2022-06-28",
              }),
          },
      }
    : null;
