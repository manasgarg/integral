export const RR_VERSION = "0.1.0";
export const PI_PACKAGE = "@earendil-works/pi-coding-agent";
export const PI_VERSION = "0.80.3";
export const DEFAULT_PI_IMAGE = `rr-pi:${RR_VERSION}`;

export const COMPONENTS = ["coordinator", "runner", "gateway"] as const;
export type Component = (typeof COMPONENTS)[number];

export const DEFAULT_PORTS: Readonly<Record<Component, number>> = {
  gateway: 7300,
  coordinator: 7301,
  runner: 7302,
};
