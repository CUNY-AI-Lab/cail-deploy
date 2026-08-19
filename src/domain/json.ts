import { z } from "zod";

export const jsonValueSchema = z.json();
export type JsonValue = z.output<typeof jsonValueSchema>;
export type JsonObject = { readonly [key: string]: JsonValue };

export function parseJsonValue(value: string): JsonValue {
  return jsonValueSchema.parse(JSON.parse(value));
}
