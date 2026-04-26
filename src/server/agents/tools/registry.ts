import type { ToolDef, ToolRegistry } from '../types';

export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, ToolDef>();

  function matches(pattern: string, name: string): boolean {
    if (pattern === '*') return true;
    if (pattern === name) return true;
    if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -2);
      return name === prefix || name.startsWith(prefix + '.');
    }
    return false;
  }

  return {
    register(tool) {
      if (tools.has(tool.name)) {
        throw new Error(`Tool already registered: ${tool.name}`);
      }
      tools.set(tool.name, tool);
    },
    resolve(skillTools) {
      if (!skillTools.length) return [];
      const out: ToolDef[] = [];
      for (const tool of tools.values()) {
        if (skillTools.some(p => matches(p, tool.name))) out.push(tool);
      }
      return out;
    },
    get(name) { return tools.get(name); },
  };
}
