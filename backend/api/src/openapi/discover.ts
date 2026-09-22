import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { MemberRole } from '@portal/schemas';
import { IS_PUBLIC, NO_WORKSPACE, REQUIRED_ROLES, REQUIRE_EMAIL_VERIFIED } from '../modules/auth/auth.decorators';

/** What a controller says about a route through its decorators. */
export interface DiscoveredRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** `/agents/:id/draft` — normalised: one leading slash, no trailing slash. */
  path: string;
  controller: string;
  handler: string;
  isPublic: boolean;
  noWorkspace: boolean;
  requireEmailVerified: boolean;
  roles: MemberRole[] | null;
  /** From `@HttpCode`, else Nest's default: 201 for POST, 200 otherwise. */
  status: number;
}

const METHODS: Partial<Record<RequestMethod, DiscoveredRoute['method']>> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.DELETE]: 'DELETE',
};

/**
 * Reads the routes off controller classes the way Nest's router does — from the metadata
 * `@Controller`, `@Get` and friends leave behind — without booting a DI container. The
 * auth decorators are ours (`auth.decorators.ts`), read with the same keys the guards use,
 * so what the document says about authentication is what the guards enforce.
 */
export function discoverRoutes(controllers: readonly (new (...args: never[]) => unknown)[]): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];
  for (const controller of controllers) {
    const prefixes = asArray(Reflect.getMetadata(PATH_METADATA, controller) as string | string[] | undefined);
    const classPublic = Reflect.getMetadata(IS_PUBLIC, controller) === true;
    const classNoWorkspace = Reflect.getMetadata(NO_WORKSPACE, controller) === true;
    const proto = controller.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor') continue;
      const handler = proto[name];
      if (typeof handler !== 'function') continue;
      const methodCode = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      if (methodCode === undefined) continue;
      const method = METHODS[methodCode];
      if (!method) throw new Error(`${controller.name}.${name}: unsupported HTTP method ${methodCode}`);
      const subPaths = asArray(Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined);
      const httpCode = Reflect.getMetadata(HTTP_CODE_METADATA, handler) as number | undefined;
      const roles = Reflect.getMetadata(REQUIRED_ROLES, handler) as MemberRole[] | undefined;
      for (const prefix of prefixes) {
        for (const sub of subPaths) {
          routes.push({
            method,
            path: join(prefix, sub),
            controller: controller.name,
            handler: name,
            isPublic: classPublic || Reflect.getMetadata(IS_PUBLIC, handler) === true,
            noWorkspace: classNoWorkspace || Reflect.getMetadata(NO_WORKSPACE, handler) === true,
            requireEmailVerified: Reflect.getMetadata(REQUIRE_EMAIL_VERIFIED, handler) === true,
            roles: roles ?? null,
            status: httpCode ?? (method === 'POST' ? 201 : 200),
          });
        }
      }
    }
  }
  return routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

function asArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return ['/'];
  return Array.isArray(value) ? value : [value];
}

function join(prefix: string, sub: string): string {
  const parts = [...prefix.split('/'), ...sub.split('/')].filter((p) => p.length > 0);
  return `/${parts.join('/')}`;
}
