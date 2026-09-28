// Parser barrel (todo2). Sibling-worker contract:
//   import { parseCproject } from "./parser/index.js"; // or "../parser/index.js"
//   const cfg: ProjectConfig = parseCproject(xmlText);

export { parseCproject } from "./cproject.js";
export { parseIoc, mergeWithIoc } from "./ioc.js";
export { lookupMcu } from "./mcuTable.js";
export { resolveWorkspaceLoc, workspaceProjectOf } from "./workspaceLoc.js";
export type {
  BuildConfiguration,
  IocConfig,
  McuFlags,
  MergeResult,
  ParseOptions,
  ProjectConfig,
} from "./types.js";
