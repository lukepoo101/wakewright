import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { errorMessage } from "./api.ts";
import { Layout } from "./components/Layout.tsx";
import { Alert, Button, Loading } from "./components/ui.tsx";
import { AuthScreen, LoginPage, SetupPage } from "./pages/AuthPages.tsx";
import { parseClipSearch } from "./clips.ts";
import { ClipPage } from "./pages/ClipPage.tsx";
import { ClipsPage } from "./pages/ClipsPage.tsx";
import { DevicesPage } from "./pages/DevicesPage.tsx";
import { EditDevicePage, NewDevicePage } from "./pages/DeviceFormPage.tsx";
import { HomePage } from "./pages/HomePage.tsx";
import { JudgesPage } from "./pages/JudgesPage.tsx";
import { WorkersPage } from "./pages/WorkersPage.tsx";
import { CollectionStatus } from "./components/CollectionStatus.tsx";
import { PlayerProvider } from "./player.tsx";
import { useSession } from "./session.ts";

// Code-based route tree. Each screen is a page in pages/ with its route
// declared here. Every route sits behind the session gate in the root:
// first-run setup, then sign-in, then the app. With sign-in off on the
// server (state "open") the gate goes straight to the app, after the same
// loading screen, so a sign-in screen never flashes.

function SessionGate() {
  const session = useSession();
  if (session.isPending) return <Loading label="Starting Wakewright…" />;
  if (session.isError) {
    return (
      <AuthScreen>
        <Alert tone="error" title="Cannot reach the Wakewright server">
          {errorMessage(session.error)}
          <div>
            <Button size="small" onClick={() => void session.refetch()}>
              Try again
            </Button>
          </div>
        </Alert>
      </AuthScreen>
    );
  }
  if (session.data.state === "setup") return <SetupPage />;
  if (session.data.state === "signed_out") return <LoginPage managed={session.data.managed} />;
  return (
    <PlayerProvider>
      <Layout status={<CollectionStatus />} signOut={session.data.state === "signed_in"}>
        <Outlet />
      </Layout>
    </PlayerProvider>
  );
}

const rootRoute = createRootRoute({ component: SessionGate });

const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: HomePage });

const devicesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/devices",
  component: DevicesPage,
});

const newDeviceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/devices/new",
  component: NewDevicePage,
});

const editDeviceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/devices/$deviceId/edit",
  component: function EditDeviceRoute() {
    const { deviceId } = editDeviceRoute.useParams();
    return <EditDevicePage deviceId={deviceId} />;
  },
});

const workersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workers",
  component: WorkersPage,
});

const judgesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/judges",
  component: JudgesPage,
});

const clipsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/clips",
  validateSearch: parseClipSearch,
  component: function ClipsRoute() {
    return <ClipsPage search={clipsRoute.useSearch()} />;
  },
});

const clipRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/clips/$clipId",
  validateSearch: parseClipSearch,
  component: function ClipRoute() {
    const { clipId } = clipRoute.useParams();
    return <ClipPage clipId={clipId} search={clipRoute.useSearch()} />;
  },
});

const routeTree = rootRoute.addChildren([
  homeRoute,
  clipsRoute,
  clipRoute,
  devicesRoute,
  newDeviceRoute,
  editDeviceRoute,
  judgesRoute,
  workersRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
