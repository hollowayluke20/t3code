import type { VoiceInputPhase } from "@t3tools/client-runtime/voice-input";
import { MicIcon, SquareIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

export type MicButtonProps = {
  readonly phase: VoiceInputPhase;
  readonly error: string | null;
  readonly elapsedSeconds: number;
  readonly onToggle: () => void;
  readonly disabled?: boolean;
};

function formatElapsed(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function labelForPhase(phase: VoiceInputPhase): string {
  switch (phase) {
    case "recording":
      return "Stop recording";
    case "preparing":
      return "Cancel dictation";
    case "transcribing":
      return "Cancel transcription";
    case "idle":
    case "error":
      return "Dictate";
  }
}

export function MicButton(props: MicButtonProps) {
  const { phase } = props;
  const recording = phase === "recording";
  const busy = phase === "preparing" || phase === "transcribing";
  const label = labelForPhase(phase);
  const tooltip = props.error ?? `${label} (Ctrl/Cmd+Shift+M)`;

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {props.error ? (
        <span role="alert" className="max-w-40 truncate text-xs text-destructive-foreground">
          {props.error}
        </span>
      ) : null}
      {recording ? (
        <span
          aria-hidden
          className="text-xs text-destructive-foreground tabular-nums"
          data-voice-elapsed
        >
          {formatElapsed(props.elapsedSeconds)}
        </span>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={label}
              aria-pressed={recording}
              disabled={props.disabled}
              onPointerDown={(event) => event.preventDefault()}
              onClick={props.onToggle}
            />
          }
        >
          {busy ? (
            <Spinner size="sm" tone="muted" />
          ) : recording ? (
            <SquareIcon aria-hidden className="size-3 fill-current text-destructive" />
          ) : (
            <MicIcon aria-hidden className={props.error ? "text-destructive" : undefined} />
          )}
        </TooltipTrigger>
        <TooltipPopup side="top">{tooltip}</TooltipPopup>
      </Tooltip>
    </div>
  );
}
