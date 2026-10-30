export type Shape = "circle" | "diamond" | "square" | "hexagon" | "person";
export interface ComponentType {
  id: string;
  label: string;
  description: string;
  color: string;
  shape: Shape;
  stageLabels: string[];
}
export interface MapKind {
  id: string;
  label: string;
  description: string;
  axisType: string;
}
export interface Metamodel {
  schemaVersion: 1;
  name: string;
  componentTypes: ComponentType[];
  mapKinds: MapKind[];
}
export interface MapNode {
  id: string;
  label: string;
  type: string;
  evolution: number;
  visibility: number;
  notes: string;
  targetEvolution?: number;
  inertia?: boolean;
}
export interface MapEdge {
  id: string;
  source: string;
  target: string;
  kind: "dependency" | "evolution";
  label: string;
}
export interface WardleyMap {
  schemaVersion: 1;
  id: string;
  title: string;
  kind: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  nodes: MapNode[];
  edges: MapEdge[];
}
export interface Workspace {
  path: string;
  metamodel: Metamodel;
  maps: WardleyMap[];
  warnings: string[];
}
export interface NativeAPI {
  core: {
    invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  };
}
declare global {
  interface Window {
    __TAURI__?: NativeAPI;
    wardleyApi?: {
      request(
        method: string,
        path: string,
        body?: unknown,
      ): Promise<import("./api.ts").ApiResponse>;
    };
  }
}
