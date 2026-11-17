import { useQuery } from "@tanstack/react-query";
import { api } from "../api.ts";
import styles from "./HomePage.module.css";

export function HomePage() {
  const health = useQuery({
    queryKey: ["healthz"],
    queryFn: async () => {
      const res = await api.healthz.$get();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  return (
    <section>
      <h1>Wakewright</h1>
      <p>Collect wake word clips from your voice satellites.</p>
      <p className={styles.status} role="status">
        {health.isPending && "Checking the server…"}
        {health.isError && <span className={styles.error}>Server unreachable</span>}
        {health.isSuccess && (
          <span className={styles.ok}>Server running, version {health.data.version}</span>
        )}
      </p>
    </section>
  );
}
