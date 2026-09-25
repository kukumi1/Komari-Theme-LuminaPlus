import { useQuery } from "@tanstack/react-query";
import { getAdminEntryPath } from "@/services/api";
import { useAuth } from "@/hooks/useAuth";

export function useAdminEntryPath(): string | null {
  const { data: me } = useAuth();
  const loggedIn = me?.logged_in === true;
  const { data, isPending } = useQuery({
    queryKey: ["admin", "entry-path", me?.uuid],
    queryFn: ({ signal }) => getAdminEntryPath({ signal }),
    enabled: loggedIn,
    retry: false,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
  });

  if (!loggedIn) return "/admin";
  return isPending ? null : data ?? "/admin";
}
