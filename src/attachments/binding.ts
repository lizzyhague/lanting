import path from "node:path";

import type { Group } from "../group/types.ts";
import { UPLOAD_CALLER, type AttachmentBinding } from "./types.ts";

/** Uploads and deliveries share the group binding. */
export function groupAttachmentBinding(group: Pick<Group, "cwd" | "id">): AttachmentBinding {
  return { caller: UPLOAD_CALLER, projectId: path.basename(group.cwd), sessionId: group.id };
}
