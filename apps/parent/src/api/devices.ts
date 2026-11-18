import type { Database } from "bun:sqlite";
import { createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { endPause, openPause, startPause } from "../db/collection.ts";
import {
  type DeviceRow,
  type DeviceWithCounts,
  deviceNameTaken,
  getDevice,
  listDevices,
} from "../db/devices.ts";
import { type Devices, describeError } from "../devices.ts";
import type { Collector } from "../ingest.ts";
import { KioskConfig, kioskSource } from "../kiosk/source.ts";
import type { ReportedState } from "../source.ts";
import { type ApiEnv, errorContent, newApi } from "./common.ts";

// Devices (add, edit, remove, test, status) and the collection pause:
// /api/v1/devices and /api/v1/collection. Device passwords go in and are
// never sent back.

const Reported = z
  .object({
    name: z.string().nullable(),
    appVersion: z.string().nullable(),
    diagnosticsEnabled: z.boolean().nullable(),
    engine: z.string().nullable(),
    wakeWords: z.array(z.string()).nullable(),
    sensitivity: z.string().nullable(),
    fineTune: z.number().nullable(),
    leader: z.boolean().nullable(),
    follows: z.string().nullable(),
  })
  .openapi("ReportedState");

const ProblemBody = z.object({ code: z.string(), message: z.string() }).openapi("Problem");

const Device = z
  .object({
    id: z.string(),
    name: z.string(),
    source: z.string(),
    baseUrl: z.string(),
    createdAt: z.string(),
    status: z.object({
      /** waiting: not polled yet; ok: the last poll worked; failing: it did not. */
      health: z.enum(["waiting", "ok", "failing"]),
      lastPollAt: z.string().nullable(),
      lastSuccessAt: z.string().nullable(),
      error: ProblemBody.nullable(),
      failures: z.number().int(),
      gaps: z.number().int(),
      lastGapAt: z.string().nullable(),
    }),
    reported: Reported.nullable(),
    reportedAt: z.string().nullable(),
    clips: z.number().int(),
    lastClipAt: z.string().nullable(),
  })
  .openapi("Device");

const Name = z.string().trim().min(1, "Give the device a name.").max(64);
const Password = z.string().min(1, "Enter the device's admin password.").max(256);
const BaseUrl = KioskConfig.shape.baseUrl;

const NewDevice = z
  .object({
    name: Name,
    baseUrl: BaseUrl,
    password: Password,
    /** Save even if the device cannot be reached now. A wrong password is never saved. */
    skipTest: z.boolean().optional(),
  })
  .openapi("NewDevice");

const DeviceChange = z
  .object({
    name: Name.optional(),
    baseUrl: BaseUrl.optional(),
    /** Leave out to keep the stored password. */
    password: Password.optional(),
    skipTest: z.boolean().optional(),
  })
  .openapi("DeviceChange");

const TestRequest = z
  .object({
    baseUrl: BaseUrl,
    password: Password.optional(),
    /** With no password: test with this device's stored password. */
    deviceId: z.string().optional(),
  })
  .openapi("TestRequest");

const TestResult = z
  .discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), reported: Reported, clips: z.number().int() }),
    z.object({ ok: z.literal(false), error: ProblemBody }),
  ])
  .openapi("TestResult");

const Collection = z
  .object({
    paused: z.boolean(),
    pausedSince: z.string().nullable(),
    intervalSeconds: z.number(),
  })
  .openapi("Collection");

const IdParam = z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) });

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { "application/json": { schema } },
});
const body = <T extends z.ZodType>(schema: T) => ({
  body: { required: true, content: { "application/json": { schema } } },
});

const routes = {
  list: createRoute({
    method: "get",
    path: "/devices",
    tags: ["devices"],
    summary: "Devices and their collection status",
    responses: { 200: json(z.object({ devices: z.array(Device) }), "Devices") },
  }),
  create: createRoute({
    method: "post",
    path: "/devices",
    tags: ["devices"],
    summary: "Add a device; tests the connection first unless skipTest",
    request: body(NewDevice),
    responses: {
      201: json(Device, "Added"),
      409: errorContent("A device has this name"),
      422: errorContent("The connection test failed; nothing was saved"),
    },
  }),
  update: createRoute({
    method: "patch",
    path: "/devices/{id}",
    tags: ["devices"],
    summary: "Edit a device; a new address or password is tested first unless skipTest",
    request: { params: IdParam, ...body(DeviceChange) },
    responses: {
      200: json(Device, "Saved"),
      404: errorContent("No such device"),
      409: errorContent("A device has this name"),
      422: errorContent("The connection test failed; nothing was saved"),
    },
  }),
  remove: createRoute({
    method: "delete",
    path: "/devices/{id}",
    tags: ["devices"],
    summary: "Stop collecting from a device and forget its password; its clips stay",
    request: { params: IdParam },
    responses: { 204: { description: "Removed" }, 404: errorContent("No such device") },
  }),
  test: createRoute({
    method: "post",
    path: "/devices/test",
    tags: ["devices"],
    summary: "Log in to a device and read its state, without saving anything",
    request: body(TestRequest),
    responses: { 200: json(TestResult, "The outcome"), 404: errorContent("No such device") },
  }),
  poll: createRoute({
    method: "post",
    path: "/devices/{id}/poll",
    tags: ["devices"],
    summary: "Poll a device now",
    request: { params: IdParam },
    responses: { 200: json(Device, "Polled"), 404: errorContent("No such device") },
  }),
  getCollection: createRoute({
    method: "get",
    path: "/collection",
    tags: ["collection"],
    summary: "Whether collection is paused",
    responses: { 200: json(Collection, "Collection state") },
  }),
  setCollection: createRoute({
    method: "put",
    path: "/collection",
    tags: ["collection"],
    summary: "Pause or resume collection. Clips captured while paused are never stored",
    request: body(z.object({ paused: z.boolean() })),
    responses: { 200: json(Collection, "Collection state") },
  }),
};

