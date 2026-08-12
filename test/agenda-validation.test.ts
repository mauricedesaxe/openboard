import { describe, expect, test } from "vitest";

import {
  moveAgendaItemSchema,
  placeProgramItemSchema,
  placeServiceBlockSchema,
  updateServiceBlockSchema,
} from "../src/shared/agendas";

const ids = {
  agendaItemId: "00000000-0000-4000-8000-000000000001",
  programItemId: "00000000-0000-4000-8000-000000000002",
  roomId: "00000000-0000-4000-8000-000000000003",
};
const schemas = [
  placeProgramItemSchema,
  placeServiceBlockSchema,
  moveAgendaItemSchema,
  updateServiceBlockSchema,
];

describe("agenda time range validation", () => {
  test.each(schemas)("requires end after start", (schema) => {
    const base = inputFor(schema);
    expect(
      schema.safeParse({
        ...base,
        startsAtLocal: "2028-08-10T09:00",
        endsAtLocal: "2028-08-10T10:00",
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        ...base,
        startsAtLocal: "2028-08-10T09:00",
        endsAtLocal: "2028-08-10T09:00",
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...base,
        startsAtLocal: "2028-08-10T10:00",
        endsAtLocal: "2028-08-10T09:00",
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...base,
        startsAtLocal: "2028-08-10T23:00",
        endsAtLocal: "2028-08-11T01:00",
      }).success,
    ).toBe(true);
  });
});

function inputFor(schema: (typeof schemas)[number]) {
  if (schema === placeProgramItemSchema) {
    return {
      slug: "agenda",
      programItemId: ids.programItemId,
      roomId: ids.roomId,
    };
  }
  if (schema === placeServiceBlockSchema) {
    return {
      slug: "agenda",
      title: "Break",
      scope: { type: "event" as const },
    };
  }
  if (schema === moveAgendaItemSchema) {
    return {
      slug: "agenda",
      agendaItemId: ids.agendaItemId,
      roomId: ids.roomId,
    };
  }
  return {
    slug: "agenda",
    agendaItemId: ids.agendaItemId,
    expectedRevision: 1,
    title: "Break",
    scope: { type: "event" as const },
  };
}
