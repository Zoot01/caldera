import { messages as all } from '../catalog.js'

// Only what the worker needs, as codegen would embed it (the catalog helper reads files at build time).
export const messages = { en: all.en!, fr: all.fr! }
