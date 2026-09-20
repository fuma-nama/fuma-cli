import { cn, label, mergeRefs } from "./lib/utils";

export function Input() {
  return <input className={cn("input")} ref={mergeRefs()} aria-label={label(" input ")} />;
}
