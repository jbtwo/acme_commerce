/**
 * Development identities and inventory locations.
 *
 * The passwords below are FIXTURES, not secrets. They are published in the README on purpose:
 * you cannot practise authentication against credentials you do not have, and pretending a
 * seeded dev password is confidential just means it ends up in a Slack message instead.
 *
 * The important consequence is the one stated everywhere else in this project: do not expose
 * this deployment to an untrusted network.
 */
import type { LocationType, UserRole } from '../schema.js';

export interface SeedUser {
  /** Natural key for the deterministic id. */
  handle: string;
  email: string;
  name: string;
  role: UserRole;
  password: string;
}

export const SEED_PASSWORD = 'dev-password-123';

export const SEED_USERS: SeedUser[] = [
  {
    handle: 'developer',
    email: 'dev@acme.example',
    name: 'Devon Reyes',
    role: 'developer',
    password: SEED_PASSWORD,
  },
  {
    handle: 'support',
    email: 'support@acme.example',
    name: 'Sam Okafor',
    role: 'support',
    password: SEED_PASSWORD,
  },
  {
    handle: 'admin',
    email: 'admin@acme.example',
    name: 'Alex Tremblay',
    role: 'admin',
    password: SEED_PASSWORD,
  },
];

export interface SeedLocation {
  handle: string;
  name: string;
  type: LocationType;
  address_line1: string;
  city: string;
  region: string;
  postal_code: string;
  country: string;
}

export const SEED_LOCATIONS: SeedLocation[] = [
  {
    handle: 'toronto-warehouse',
    name: 'Toronto Warehouse',
    type: 'warehouse',
    address_line1: '482 Commissioners Street',
    city: 'Toronto',
    region: 'ON',
    postal_code: 'M4M 1A7',
    country: 'CA',
  },
  {
    handle: 'vancouver-warehouse',
    name: 'Vancouver Warehouse',
    type: 'warehouse',
    address_line1: '1155 Malkin Avenue',
    city: 'Vancouver',
    region: 'BC',
    postal_code: 'V6A 3P8',
    country: 'CA',
  },
  {
    handle: 'barrie-retail',
    name: 'Barrie Retail Location',
    type: 'retail',
    address_line1: '58 Dunlop Street East',
    city: 'Barrie',
    region: 'ON',
    postal_code: 'L4M 1A3',
    country: 'CA',
  },
];

export const SEED_AUTH_EXPECTED = {
  users: SEED_USERS.length,
  locations: SEED_LOCATIONS.length,
};
