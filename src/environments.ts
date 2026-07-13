/**
 * Base URLs for the IBEE Solutions public API.
 *
 * DEFAULT targets production; DEVELOPMENT targets the development gateway.
 * Mirrors the Python SDK's IbeeEnvironment.
 */
export const IbeeEnvironment = {
  /** Production gateway. */
  DEFAULT: "https://api.ibee.ai/v1",
  /** Development gateway. */
  DEVELOPMENT: "https://api.ibee.co.in/v1",
} as const;

export type IbeeEnvironmentUrl =
  (typeof IbeeEnvironment)[keyof typeof IbeeEnvironment];
