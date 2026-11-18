import { useQuery } from "@tanstack/react-query";
import { api, call } from "../api.ts";
import { Card, PageHeader } from "../components/ui.tsx";
import styles from "./HomePage.module.css";

export function HomePage() {
  const health = useQuery({ queryKey: ["healthz"], queryFn: () => call(api.healthz.$get()) });

  return (
    <>
      <PageHeader title="Home" lead="Collect wake word clips from your voice satellites." />
      <Card>
        <p className={styles.status} role="status">
          {health.isPending && "Checking the server…"}
          {health.isError && <span className={styles.error}>Server unreachable</span>}
          {health.isSuccess && (
            <span className={styles.ok}>Server running, version {health.data.version}</span>
          )}
        </p>
      </Card>
    </>
  );
}
