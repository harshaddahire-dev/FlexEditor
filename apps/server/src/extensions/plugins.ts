import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { type ExternalTool, type PluginDefinition, type Skill, manifestSchema, parseSkill, pluginTools, validatePlugin } from '@cutroom/plugin-sdk';

export interface LoadedPlugin {
  id: string;
  name: string;
  version: string;
  description?: string;
  dir: string;
  status: 'ready' | 'error';
  error?: string;
  tools: ExternalTool[];
  skills: Skill[];
}

let generation = 0;

/**
 * Plugins are folders with a plugin.json and an ES module (`export default definePlugin({...})`). They run in the
 * server process with the user's permissions — like any program the user installs — so the agents only get their
 * tools in Full access mode, and each plugin can be switched off.
 */
export async function loadPluginsFrom(dir: string): Promise<LoadedPlugin[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: LoadedPlugin[] = [];
  generation++;
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory()) continue;
    const pdir = path.join(dir, e.name);
    let raw: string;
    try {
      raw = await fs.readFile(path.join(pdir, 'plugin.json'), 'utf8');
    } catch {
      continue;
    }
    const fallback: LoadedPlugin = { id: e.name, name: e.name, version: '?', dir: pdir, status: 'error', tools: [], skills: [] };
    try {
      const manifest = manifestSchema.parse(JSON.parse(raw));
      Object.assign(fallback, { id: manifest.id, name: manifest.name, version: manifest.version, description: manifest.description });
      const main = path.resolve(pdir, manifest.main);
      if (!main.startsWith(pdir + path.sep)) throw new Error('"main" must stay inside the plugin folder.');
      // a new query string per load so "Reload" picks up edits
      const mod = (await import(`${pathToFileURL(main).href}?v=${generation}`)) as { default?: PluginDefinition };
      const def = validatePlugin(mod.default, manifest);
      out.push({
        ...fallback,
        status: 'ready',
        tools: pluginTools(def),
        skills: (def.skills ?? []).map((s) => parseSkill(`---\nname: ${s.name}\ndescription: ${s.description}\n---\n${s.body}`, `plugin:${def.id}`)),
      });
    } catch (err) {
      out.push({ ...fallback, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
