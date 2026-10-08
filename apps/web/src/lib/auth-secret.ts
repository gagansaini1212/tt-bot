// The value .env.example ships with, refused in production.
const EXAMPLE_SECRET = "replace-with-at-least-32-random-characters";

/**
 * AUTH_SECRET signs session cookies and the assistant's customer tokens.
 * Locally the repository's .env provides it (see .env.example).
 */
export function authSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.AUTH_SECRET;
  if (!secret)
    throw new Error(
      "Set AUTH_SECRET in .env to sign customers in. See .env.example.",
    );
  if (
    env.NODE_ENV === "production" &&
    (secret === EXAMPLE_SECRET || secret.length < 32)
  )
    throw new Error(
      "AUTH_SECRET must be at least 32 random characters in production, such as the output of openssl rand -base64 32.",
    );
  return secret;
}
