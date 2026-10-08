import "server-only";
import { createHash } from "node:crypto";

/**
 * A stable ID for exactly this content, shaped as a UUID, so an AI decision
 * can name the account snapshot it was based on. The same content always
 * gets the same ID, and any change gets another.
 */
export function contentId(content: unknown): string {
  const hex = createHash("sha256")
    .update(JSON.stringify(content))
    .digest("hex");
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  // An RFC 9562 version 8 UUID, whose bits the application defines.
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
