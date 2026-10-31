import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const voiceTranscribe = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:voice:transcribe",
  tag: WS_METHODS.voiceTranscribe,
});
