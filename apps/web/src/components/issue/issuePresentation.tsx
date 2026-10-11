import { CircleCheckIcon, CircleDotIcon } from "lucide-react";
import type { IssueState } from "@t3tools/contracts";

export function IssueGlyph({ state }: { state: IssueState }) {
  const Icon = state === "open" ? CircleDotIcon : CircleCheckIcon;
  return (
    <Icon
      aria-label={state === "open" ? "Open issue" : "Closed issue"}
      className={
        state === "open" ? "size-3.5 shrink-0 text-success" : "size-3.5 shrink-0 text-primary"
      }
    />
  );
}
