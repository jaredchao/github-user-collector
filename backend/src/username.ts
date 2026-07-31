// GitHub allows alphanumerics and single inner hyphens, up to 39 characters.
// Shared by the API and the worker so a name the API accepted can never be
// rejected later by the consumer.
const USERNAME_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;

export function isValidUsername(value: unknown): value is string {
  return typeof value === "string" && USERNAME_PATTERN.test(value);
}
