import type { FastifyInstance } from 'fastify';
import { collection, resource } from '../../http/envelope.js';
import { protectedBy } from '../../http/authorize.js';
import * as service from './service.js';
import {
  LocationIdParams,
  LocationListQuery,
  type CreateLocationInput,
  type LocationIdParamsType,
  type LocationListQueryType,
  type UpdateLocationInput,
} from './schemas.js';

const ref = (id: string) => ({ $ref: `${id}#` });
const TAG = 'Locations';

function errorResponses(extra: Record<number, string> = {}): Record<number, unknown> {
  const base: Record<number, string> = {
    400: 'The request is malformed (`VALIDATION_ERROR`, `MALFORMED_ID`, or `INVALID_JSON`).',
    401: 'Missing, malformed, invalid, or expired bearer token.',
    403: 'Authenticated, but your role lacks the required permission (`INSUFFICIENT_PERMISSION`).',
    ...extra,
    500: 'An unexpected server error.',
    503: 'The database is unreachable. Safe to retry.',
  };
  return Object.fromEntries(
    Object.entries(base).map(([s, description]) => [s, { ...ref('Error'), description }]),
  );
}

const security = [{ bearerAuth: [] }];

export async function registerLocationRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: LocationListQueryType }>(
    '/locations',
    {
      onRequest: protectedBy(app, 'locations:read'),
      schema: {
        operationId: 'listLocations',
        summary: 'List inventory locations',
        description: [
          'Paginated, filterable list of the places inventory is held.',
          '',
          'With no `is_active` filter, both active and retired locations are returned — the same',
          'no-hidden-filter rule as the catalog. The result set is fully determined by the query',
          'string.',
          '',
          'Requires the `locations:read` permission, which every role has.',
        ].join('\n'),
        tags: [TAG],
        security,
        querystring: LocationListQuery,
        response: {
          200: { ...ref('LocationListResponse'), description: 'A page of locations.' },
          ...errorResponses(),
        },
      },
    },
    async (request) => {
      const r = await service.listLocations(app.db, request.query);
      return collection(r.locations, { page: r.page, limit: r.limit, total: r.total });
    },
  );

  app.post<{ Body: CreateLocationInput }>(
    '/locations',
    {
      onRequest: protectedBy(app, 'locations:write'),
      schema: {
        operationId: 'createLocation',
        summary: 'Create an inventory location',
        description: [
          'Creates a location. Names are unique case-insensitively; a duplicate returns `409`.',
          '',
          'Requires `locations:write`. The `support` role does not have it — logging in as',
          'support and calling this is the shortest way to see a `403` that names the permission',
          'it wanted.',
        ].join('\n'),
        tags: [TAG],
        security,
        body: ref('LocationCreate'),
        response: {
          201: { ...ref('LocationResponse'), description: 'The location that was created.' },
          ...errorResponses({
            409: 'A location with that name already exists (`LOCATION_NAME_EXISTS`).',
          }),
        },
      },
    },
    async (request, reply) => {
      const location = await service.createLocation(app.db, request.body);
      reply.code(201).header('location', `/api/v1/locations/${location.id}`);
      return resource(location);
    },
  );

  app.get<{ Params: LocationIdParamsType }>(
    '/locations/:locationId',
    {
      onRequest: protectedBy(app, 'locations:read'),
      schema: {
        operationId: 'getLocation',
        summary: 'Retrieve a location',
        description:
          'Returns one location. A syntactically invalid id returns `400 MALFORMED_ID`; a ' +
          'well-formed id naming nothing returns `404`.',
        tags: [TAG],
        security,
        params: LocationIdParams,
        response: {
          200: { ...ref('LocationResponse'), description: 'The requested location.' },
          ...errorResponses({
            404: 'No location exists with that identifier (`LOCATION_NOT_FOUND`).',
          }),
        },
      },
    },
    async (request) => resource(await service.getLocation(app.db, request.params.locationId)),
  );

  app.patch<{ Params: LocationIdParamsType; Body: UpdateLocationInput }>(
    '/locations/:locationId',
    {
      onRequest: protectedBy(app, 'locations:write'),
      schema: {
        operationId: 'updateLocation',
        summary: 'Partially update a location',
        description: [
          'Updates only the properties present in the body. Omitted properties are unchanged; an',
          'explicit `null` clears a nullable one.',
          '',
          '**There is no DELETE.** A location is referenced by inventory levels and by the',
          'adjustment audit log, so removing one would orphan history that has to stay',
          'answerable. Retire a location with `{"is_active": false}` instead — which is what',
          '"delete this warehouse" actually means in a business that has shipped from it.',
        ].join('\n'),
        tags: [TAG],
        security,
        params: LocationIdParams,
        body: ref('LocationUpdate'),
        response: {
          200: { ...ref('LocationResponse'), description: 'The location after the update.' },
          ...errorResponses({
            404: 'No location exists with that identifier (`LOCATION_NOT_FOUND`).',
            409: 'Another location already uses that name (`LOCATION_NAME_EXISTS`).',
          }),
        },
      },
    },
    async (request) =>
      resource(await service.patchLocation(app.db, request.params.locationId, request.body)),
  );
}
