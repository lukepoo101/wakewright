import { createRootRoute, createRoute, createRouter, Outlet } from "@tanstack/react-router";
import { errorMessage } from "./api.ts";
import { Layout } from "./components/Layout.tsx";
import { Alert, Button, Loading } from "./components/ui.tsx";
import { AuthScreen, LoginPage, SetupPage } from "./pages/AuthPages.tsx";
import { DevicesPage } from "./pages/DevicesPage.tsx";
import { EditDevicePage, NewDevicePage } from "./pages/DeviceFormPage.tsx";
import { HomePage } from "./pages/HomePage.tsx";
import { CollectionStatus } from "./components/CollectionStatus.tsx";
import { useSession } from "./session.ts";

// Code-based route tree. Each screen is a page in pages/ with its route
// declared here. Every route sits behind the session gate in the root:
// first-run setup, then sign-in, then the app.

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
    <Layout status={<CollectionStatus />}>
      <Outlet />
    </Layout>
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

const routeTree = rootRoute.addChildren([homeRoute, devicesRoute, newDeviceRoute, editDeviceRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
