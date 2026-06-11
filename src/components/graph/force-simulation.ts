/**
 * 自研轻量力导向模拟 —— 在 cose 初始布局结束后接管节点位置，
 * 提供持续的"呼吸感"与拖拽交互。纯 TS，无 React 依赖。
 */

import type cytoscape from 'cytoscape';

export interface SimulationHandle {
  stop: () => void;
  /**
   * Drive alpha to 0 so the tick loop runs but stops applying force/velocity.
   * Used when the viewport is about to be resized — without this, the gravity
   * term (which pulls toward cy.extent()'s center) would drag nodes back
   * toward the new center of the enlarged fullscreen canvas, violating the
   * "positions must not change when switching views" contract. Natural
   * reheating via grab/free is preserved, so user interaction still feels alive.
   */
  freeze: () => void;
}

export interface ForceParams {
  repulsion: number;
  idealEdgeLen: number;
}

export function startForceSimulation(cy: cytoscape.Core, params: ForceParams): SimulationHandle {
  let rafId: number | null = null;
  let grabbedNodeId: string | null = null;
  let alpha = 1;
  const ALPHA_DECAY = 0.008;
  const ALPHA_MIN = 0.001;
  const ALPHA_REHEAT = 0.25;
  const REPULSION = params.repulsion;
  const IDEAL_EDGE_LEN = params.idealEdgeLen;
  const SPRING_K = 0.01;
  const GRAVITY = 0.005;
  const VELOCITY_DECAY = 0.6;

  cy.on('grab', 'node', (evt) => {
    grabbedNodeId = evt.target.id();
    alpha = Math.max(alpha, ALPHA_REHEAT);
  });
  cy.on('free', 'node', () => {
    grabbedNodeId = null;
    alpha = Math.max(alpha, ALPHA_REHEAT);
  });

  const vel = new Map<string, { vx: number; vy: number }>();
  cy.nodes().forEach((n) => {
    vel.set(n.id(), { vx: 0, vy: 0 });
  });

  function tick() {
    if (alpha < ALPHA_MIN) {
      rafId = requestAnimationFrame(tick);
      return;
    }
    alpha *= 1 - ALPHA_DECAY;

    const nodes = cy.nodes();
    const bb = cy.extent();
    const centerX = (bb.x1 + bb.x2) / 2;
    const centerY = (bb.y1 + bb.y2) / 2;

    const forces = new Map<string, { fx: number; fy: number }>();
    nodes.forEach((n) => {
      forces.set(n.id(), { fx: 0, fy: 0 });
    });

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const dx = b.position('x') - a.position('x');
        const dy = b.position('y') - a.position('y');
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 24);
        const strength = REPULSION / (dist * dist);
        const fx = (dx / dist) * strength;
        const fy = (dy / dist) * strength;
        forces.get(a.id())!.fx -= fx;
        forces.get(a.id())!.fy -= fy;
        forces.get(b.id())!.fx += fx;
        forces.get(b.id())!.fy += fy;
      }
    }

    cy.edges().forEach((edge) => {
      const s = edge.source();
      const t = edge.target();
      const dx = t.position('x') - s.position('x');
      const dy = t.position('y') - s.position('y');
      const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
      const displacement = dist - IDEAL_EDGE_LEN;
      const strength = SPRING_K * displacement;
      const fx = (dx / dist) * strength;
      const fy = (dy / dist) * strength;
      forces.get(s.id())!.fx += fx;
      forces.get(s.id())!.fy += fy;
      forces.get(t.id())!.fx -= fx;
      forces.get(t.id())!.fy -= fy;
    });

    nodes.forEach((n) => {
      const f = forces.get(n.id())!;
      f.fx += (centerX - n.position('x')) * GRAVITY;
      f.fy += (centerY - n.position('y')) * GRAVITY;
    });

    nodes.forEach((n) => {
      if (n.id() === grabbedNodeId) return;
      const v = vel.get(n.id());
      if (!v) return;
      const f = forces.get(n.id())!;
      v.vx = (v.vx + f.fx * alpha) * VELOCITY_DECAY;
      v.vy = (v.vy + f.fy * alpha) * VELOCITY_DECAY;
      n.position({ x: n.position('x') + v.vx, y: n.position('y') + v.vy });
    });

    rafId = requestAnimationFrame(tick);
  }

  rafId = requestAnimationFrame(tick);

  return {
    stop: () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
    },
    freeze: () => {
      alpha = 0;
    },
  };
}
