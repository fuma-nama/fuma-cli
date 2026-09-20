import { isActive } from "./lib/utils";

export function NavLink({ href }: { href: string }) {
  return <a href={href} data-active={isActive(href, "/")} />;
}
