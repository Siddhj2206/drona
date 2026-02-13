"use client";

import { useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { ExternalLink } from "lucide-react";
import type { AddressGraphData, AddressGraphLink, AddressGraphNode } from "@/lib/graph/address-graph";

const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), { ssr: false });

type AddressGraphProps = {
  data: AddressGraphData;
  className?: string;
};

function nodeColor(kind: AddressGraphNode["kind"]) {
  if (kind === "token") return "#00f3ff";
  if (kind === "deployer") return "#ff9f43";
  if (kind === "owner") return "#ff0055";
  if (kind === "implementation") return "#bc13fe";
  if (kind === "pair") return "#00ff94";
  if (kind === "contract") return "#10b981";
  return "#60a5fa";
}

function readableRole(kind: AddressGraphNode["kind"]) {
  if (kind === "token") return "Token";
  if (kind === "deployer") return "Deployer";
  if (kind === "owner") return "Owner";
  if (kind === "implementation") return "Implementation";
  if (kind === "pair") return "Pair";
  if (kind === "contract") return "Contract holder";
  if (kind === "holder") return "Holder";
  return "Wallet";
}

function getExplorerHref(address: string) {
  return `https://basescan.org/address/${address}`;
}

export function AddressGraph({ data, className }: AddressGraphProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const selectedNode = useMemo(
    () => data.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [data.nodes, selectedNodeId],
  );

  const graphData = useMemo(
    () => ({
      nodes: data.nodes.map((node) => ({ ...node })),
      links: data.links.map((link) => ({ ...link })),
    }),
    [data],
  );

  return (
    <div ref={containerRef} className={className ?? "h-full w-full"}>
      <ForceGraph2D
        graphData={graphData}
        backgroundColor="rgba(0,0,0,0)"
        cooldownTicks={120}
        d3AlphaDecay={0.035}
        d3VelocityDecay={0.4}
        linkDirectionalParticles={(link) => ((link as AddressGraphLink).weight > 2.2 ? 2 : 0)}
        linkDirectionalParticleWidth={1.25}
        linkDirectionalParticleColor={() => "rgba(0,243,255,0.6)"}
        linkColor={(link) => (((link as AddressGraphLink).approximate ? "rgba(255,159,67,0.65)" : "rgba(0,243,255,0.38)"))}
        linkWidth={(link) => Math.max(0.6, Math.min(2.4, ((link as AddressGraphLink).weight ?? 1) * 0.9))}
        nodeRelSize={5}
        nodeVal={(node) => Math.max(1, Math.min(7, (node as AddressGraphNode).weight))}
        nodeColor={(node) => nodeColor((node as AddressGraphNode).kind)}
        onNodeHover={(node) => setHoveredNodeId(node ? (node as AddressGraphNode).id : null)}
        onNodeClick={(node) => {
          const id = (node as AddressGraphNode).id;
          setSelectedNodeId((current) => (current === id ? null : id));
        }}
        nodeCanvasObject={(node, ctx, globalScale) => {
          const current = node as AddressGraphNode & { x?: number; y?: number };
          const x = current.x ?? 0;
          const y = current.y ?? 0;
          const radius = Math.max(2.5, Math.min(10, current.weight * 2));

          ctx.beginPath();
          ctx.arc(x, y, radius, 0, 2 * Math.PI, false);
          ctx.fillStyle = nodeColor(current.kind);
          ctx.shadowColor = "rgba(0,243,255,0.5)";
          ctx.shadowBlur = 10;
          ctx.fill();
          ctx.shadowBlur = 0;

          const shouldShowLabel = hoveredNodeId === current.id;
          if (!shouldShowLabel) {
            return;
          }

          const label = current.label;
          const fontSize = Math.max(10, 12 / globalScale);
          ctx.font = `${fontSize}px monospace`;
          const textWidth = ctx.measureText(label).width;
          const padding = 5;
          const boxWidth = textWidth + padding * 2;
          const boxHeight = fontSize + padding * 2;

          ctx.fillStyle = "rgba(3,0,20,0.92)";
          ctx.strokeStyle = "rgba(0,243,255,0.5)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.rect(x + radius + 6, y - boxHeight / 2, boxWidth, boxHeight);
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle = "#d1f8ff";
          ctx.fillText(label, x + radius + 6 + padding, y + fontSize / 3);
        }}
      />

      {selectedNode ? (
        <div className="pointer-events-auto absolute bottom-3 left-3 max-w-sm rounded-md border border-[#00f3ff]/35 bg-[#030014]/85 p-3">
          <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-[#00f3ff]">{readableRole(selectedNode.kind)}</p>
          <p className="mt-1 font-mono text-xs text-gray-200 break-all">{selectedNode.id}</p>
          {selectedNode.meta ? <p className="mt-2 text-[11px] text-gray-300">{selectedNode.meta}</p> : null}
          <a
            href={getExplorerHref(selectedNode.id)}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.14em] text-[#00f3ff]/80 hover:text-[#00f3ff]"
          >
            Open on BaseScan
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      ) : null}
    </div>
  );
}
