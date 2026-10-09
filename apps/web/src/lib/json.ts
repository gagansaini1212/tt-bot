/** A JSON value, as client context and other serialized data carry it. */
export type JsonValue =
  string | number | boolean | null | JsonObject | JsonValue[];

export type JsonObject = {
  [key: string]: JsonValue;
};
