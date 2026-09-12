import { Box, Text } from "ink";
import { COLOR, ICON } from "../theme";
import { Spinner } from "./Spinner";
import type { CastStatus } from "../../util/players";

interface CastStatusProps {
  deviceName: string;
  title: string;
  status: CastStatus | null;
}

const STATE_LABEL: Record<CastStatus["state"], string> = {
  preparing: "resolving stream",
  transcoding: "preparing HLS",
  playing: "casting",
  failed: "cast failed",
};

function clock(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Right segment of the footer while a cast is live: spinner while working,
// state + device + now-playing position once settled. Hidden below ~90 cols
// so it never crowds the key hints (the `S Stop cast` hint stays).
export function CastStatus({ deviceName, title, status }: CastStatusProps) {
  const state = status?.state ?? "playing";
  const busy = state === "preparing" || state === "transcoding";
  const playing = state === "playing";
  return (
    <Box flexShrink={0} marginLeft={2} gap={1} alignItems="center">
      {busy ? <Spinner /> : (
        <Text color={state === "failed" ? COLOR.bad : COLOR.good}>
          {state === "failed" ? ICON.error : ICON.done}
        </Text>
      )}
      <Text wrap="truncate-end">
        <Text color={state === "failed" ? COLOR.bad : COLOR.accent}>{STATE_LABEL[state]}</Text>
        {status?.detail ? <Text color={COLOR.bad}> {status.detail}</Text> : null}
        {state !== "failed" ? (
          <>
            <Text dimColor> · </Text>
            <Text color={COLOR.bright}>{deviceName}</Text>
            <Text dimColor> · </Text>
            <Text dimColor>{truncate(title, 24)}</Text>
            {playing && status?.positionSec !== undefined ? (
              <>
                <Text dimColor> · </Text>
                <Text color={COLOR.alt}>
                  {clock(status.positionSec)}
                  {status.durationSec ? <Text dimColor>/{clock(status.durationSec)}</Text> : null}
                </Text>
              </>
            ) : null}
          </>
        ) : null}
      </Text>
    </Box>
  );
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
