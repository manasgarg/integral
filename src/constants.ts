export const INTEGRAL_VERSION = "0.1.0";
export const PI_PACKAGE = "@earendil-works/pi-coding-agent";
export const DEFAULT_PI_IMAGE = `integral-pi:${INTEGRAL_VERSION}`;

export const COMPONENTS = ["coordinator", "runner", "gateway"] as const;
export type Component = (typeof COMPONENTS)[number];

export const DEFAULT_PORTS: Readonly<Record<Component, number>> = {
  gateway: 7310,
  coordinator: 7311,
  runner: 7312,
};
