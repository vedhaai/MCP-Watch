import type { IocContainer, IocContainerFactory, ServiceIdentifier } from "@tsoa/runtime";
import type { Request } from "express";
import type { Services } from "../services/index.js";

// tsoa builds each controller through this: controllers get the services of the app that received the
// request (set on app.locals by createApp).

export const servicesOf = (req: Request): Services => req.app.locals.services as Services;

export const iocContainer: IocContainerFactory<Request> = (req): IocContainer => ({
  get<T>(controller: ServiceIdentifier<T>): T {
    return new (controller as new (services: Services) => T)(servicesOf(req));
  },
});
