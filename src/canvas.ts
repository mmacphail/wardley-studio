import type { ComponentType, Metamodel, WardleyMap } from "./types.ts";
import { escape as e } from "./icons.ts";
import { stageIndex } from "./model.ts";
export const PLOT = { x: 90, y: 40, w: 920, h: 610 };
export const point = (evolution: number, visibility: number) => ({
  x: PLOT.x + evolution * PLOT.w,
  y: PLOT.y + (1 - visibility) * PLOT.h,
});
export const canvasStyle = `
  text{font-family:Inter,"Segoe UI",Arial,sans-serif;fill:#33413d;user-select:none}
  .stage-name{font-size:14px;font-weight:600;fill:#5f6962}.stage-number{font-size:11px;fill:#949a92;letter-spacing:2px}
  .axis-label{font-size:10px;fill:#939990;letter-spacing:1.8px}.axis-title{font-size:10px;fill:#778278;letter-spacing:2px}
  .node-label{font-size:15px;font-weight:500;paint-order:stroke;stroke:#fdfcf9;stroke-width:5px;stroke-linejoin:round}
  .edge-label{font-size:10px;fill:#828b81;paint-order:stroke;stroke:#fdfcf9;stroke-width:4px}
  .node{cursor:grab;outline:none}.node:active{cursor:grabbing}.node:focus .node-halo{stroke:#bd633e;stroke-width:2}
  .port{opacity:0;cursor:crosshair}.node:hover .port,.node.selected .port{opacity:1}
  .edge{cursor:pointer}.edge-line{fill:none;stroke:#b1b9ae;stroke-width:1.5;vector-effect:non-scaling-stroke}
  .edge:hover .edge-line{stroke:#65796c;stroke-width:2}.edge.selected .edge-line{stroke:#bd633e;stroke-width:2}
`;
export function shape(t: ComponentType, size = 9, fill = "#fdfcf9"): string {
  const attrs = `fill="${fill}" stroke="${t.color}" stroke-width="2"`;
  if (t.shape === "diamond")
    return `<path d="M0 ${-size} ${size} 0 0 ${size} ${-size} 0Z" ${attrs}/>`;
  if (t.shape === "square")
    return `<rect x="${-size + 1}" y="${-size + 1}" width="${size * 2 - 2}" height="${size * 2 - 2}" rx="2" ${attrs}/>`;
  if (t.shape === "hexagon")
    return `<path d="M${-size} 0 ${-size / 2} ${-size * 0.87} ${size / 2} ${-size * 0.87} ${size} 0 ${size / 2} ${size * 0.87} ${-size / 2} ${size * 0.87}Z" ${attrs}/>`;
  if (t.shape === "person")
    return `<circle cx="0" cy="-5" r="4" ${attrs}/><path d="M-8 10v-3a8 8 0 0 1 16 0v3" fill="${fill}" stroke="${t.color}" stroke-width="2"/>`;
  return `<circle r="${size}" ${attrs}/>`;
}
export function typeIcon(t: ComponentType, size = 22) {
  return `<svg width="${size}" height="${size}" viewBox="-14 -14 28 28" aria-hidden="true">${shape(t, 8, "none")}</svg>`;
}
export function graphContent(
  map: WardleyMap,
  model: Metamodel,
  selected: string | null,
  connectFrom: string | null,
  labels: boolean,
): string {
  const axisType =
    model.componentTypes.find(
      (t) => t.id === model.mapKinds.find((k) => k.id === map.kind)?.axisType,
    ) ?? model.componentTypes[0];
  const stages = axisType.stageLabels;
  const stageGuides = stages
    .map((s, i) => {
      const x = PLOT.x + (i * PLOT.w) / 4;
      return `<rect x="${x}" y="${PLOT.y}" width="${PLOT.w / 4}" height="${PLOT.h}" fill="${i % 2 ? "#f5f5ee" : "#fcfbf7"}" opacity=".52"/>
      <text class="stage-name" x="${x + 115}" y="682" text-anchor="middle">${e(s)}</text>
      ${i ? `<path d="M${x} ${PLOT.y}V650" stroke="#d9ddd2" stroke-dasharray="3 6"/>` : ""}`;
    })
    .join("");
  const edges = map.edges
    .map((edge) => {
      const a = map.nodes.find((n) => n.id === edge.source),
        b = map.nodes.find((n) => n.id === edge.target);
      if (!a || !b) return "";
      const p = point(a.evolution, a.visibility),
        q = point(b.evolution, b.visibility);
      const d = Math.hypot(q.x - p.x, q.y - p.y) || 1,
        dx = ((q.x - p.x) / d) * 12,
        dy = ((q.y - p.y) / d) * 12;
      const path = `M${p.x + dx},${p.y + dy}L${q.x - dx},${q.y - dy}`;
      return `<g class="edge ${selected === edge.id ? "selected" : ""}" data-edge="${e(edge.id)}" tabindex="0" role="button" aria-label="${e(a.label)} to ${e(b.label)}">
      <path d="${path}" stroke="transparent" stroke-width="16" fill="none"/>
      <path class="edge-line" d="${path}" ${edge.kind === "evolution" ? 'stroke-dasharray="6 5" marker-end="url(#evolution-arrow)" style="stroke:#bd633e"' : 'marker-end="url(#dependency-arrow)"'}/>
      ${labels && edge.label ? `<text class="edge-label" x="${(p.x + q.x) / 2 + 5}" y="${(p.y + q.y) / 2 - 7}">${e(edge.label)}</text>` : ""}</g>`;
    })
    .join("");
  const nodes = map.nodes
    .map((n) => {
      const t = model.componentTypes.find((t) => t.id === n.type)!;
      const p = point(n.evolution, n.visibility);
      const active = selected === n.id,
        source = connectFrom === n.id;
      const target =
        n.targetEvolution !== undefined
          ? point(n.targetEvolution, n.visibility)
          : null;
      return `${target && target.x > p.x + 1 ? `<path d="M${p.x + 14},${p.y}H${target.x - 13}" fill="none" stroke="#bd633e" stroke-width="1.5" stroke-dasharray="6 5" marker-end="url(#evolution-arrow)"/><g transform="translate(${target.x},${target.y})" opacity=".45">${shape(t, 8)}</g>` : ""}
      <g class="node ${active ? "selected" : ""}" data-node="${e(n.id)}" transform="translate(${p.x},${p.y})" tabindex="0" role="button" aria-label="${e(n.label)}, ${e(t.label)}, ${e(t.stageLabels[stageIndex(n.evolution)])}">
      <title>${e(n.label)} · ${e(t.label)} · ${e(t.stageLabels[stageIndex(n.evolution)])}</title>
      ${labels ? `<rect x="${p.x > 880 ? -Math.min(n.label.length, 35) * 9 - 20 : -23}" y="-35" width="${Math.min(n.label.length, 35) * 9 + 44}" height="59" fill="transparent"/>` : ""}
      <circle r="23" fill="transparent"/>
      <circle class="node-halo" r="19" fill="${active || source ? "#f2e5db" : "none"}" stroke="${source ? "#bd633e" : "none"}" stroke-dasharray="${source ? "3 3" : "none"}"/>
      ${shape(t, 8, active ? t.color + "16" : "#fdfcf9")}
      ${n.inertia ? '<path d="M-5 15H5" stroke="#bd633e" stroke-width="3" stroke-linecap="round"/>' : ""}
      ${labels ? `<text class="node-label" x="${p.x > 880 ? -15 : 14}" y="-15" text-anchor="${p.x > 880 ? "end" : "start"}">${e(n.label.length > 35 ? n.label.slice(0, 33) + "…" : n.label)}</text>` : ""}
      <g class="port" data-port="${e(n.id)}" transform="translate(0,24)"><circle r="8" fill="#fdfcf9" stroke="#bd633e" stroke-width="1.5"/><path d="M-3 0H3M0-3V3" stroke="#bd633e" stroke-width="1.2"/></g></g>`;
    })
    .join("");
  return `<style>${canvasStyle}</style><defs>
    <pattern id="dots" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".7" fill="#c3cabd" opacity=".45"/></pattern>
    <marker id="dependency-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="m2 2 6 3-6 3" fill="none" stroke="#a4afa0" stroke-width="1.4"/></marker>
    <marker id="evolution-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="m2 2 6 3-6 3" fill="none" stroke="#bd633e" stroke-width="1.5"/></marker>
    </defs><rect width="1100" height="760" fill="#fdfcf9"/>${stageGuides}
    <rect x="90" y="40" width="920" height="610" fill="url(#dots)"/>
    <path d="M90 30V650H1023" fill="none" stroke="#8c9989" stroke-width="1.25"/>
    <path d="m86 37 4-7 4 7M1016 646l7 4-7 4" fill="none" stroke="#8c9989" stroke-width="1.25"/>
    <text class="axis-label" x="76" y="48" text-anchor="end">VISIBLE</text><text class="axis-label" x="76" y="643" text-anchor="end">HIDDEN</text>
    <text class="axis-title" transform="translate(26,345) rotate(-90)" text-anchor="middle">VALUE CHAIN</text>
    <text class="axis-label" x="90" y="711">UNCHARTED</text><text class="axis-label" x="1010" y="711" text-anchor="end">INDUSTRIALISED</text>
    <text class="axis-title" x="550" y="738" text-anchor="middle">EVOLUTION →</text>
    ${edges}${nodes}<path id="draft-link" fill="none" stroke="#bd633e" stroke-width="1.6" stroke-dasharray="5 5" pointer-events="none"/>
    ${!map.nodes.length ? '<text x="550" y="360" text-anchor="middle" style="font-size:12px;fill:#939990">Drag a component here or double-click to add.</text>' : ""}`;
}
export function exportSvg(map: WardleyMap, model: Metamodel, labels: boolean) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="1040" viewBox="0 -70 1100 830"><rect x="0" y="-70" width="1100" height="830" fill="#fdfcf9"/><text x="90" y="-27" font-family="Arial,sans-serif" font-size="24" font-weight="600" fill="#33413d">${e(map.title)}</text>${graphContent(map, model, null, null, labels)}</svg>`;
}