export interface DeviceRoutesDeps {
  db: Database;
  devices: Devices;
  collector: Collector;
  intervalMs: number;
}

export function deviceRoutes(deps: DeviceRoutesDeps, guard: MiddlewareHandler<ApiEnv>) {
  const { db, devices, collector } = deps;
  const notFound = { error: "not_found", message: "No such device." } as const;
  const nameTaken = (name: string) => ({
    error: "name_taken",
    message: `A device is already called "${name}".`,
  });

  // Tests a connection; returns an error body when it fails and must stop the save.
  async function mustConnect(baseUrl: string, password: string, skipTest: boolean | undefined) {
    try {
      await devices.test(kioskSource.id, { baseUrl }, password);
      return null;
    } catch (error) {
      const problem = describeError(error);
      const offline = problem.code === "unreachable" || problem.code === "timeout";
      if (skipTest && offline) return null;
      return { error: problem.code, message: problem.message };
    }
  }

  const collection = () => {
    const pause = openPause(db);
    return {
      paused: pause !== null,
      pausedSince: pause?.started_at ?? null,
      intervalSeconds: deps.intervalMs / 1000,
    };
  };

  // The guard is attached to this area's own paths: a bare use() would be
  // mounted as /api/v1/* and cover the sign-in routes too.
  const app = newApi();
  for (const path of ["/devices", "/devices/*", "/collection"]) app.use(path, guard);
  return app
    .openapi(routes.list, (c) => c.json({ devices: listDevices(db).map(toDevice) }, 200))
    .openapi(routes.create, async (c) => {
      const input = c.req.valid("json");
      if (deviceNameTaken(db, input.name)) return c.json(nameTaken(input.name), 409);
      const failed = await mustConnect(input.baseUrl, input.password, input.skipTest);
      if (failed) return c.json(failed, 422);
      const id = await devices.create({
        name: input.name,
        source: kioskSource.id,
        config: { baseUrl: input.baseUrl },
        password: input.password,
      });
      collector.wake(id);
      return c.json(toDevice(getDevice(db, id) as DeviceWithCounts), 201);
    })
    .openapi(routes.update, async (c) => {
      const device = getDevice(db, c.req.valid("param").id);
      if (!device) return c.json(notFound, 404);
      const input = c.req.valid("json");
      const name = input.name ?? device.name;
      if (deviceNameTaken(db, name, device.id)) return c.json(nameTaken(name), 409);
      const baseUrl = input.baseUrl ?? baseUrlOf(device);
      if (input.password !== undefined || baseUrl !== baseUrlOf(device)) {
        const password = input.password ?? (await devices.password(device).catch(() => ""));
        const failed = await mustConnect(baseUrl, password, input.skipTest);
        if (failed) return c.json(failed, 422);
      }
      await devices.update(device, { name, config: { baseUrl }, password: input.password });
      collector.wake(device.id);
      return c.json(toDevice(getDevice(db, device.id) as DeviceWithCounts), 200);
    })
    .openapi(routes.remove, (c) => {
      const device = getDevice(db, c.req.valid("param").id);
      if (!device) return c.json(notFound, 404);
      devices.remove(device);
      return c.body(null, 204);
    })
    .openapi(routes.test, async (c) => {
      const input = c.req.valid("json");
      let password = input.password;
      if (password === undefined) {
        const device = input.deviceId ? getDevice(db, input.deviceId) : null;
        if (!device) return c.json(notFound, 404);
        try {
          password = await devices.password(device);
        } catch (error) {
          return c.json({ ok: false as const, error: describeError(error) }, 200);
        }
      }
      try {
        const report = await devices.test(kioskSource.id, { baseUrl: input.baseUrl }, password);
        return c.json({ ok: true as const, reported: report.state, clips: report.clips }, 200);
      } catch (error) {
        return c.json({ ok: false as const, error: describeError(error) }, 200);
      }
    })
    .openapi(routes.poll, async (c) => {
      const id = c.req.valid("param").id;
      if (!getDevice(db, id)) return c.json(notFound, 404);
      await collector.pollDevice(id);
      return c.json(toDevice(getDevice(db, id) as DeviceWithCounts), 200);
    })
    .openapi(routes.getCollection, (c) => c.json(collection(), 200))
    .openapi(routes.setCollection, (c) => {
      const at = new Date().toISOString();
      if (c.req.valid("json").paused) {
        startPause(db, { id: Bun.randomUUIDv7(), at, userId: c.var.user.id });
      } else if (openPause(db)) {
        endPause(db, at);
        collector.wake();
      }
      return c.json(collection(), 200);
    });
}

function baseUrlOf(device: DeviceRow): string {
  return (JSON.parse(device.config_json) as { baseUrl: string }).baseUrl;
}

function toDevice(d: DeviceWithCounts): z.infer<typeof Device> {
  return {
    id: d.id,
    name: d.name,
    source: d.source,
    baseUrl: baseUrlOf(d),
    createdAt: d.created_at,
    status: {
      health: d.last_error_code ? "failing" : d.last_success_at ? "ok" : "waiting",
      lastPollAt: d.last_poll_at,
      lastSuccessAt: d.last_success_at,
      error: d.last_error_code ? { code: d.last_error_code, message: d.last_error ?? "" } : null,
      failures: d.failures,
      gaps: d.gaps,
      lastGapAt: d.last_gap_at,
    },
    reported: d.reported_json ? (JSON.parse(d.reported_json) as ReportedState) : null,
    reportedAt: d.reported_at,
    clips: d.clips,
    lastClipAt: d.last_clip_at,
  };
}
