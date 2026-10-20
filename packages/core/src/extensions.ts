/** What the browser sees of skills, plugins and MCP servers (secrets never included). */
export interface SkillInfo {
  name: string;
  description: string;
  /** 'builtin' | 'user' | 'project' | `plugin:<id>` */
  source: string;
  enabled: boolean;
  /** Full instructions, for the preview in the Skills tab. */
  body: string;
}

export type ExtStatus = 'ready' | 'error' | 'disabled' | 'connecting';

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description?: string;
  enabled: boolean;
  status: ExtStatus;
  error?: string;
  tools: { name: string; description: string; scope: 'read' | 'edit' }[];
  skills: string[];
  dir: string;
}

export type McpTransport = 'stdio' | 'http';

export interface McpServerInfo {
  id: string;
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  /** Names only: values are encrypted at rest and never sent back. */
  envKeys: string[];
  headerKeys: string[];
  enabled: boolean;
  status: ExtStatus;
  error?: string;
  tools: { name: string; description: string }[];
}

export interface McpServerInput {
  id?: string;
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  /** Write-only. Omitted keys keep their stored value when editing. */
  env?: Record<string, string>;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export interface ExtensionsInfo {
  skills: SkillInfo[];
  plugins: PluginInfo[];
  mcp: McpServerInfo[];
  /** Folders scanned, so the user knows where to drop their own. */
  dirs: { skills: string[]; plugins: string[] };
  errors: string[];
}
