import type { SkillRegistry, ToolRegistry } from './agents/types';

interface Registries {
  skillRegistry: SkillRegistry;
  toolRegistry: ToolRegistry;
}

let instance: Registries | null = null;

export function setRuntimeRegistries(r: Registries): void {
  instance = r;
}

export function getRuntimeRegistries(): Registries {
  if (!instance) throw new Error('Runtime registries not initialized — worker boot did not call setRuntimeRegistries');
  return instance;
}
