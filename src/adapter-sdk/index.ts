export * from "./protocol.js";

export { parseSourceAdapterId } from "../core/source-identity.js";
export type { SourceAdapterId } from "../core/source-identity.js";

export {
  supportsCapability,
  validateCapabilityDescriptor,
} from "../protocol/capability-descriptor.js";
export type {
  CapabilityDescriptorV1,
  CapabilitySupportQuery,
} from "../protocol/capability-descriptor.js";
