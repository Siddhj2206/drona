"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { ExternalLink } from "lucide-react";
import type { ForceGraphMethods } from "react-force-graph-2d";
import type { AddressGraphData, AddressGraphLink, AddressGraphNode } from "@/lib/graph/address-graph";

const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), { ssr: false });

type AddressGraphProps = {
  data: AddressGraphData;
  className?: string;
};

type RenderNode = AddressGraphNode & { x?: number; y?: number };
type GraphNodeObject = {
  id?: string | number;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number;
  fy?: number;
} & Record<string, unknown>;
type GraphLinkObject = Record<string, unknown>;
type StrengthForce = { strength: (value: number) => void };
type RadiusForce = { radius: (value: (node: RenderNode) => number) => void };
type DistanceForce = {
  distance: (value: (link: AddressGraphLink) => number) => void;
  strength: (value: number) => void;
};

function nodeColor(kind: AddressGraphNode["kind"]) {
  if (kind === "token") return "#00f3ff";
  if (kind === "deployer") return "#bc13fe";
  if (kind === "owner") return "#ff0055";
  if (kind === "implementation") return "#bc13fe";
  if (kind === "pair") return "#00f3ff";
  if (kind === "contract") return "#4b5563";
  return "#4b5563";
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

function linkColor(link: AddressGraphLink) {
  if (link.kind === "deployed") return "#ff0055";
  if (link.kind === "liquidity") return "#00f3ff";
  if (link.kind === "ownership") return "#bc13fe";
  if (link.approximate) return "#ff9f43";
  return "#4b5563";
}

function outerRadius(node: RenderNode) {
  if (node.kind === "token") return 18;
  if (node.kind === "owner") return 12;
  return Math.max(8, Math.min(11.5, 7 + node.weight * 0.9));
}

function innerRadius(node: RenderNode) {
  if (node.kind === "token") return 13;
  if (node.kind === "owner") return 8.5;
  return Math.max(5.5, Math.min(8.5, 5 + node.weight * 0.55));
}

export function AddressGraph({ data, className }: AddressGraphProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<ForceGraphMethods<GraphNodeObject, GraphLinkObject> | undefined>(undefined);
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

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) {
      return;
    }

    const chargeForce = graph.d3Force("charge") as StrengthForce | undefined;
    if (chargeForce && typeof chargeForce.strength === "function") {
      chargeForce.strength(-520);
    }

    const collisionForce = graph.d3Force("collision") as RadiusForce | undefined;
    if (collisionForce && typeof collisionForce.radius === "function") {
      collisionForce.radius((node: RenderNode) => outerRadius(node) + 12);
    }

    const linkForce = graph.d3Force("link") as DistanceForce | undefined;
    if (linkForce && typeof linkForce.distance === "function") {
      linkForce.distance((link: AddressGraphLink) => {
        if (link.kind === "holding") {
          return 120;
        }
        if (link.kind === "liquidity") {
          return 145;
        }
        return 115;
      });
      if (typeof linkForce.strength === "function") {
        linkForce.strength(0.2);
      }
    }

    graph.d3ReheatSimulation();

    const fitTimer = window.setTimeout(() => {
      graph.zoomToFit(500, 45);
    }, 240);

    return () => window.clearTimeout(fitTimer);
  }, [graphData]);

  return (
    <div ref={containerRef} className={`${className ?? "h-full w-full"} relative`}>
      <ForceGraph2D
        ref={graphRef}
        graphData={graphData}
        backgroundColor="rgba(0,0,0,0)"
        cooldownTicks={260}
        d3AlphaDecay={0.028}
        d3VelocityDecay={0.35}
        minZoom={1.05}
        maxZoom={6}
        linkLineDash={() => [4, 2]}
        linkColor={(link) => linkColor(link as AddressGraphLink)}
        linkWidth={(link) => Math.max(0.8, Math.min(1.9, ((link as AddressGraphLink).weight ?? 1) * 0.6))}
        nodeRelSize={5}
        nodeVal={(node) => Math.max(1, Math.min(3, (node as AddressGraphNode).weight * 0.8))}
        nodeColor={() => "transparent"}
        onNodeHover={(node) => setHoveredNodeId(node ? (node as AddressGraphNode).id : null)}
        onNodeClick={(node) => {
          const id = (node as AddressGraphNode).id;
          setSelectedNodeId((current) => (current === id ? null : id));
        }}
        nodeCanvasObject={(node, ctx, globalScale) => {
          const current = node as RenderNode;
          const x = current.x ?? 0;
          const y = current.y ?? 0;
          const outer = outerRadius(current);
          const inner = innerRadius(current);

          ctx.beginPath();
          ctx.arc(x, y, outer, 0, 2 * Math.PI, false);
          ctx.fillStyle = "transparent";
          ctx.strokeStyle = nodeColor(current.kind);
          ctx.globalAlpha = 0.3;
          ctx.lineWidth = 1;
          ctx.stroke();

          ctx.globalAlpha = 1;
          ctx.beginPath();
          ctx.arc(x, y, inner, 0, 2 * Math.PI, false);
          ctx.fillStyle = "rgba(0,0,0,0.8)";
          ctx.strokeStyle = nodeColor(current.kind);
          ctx.lineWidth = 2;
          ctx.fill();
          ctx.stroke();

          ctx.beginPath();
          ctx.arc(x, y, 2, 0, 2 * Math.PI, false);
          ctx.fillStyle = "#ffffff";
          ctx.shadowColor = "rgba(255,255,255,0.45)";
          ctx.shadowBlur = 4;
          ctx.fill();
          ctx.shadowBlur = 0;

          const shouldShowLabel = hoveredNodeId === current.id;
          if (!shouldShowLabel) {
            return;
          }

          const label = current.label;
          const fontSize = Math.max(10, 11 / globalScale);
          ctx.font = `${fontSize}px monospace`;
          ctx.fillStyle = current.kind === "owner" ? "#ff0055" : "#00f3ff";
          ctx.shadowColor = "rgba(0,0,0,1)";
          ctx.shadowBlur = 5;
          ctx.fillText(label, x + Math.max(inner, 12) + 6, y + 4);
          ctx.shadowBlur = 0;
        }}
      />

      <div className="pointer-events-none absolute top-3 right-3 rounded-md border border-[#00f3ff]/30 bg-[#030014]/78 px-3 py-2">
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#00f3ff]/80">Legend</p>
        <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-gray-300">
          <p className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[#00f3ff]" />Token/Pair</p>
          <p className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[#bc13fe]" />Deployer/Impl</p>
          <p className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[#ff0055]" />Owner</p>
          <p className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[#4b5563]" />Holders</p>
          <p className="inline-flex items-center gap-1.5"><span className="h-[2px] w-4 bg-[#00f3ff]" />Liquidity</p>
          <p className="inline-flex items-center gap-1.5"><span className="h-[2px] w-4 bg-[#ff0055]" />Deploy link</p>
          <p className="inline-flex items-center gap-1.5"><span className="h-[2px] w-4 bg-[#bc13fe]" />Ownership</p>
          <p className="inline-flex items-center gap-1.5"><span className="h-[2px] w-4 bg-[#ff9f43]" />Approx data</p>
        </div>
      </div>

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
