import { useMemo } from 'react';
import ForceGraph2D from 'react-force-graph-2d';

export interface FGNode {
  id: string;
  label: string;
  color: string;
  val?: number;
  [k: string]: unknown;
}
export interface FGLink { source: string; target: string; }

/** Thin wrapper around react-force-graph-2d with our dark theme + sizing. */
export function ForceGraph({ nodes, links, onNodeClick }: {
  nodes: FGNode[];
  links: FGLink[];
  onNodeClick?: (n: FGNode) => void;
}) {
  const data = useMemo(() => ({
    nodes: nodes.map((n) => ({ ...n })),
    links: links.map((l) => ({ source: l.source, target: l.target })),
  }), [nodes, links]);

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <ForceGraph2D
        graphData={data}
        nodeId="id"
        nodeLabel={(n: any) => n.label}
        nodeColor={(n: any) => n.color}
        nodeVal={(n: any) => n.val ?? 1}
        nodeRelSize={5}
        linkColor={() => 'rgba(150,150,160,0.18)'}
        linkDirectionalParticles={0}
        onNodeClick={(n: any) => onNodeClick?.(n as FGNode)}
        cooldownTicks={120}
        backgroundColor="#0f1115"
      />
    </div>
  );
}
