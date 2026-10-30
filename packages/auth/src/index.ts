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
