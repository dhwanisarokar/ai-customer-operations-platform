import { Suspense } from "react";
import { JoinView } from "@/features/portal/components/join-view";

export default function PortalJoinPage() {
  return (
    <Suspense fallback={null}>
      <JoinView />
    </Suspense>
  );
}
