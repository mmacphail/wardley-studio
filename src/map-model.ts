import type { WardleyMap, Metamodel } from "./types.ts";
import { stageIndex } from "./model.ts";
const copy = <T>(value: T): T => structuredClone(value);

export function describeMap(map: WardleyMap, metamodel: Metamodel) {
  const kind = metamodel.mapKinds.find((kind) => kind.id === map.kind)!;
  const axis = metamodel.componentTypes.find(
    (type) => type.id === kind.axisType,
  )!;
  return {
    map: copy(map),
    kind: copy(kind),
    axes: {
      evolution: { min: 0, max: 1, stages: copy(axis.stageLabels) },
      visibility: { min: 0, max: 1 },
    },
    components: map.nodes.map((node) => {
      const type = metamodel.componentTypes.find(
        (type) => type.id === node.type,
      )!;
      const index = stageIndex(node.evolution);
      return {
        ...copy(node),
        typeDefinition: copy(type),
        stage: { index, label: type.stageLabels[index] },
        incomingLinkIds: map.edges
          .filter((edge) => edge.target === node.id)
          .map((edge) => edge.id),
        outgoingLinkIds: map.edges
          .filter((edge) => edge.source === node.id)
          .map((edge) => edge.id),
      };
    }),
    links: copy(map.edges),
    metamodel: copy(metamodel),
  };
}
