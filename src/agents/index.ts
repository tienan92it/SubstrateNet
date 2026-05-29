/**
 * Side-effect imports to ensure every agent registers itself with the registry.
 * Anything that wants `ALL_AGENTS` populated should import this module first.
 */
import './triage.js';
import './decision.js';
import './business-logic.js';
import './intent.js';
import './problem-solution.js';
import './clusterer.js';
import './summarizer.js';
import './linker.js';
import './verifier.js';
import './domain-modeler.js';
// Dedupe is not a chat agent and self-registers when constructed.

export { ALL_AGENTS, getAgent, registerAgent } from './registry.js';
