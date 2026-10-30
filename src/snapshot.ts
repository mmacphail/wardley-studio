import { graphContent, PLOT, point } from "./canvas.ts";
import type { Metamodel, WardleyMap } from "./types.ts";

/** Render the entire live map, independent of the editor's zoom or drawers. */
export async function captureMap(map: WardleyMap, model: Metamodel) {
  // Freeze content before awaiting image decoding so pixels and metadata agree.
  map = structuredClone(map);
  model = structuredClone(model);
  const width = 1650;
  const height = 1140;
  const scale = 1.5;
  const capturedAt = new Date().toISOString();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 1100 760">${graphContent(map, model, null, null, true)}</svg>`;
  await document.fonts.ready;
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        image.onload = image.onerror = null;
        reject(new Error("Map image rendering timed out."));
      }, 5000);
      image.onload = () => {
        clearTimeout(timer);
        resolve();
      };
      image.onerror = () => {
        clearTimeout(timer);
        reject(new Error("Could not render the map image."));
      };
      image.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Map image capture is unavailable.");
    context.drawImage(image, 0, 0, width, height);
    return {
      mapId: map.id,
      title: map.title,
      updatedAt: map.updatedAt,
      capturedAt,
      mimeType: "image/png" as const,
      width,
      height,
      scope: "full-map" as const,
      labels: true,
      viewBox: { x: 0, y: 0, width: 1100, height: 760 },
      plot: {
        x: PLOT.x * scale,
        y: PLOT.y * scale,
        width: PLOT.w * scale,
        height: PLOT.h * scale,
      },
      components: map.nodes.map((node) => {
        const p = point(node.evolution, node.visibility);
        return {
          id: node.id,
          label: node.label,
          x: p.x * scale,
          y: p.y * scale,
        };
      }),
      dataUrl: canvas.toDataURL("image/png"),
    };
  } finally {
    image.onload = image.onerror = null;
    URL.revokeObjectURL(url);
  }
}
