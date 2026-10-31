export { AuthorizationError, createGate } from './gate.js'
export type { CreateGateOptions, Gate, Inspection } from './gate.js'
export { allow, defineAbility, definePolicy, deny, denyAsNotFound, policyFor } from './policy.js'
export type {
  Ability,
  AbilityOf,
  AuthRegister,
  AuthResponse,
  AuthUser,
  Decision,
  GateContext,
  GateExtensions,
  Policy,
  PolicyArgs,
  PolicyOf,
  PolicyRegistry,
  PolicyShape,
} from './policy.js'
export { allows, authorizationProvider } from './provider.js'
export type { AuthorizationOptions } from './provider.js'
export { authenticate, authRoutes, betterAuthProvider, withAuthCookies } from './better-auth.js'
export type { AuthSession, BetterAuthLike, BetterAuthProviderOptions } from './better-auth.js'
export { authTables, authUserColumns } from './schema.js'
export { generateAuthSchema } from './schema-gen.js'
export type { AuthFieldDescriptor, AuthTableDescriptor, GeneratedAuthSchema, GenerateAuthSchemaOptions } from './schema-gen.js'
