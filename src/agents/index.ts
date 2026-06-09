/**
 * Side-effect imports to ensure every agent registers itself with the registry.
 * Anything that wants `ALL_AGENTS` populated should import this module first.
 */
import './triage.js';
import './triage-batch.js';
import './source-classifier.js';
import './source-classifier-batch.js';
import './decision.js';
import './business-logic.js';
import './requirements.js';
import './intent.js';
import './problem-solution.js';
import './window-extractor.js';
import './incident.js';
import './clusterer.js';
import './clusterer-batch.js';
import './summarizer.js';
import './linker.js';
import './verifier.js';
import './domain-modeler.js';
import './architecture-modeler.js';
import './business-domain-modeler.js';
import './tech-domain-modeler.js';
import './technical-profiler.js';
import './industry-classifier.js';
import './industry-enricher.js';
import './file-analyzer.js';
import './architecture-analyzer.js';
import './domain-analyzer.js';
import './domain-fuser.js';
import './industry-fuser.js';
import './profile-writer.js';
import './wisdom-synthesizer.js';
// Dedupe is not a chat agent and self-registers when constructed.

export { ALL_AGENTS, getAgent, registerAgent } from './registry.js';
